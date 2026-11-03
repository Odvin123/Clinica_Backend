const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');

const router = express.Router();

router.get('/horas-ocupadas/:fecha', async (req, res) => {
  const { fecha } = req.params;

  if (!fecha) {
    return res.status(400).json({ error: 'Debes proporcionar una fecha (YYYY-MM-DD).' });
  }

  try {
    const result = await db.query(
      `SELECT hora
       FROM citas
       WHERE fecha = $1 AND estado != 'CANCELADA'`,
      [fecha]
    );

    const horasOcupadas = new Set();

    result.rows.forEach(row => {
      if (!row.hora) return;
      const horaStr = String(row.hora).trim();

      horasOcupadas.add(horaStr);
      const partes = horaStr.split(':');
      if (partes.length >= 2) {
        let h = parseInt(partes[0], 10);
        const m = partes[1];
        const hh24 = String(h).padStart(2, '0') + ':' + m;
        horasOcupadas.add(hh24);

        const ampm = h >= 12 ? 'PM' : 'AM';
        let h12 = h % 12;
        if (h12 === 0) h12 = 12;
        const hh12 = String(h12).padStart(2, '0') + ':' + m + ' ' + ampm;
        horasOcupadas.add(hh12);
      }
    });

    res.json(Array.from(horasOcupadas));
  } catch (error) {
    console.error('Error en GET /api/public/horas-ocupadas/:fecha:', error);
    res.status(500).json({ error: 'Error al consultar horas ocupadas.' });
  }
});

router.post('/reservar', async (req, res) => {
  const { nombreNino, nombreTutor, telefono, fecha, hora, motivo, folio } = req.body;

  if (!nombreNino || !nombreTutor || !telefono || !fecha || !hora) {
    return res.status(400).json({ error: 'Todos los campos básicos de la cita son obligatorios.' });
  }

  const soloLetrasRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/;
  if (!soloLetrasRegex.test(nombreNino.trim())) {
    return res.status(400).json({ error: 'El nombre del niño solo puede contener letras y espacios.' });
  }
  if (!soloLetrasRegex.test(nombreTutor.trim())) {
    return res.status(400).json({ error: 'El nombre del tutor solo puede contener letras y espacios.' });
  }
  const telDigitosPuros = telefono.replace(/\D/g, '');
  if (telDigitosPuros.length !== 8) {
    return res.status(400).json({ error: 'El teléfono de contacto debe contener exactamente 8 dígitos numéricos.' });
  }

  const hoyStr = new Date().toISOString().split('T')[0];
  if (fecha < hoyStr) {
    return res.status(400).json({ error: 'No es posible agendar una cita en una fecha pasada. Por favor selecciona hoy o una fecha futura.' });
  }

  const fechaObj = new Date(fecha + 'T00:00:00');
  const diaSemana = fechaObj.getDay();
  if (diaSemana === 0) {
    return res.status(400).json({ error: 'La clínica se encuentra cerrada los domingos. Por favor selecciona de lunes a sábado.' });
  }

  function parseMinutos(hStr) {
    if (!hStr || hStr.includes('Urgencia')) return null;
    const match = hStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!match) return null;
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const ampm = match[3] ? match[3].toUpperCase() : null;
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }

  const minutosCita = parseMinutos(hora);
  if (minutosCita !== null) {
    const min8 = 8 * 60;
    const maxSemana = 17 * 60;
    const maxSabado = 12 * 60 + 30;

    if (diaSemana >= 1 && diaSemana <= 5) {
      if (minutosCita < min8 || minutosCita > maxSemana) {
        return res.status(400).json({ error: 'El horario de atención de lunes a viernes es de 08:00 a 17:00.' });
      }
    } else if (diaSemana === 6) {
      if (minutosCita < min8 || minutosCita > maxSabado) {
        return res.status(400).json({ error: 'El horario de atención los sábados es de 08:00 a 12:30.' });
      }
    }
  }

  const client = await db.pool.connect();

  try {

    const checkFecha = await client.query(`SELECT ($1::date < CURRENT_DATE) AS es_pasada`, [fecha]);
    if (checkFecha.rows[0]?.es_pasada) {
      return res.status(400).json({ error: 'No es posible agendar una cita en una fecha anterior a hoy (CURRENT_DATE).' });
    }

    await client.query('BEGIN');

    const telLimpio = telefono.trim();
    let tutorResult = await client.query(
      'SELECT id, nombre FROM usuarios WHERE telefono = $1 AND rol = $2',
      [telLimpio, 'TUTOR']
    );

    let tutorId;
    let pinActivacion = null;

    if (tutorResult.rows.length > 0) {
      tutorId = tutorResult.rows[0].id;
    } else {

      pinActivacion = Math.floor(1000 + Math.random() * 9000).toString();
      const hashPin = await bcrypt.hash(pinActivacion, 10);
      const telDigitos = telLimpio.replace(/\D/g, '') || Math.floor(Math.random() * 100000);
      const emailTemp = `tutor_${telDigitos}@temp.ni`;

      const nuevoTutor = await client.query(
        `INSERT INTO usuarios (email, password, rol, nombre, telefono, pin_activacion, activo)
         VALUES ($1, $2, 'TUTOR', $3, $4, $5, false)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [emailTemp, hashPin, nombreTutor.trim(), telLimpio, pinActivacion]
      );

      if (nuevoTutor.rows.length > 0) {
        tutorId = nuevoTutor.rows[0].id;
      } else {
        const fallBackTutor = await client.query('SELECT id FROM usuarios WHERE email = $1', [emailTemp]);
        tutorId = fallBackTutor.rows[0].id;
      }
    }

    const fNac = (req.body.fechaNacimiento && typeof req.body.fechaNacimiento === 'string' && req.body.fechaNacimiento.trim())
      ? req.body.fechaNacimiento.trim()
      : '2023-01-01';

    const nuevoPaciente = await client.query(
      `INSERT INTO pacientes (nombre, fecha_nacimiento, tutor_id, triage)
       VALUES ($1, $2, $3, 'VERDE')
       RETURNING id, nombre`,
      [nombreNino.trim(), fNac, tutorId]
    );
    const pacienteId = nuevoPaciente.rows[0].id;

    const folioFinal = folio && folio.trim()
      ? folio.trim()
      : 'CITA-' + Math.floor(100000 + Math.random() * 900000);

    const nuevaCita = await client.query(
      `INSERT INTO citas (folio, fecha, hora, motivo, estado, paciente_id)
       VALUES ($1, $2, $3, $4, 'PENDIENTE_VALIDACION', $5)
       ON CONFLICT (folio) DO NOTHING
       RETURNING id, folio, fecha, hora, estado`,
      [folioFinal, fecha, hora, motivo ? motivo.trim() : 'Consulta pediátrica general', pacienteId]
    );

    await client.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        nombreTutor.trim(),
        'TUTOR',
        `Reserva pública registrada: Cita folio ${folioFinal} para el paciente ${nombreNino.trim()} (PIN generado)`
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      mensaje: 'Cita reservada exitosamente. Tu cita está pendiente de validación en recepción.',
      cita: nuevaCita.rows[0] || { folio: folioFinal },
      folio: folioFinal
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en POST /api/public/reservar:', error);
    res.status(500).json({ error: 'Error al procesar la reserva de la cita.' });
  } finally {
    client.release();
  }
});

module.exports = router;
