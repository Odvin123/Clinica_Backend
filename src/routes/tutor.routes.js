const express = require('express');
const db = require('../config/db');
const { verificarAutenticacion, verificarRol } = require('../middlewares/auth');

const router = express.Router();

(async () => {
  try {
    await db.query(`
      ALTER TABLE citas ADD COLUMN IF NOT EXISTS reprogramada BOOLEAN DEFAULT false;
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS hora_inicio VARCHAR(20) DEFAULT '08:00 AM';
    `);
  } catch (e) {

  }
})();

function generarBloquesClinica(fechaStr) {
  if (!fechaStr) return [];
  const partes = String(fechaStr).split('T')[0].split('-');
  if (partes.length !== 3) return [];

  const fechaObj = new Date(
    parseInt(partes[0], 10),
    parseInt(partes[1], 10) - 1,
    parseInt(partes[2], 10)
  );
  const diaSemana = fechaObj.getDay();
  if (diaSemana === 0) return [];

  const inicioMin = 8 * 60;
  const finMin = diaSemana === 6 ? (12 * 60 + 30) : (17 * 60);
  const bloques = [];

  for (let min = inicioMin; min <= finMin; min += 30) {
    const h24 = Math.floor(min / 60);
    const m = min % 60;
    const hora = `${String(h24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const ampm = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const etiqueta = `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
    bloques.push({ hora, etiqueta });
  }

  return bloques;
}

function validarHorarioClinica(fechaStr, horaStr) {
  const partes = String(fechaStr).split('T')[0].split('-');
  if (partes.length !== 3) {
    return { valido: false, error: 'Formato de fecha inválido.' };
  }

  const fechaObj = new Date(
    parseInt(partes[0], 10),
    parseInt(partes[1], 10) - 1,
    parseInt(partes[2], 10)
  );
  const diaSemana = fechaObj.getDay();

  if (diaSemana === 0) {
    return {
      valido: false,
      error: 'La clínica permanece cerrada los domingos. Selecciona un día de lunes a sábado.'
    };
  }

  const match = String(horaStr || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return { valido: false, error: 'Formato de hora inválido.' };
  }

  const minutos = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  const minApertura = 8 * 60;
  const maxSemana = 17 * 60;
  const maxSabado = 12 * 60 + 30;

  if (diaSemana >= 1 && diaSemana <= 5) {
    if (minutos < minApertura || minutos > maxSemana) {
      return {
        valido: false,
        error: 'El horario de atención de lunes a viernes es de 08:00 AM a 05:00 PM (17:00).'
      };
    }
  } else if (diaSemana === 6) {
    if (minutos < minApertura || minutos > maxSabado) {
      return {
        valido: false,
        error: 'El horario de atención los sábados es de 08:00 AM a 12:30 PM.'
      };
    }
  }

  return { valido: true };
}

router.post('/suscribir-push', async (req, res) => {
  const tutorId = req.usuario.id;
  const { endpoint, keys } = req.body;

  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Datos de suscripción incompletos.' });
  }

  try {
    await db.query(`
      INSERT INTO suscripciones_push (tutor_id, endpoint, keys_p256dh, keys_auth)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (endpoint) DO UPDATE 
      SET tutor_id = EXCLUDED.tutor_id, keys_p256dh = EXCLUDED.keys_p256dh, keys_auth = EXCLUDED.keys_auth
    `, [tutorId, endpoint, keys.p256dh, keys.auth]);

    res.status(201).json({ mensaje: 'Suscripción Push guardada exitosamente.' });
  } catch (error) {
    console.error('Error al guardar suscripción push:', error);
    res.status(500).json({ error: 'Error al guardar la suscripción Push.' });
  }
});

// Ruta para obtener la llave pública VAPID (necesaria para el frontend)
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: req.app.locals.vapidPublicKey });
});

router.use(verificarAutenticacion, verificarRol('TUTOR', 'ADMIN'));

router.get('/mis-datos', async (req, res) => {
  const tutorId = req.usuario.id;

  try {
    const tutorQuery = await db.query(
      `SELECT id, nombre, email, telefono, dni, creado_en
       FROM usuarios
       WHERE id = $1`,
      [tutorId]
    );

    if (tutorQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Tutor no encontrado.' });
    }

    const pacientesQuery = await db.query(
      `SELECT id, nombre, fecha_nacimiento, peso_kg, talla_cm, perimetro_cefalico, temperatura, triage, cronicos, antecedentes, creado_en
       FROM pacientes
       WHERE tutor_id = $1
       ORDER BY creado_en ASC`,
      [tutorId]
    );

    res.json({
      tutor: tutorQuery.rows[0],
      pacientes: pacientesQuery.rows
    });
  } catch (error) {
    console.error('Error en GET /api/tutor/mis-datos:', error);
    res.status(500).json({ error: 'Error del servidor al consultar datos del tutor y pacientes.' });
  }
});

router.get('/carnet', async (req, res) => {
  const tutorId = req.usuario.id;

  try {
    const result = await db.query(
      `SELECT
         v.id,
         v.nombre,
         v.dosis,
         v.edad_recomendada,
         v.estado,
         v.aplicada,
         v.fecha_aplicacion,
         v.firmada_por,
         v.doctor_nombre,
         p.id AS paciente_id,
         p.nombre AS paciente_nombre
       FROM vacunas v
       JOIN pacientes p ON v.paciente_id = p.id
       WHERE p.tutor_id = $1
       ORDER BY p.nombre ASC, v.creado_en ASC`,
      [tutorId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/tutor/carnet:', error);
    res.status(500).json({ error: 'Error al consultar el carnet de vacunación.' });
  }
});

router.get('/recetas', async (req, res) => {
  const tutorId = req.usuario.id;

  try {
    const result = await db.query(
      `SELECT
         r.id,
         r.cie10,
         r.medicamento,
         r.dosis,
         r.frecuencia_horas,
         r.intervalo_minutos,
         r.proximo_envio,
         r.dias,
         r.hora_inicio,
         r.notas,
         r.estado,
         r.creado_en,
         p.id AS paciente_id,
         p.nombre AS paciente_nombre,
         COALESCE(u.nombre, 'Dr. Elman Urbina') AS doctor_nombre
       FROM recetas r
       JOIN pacientes p ON r.paciente_id = p.id
       LEFT JOIN usuarios u ON r.doctor_id = u.id
       WHERE p.tutor_id = $1
         AND r.estado IN ('ACTIVA', 'PENDIENTE_RECEPCION')
       ORDER BY r.creado_en DESC`,
      [tutorId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/tutor/recetas:', error);
    res.status(500).json({ error: 'Error al consultar las recetas médicas.' });
  }
});

router.get('/citas', async (req, res) => {
  const tutorId = req.usuario.id;

  try {
    const result = await db.query(
      `SELECT
         c.id,
         c.folio,
         c.fecha,
         c.hora,
         c.motivo,
         c.estado,
         COALESCE(c.reprogramada, false) AS reprogramada,
         p.id AS paciente_id,
         p.nombre AS paciente_nombre
       FROM citas c
       JOIN pacientes p ON c.paciente_id = p.id
       WHERE p.tutor_id = $1
       ORDER BY c.fecha DESC, c.hora DESC`,
      [tutorId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/tutor/citas:', error);
    res.status(500).json({ error: 'Error al consultar las citas.' });
  }
});

router.get('/disponibilidad', async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) {
    return res.status(400).json({ error: 'La fecha es obligatoria (YYYY-MM-DD).' });
  }

  try {
    const bloquesBase = generarBloquesClinica(fecha);
    const ocupadasQuery = await db.query(
      `SELECT id, hora, paciente_id
       FROM citas
       WHERE fecha = $1 AND estado != 'CANCELADA'`,
      [fecha]
    );

    const horasOcupadasSet = new Set(
      ocupadasQuery.rows
        .filter(r => r.hora)
        .map(r => String(r.hora).trim().slice(0, 5))
    );

    const bloques = bloquesBase.map(b => ({
      hora: b.hora,
      etiqueta: b.etiqueta,
      ocupado: horasOcupadasSet.has(b.hora),
      disponible: !horasOcupadasSet.has(b.hora)
    }));

    res.json({
      fecha,
      cerradoDomingo: bloquesBase.length === 0,
      horasOcupadas: Array.from(horasOcupadasSet),
      bloques
    });
  } catch (error) {
    console.error('Error en GET /api/tutor/disponibilidad:', error);
    res.status(500).json({ error: 'Error al consultar disponibilidad de horarios.' });
  }
});

router.post('/citas', async (req, res) => {
  const tutorId = req.usuario.id;
  const { pacienteId, fecha, hora, motivo } = req.body;

  if (!fecha || !hora) {
    return res.status(400).json({ error: 'Debes seleccionar una fecha y una hora disponible.' });
  }

  const hoyStr = new Date().toISOString().split('T')[0];
  if (fecha < hoyStr) {
    return res.status(400).json({ error: 'No es posible solicitar una cita en una fecha pasada.' });
  }

  const horaNormalizada = String(hora).trim().slice(0, 5);
  const validacionHorario = validarHorarioClinica(fecha, horaNormalizada);
  if (!validacionHorario.valido) {
    return res.status(400).json({ error: validacionHorario.error });
  }

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    let pacQuery;
    if (pacienteId) {
      pacQuery = await client.query(
        `SELECT id, nombre FROM pacientes WHERE id = $1 AND tutor_id = $2`,
        [pacienteId, tutorId]
      );
    } else {
      pacQuery = await client.query(
        `SELECT id, nombre FROM pacientes WHERE tutor_id = $1 ORDER BY creado_en ASC LIMIT 1`,
        [tutorId]
      );
    }

    if (pacQuery.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No se encontró un paciente vinculado a tu cuenta de tutor.' });
    }

    const paciente = pacQuery.rows[0];

    const citaConfirmadaQuery = await client.query(
      `SELECT id, folio, fecha, hora, estado, COALESCE(reprogramada, false) AS reprogramada
       FROM citas
       WHERE paciente_id = $1
         AND estado = 'CONFIRMADA'
         AND fecha >= CURRENT_DATE
       ORDER BY fecha ASC, hora ASC
       LIMIT 1`,
      [paciente.id]
    );

    const citaConfirmadaActiva = citaConfirmadaQuery.rows[0] || null;

    if (citaConfirmadaActiva && citaConfirmadaActiva.reprogramada) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Ya reprogramaste tu cita confirmada una vez. No es posible realizar más reprogramaciones desde el portal.'
      });
    }

    const ocupadoQuery = citaConfirmadaActiva
      ? await client.query(
          `SELECT id FROM citas
           WHERE fecha = $1
             AND SUBSTRING(CAST(hora AS TEXT), 1, 5) = $2
             AND estado != 'CANCELADA'
             AND id != $3`,
          [fecha, horaNormalizada, citaConfirmadaActiva.id]
        )
      : await client.query(
          `SELECT id FROM citas
           WHERE fecha = $1
             AND SUBSTRING(CAST(hora AS TEXT), 1, 5) = $2
             AND estado != 'CANCELADA'`,
          [fecha, horaNormalizada]
        );

    if (ocupadoQuery.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'El bloque horario seleccionado ya está ocupado. Por favor selecciona otro horario disponible.'
      });
    }

    const motivoLimpio = motivo && motivo.trim()
      ? motivo.trim()
      : 'Control pediátrico y esquema PAI';

    if (citaConfirmadaActiva) {
      const updated = await client.query(
        `UPDATE citas
         SET fecha = $1,
             hora = $2,
             motivo = $3,
             reprogramada = true
         WHERE id = $4
         RETURNING *`,
        [fecha, horaNormalizada, motivoLimpio, citaConfirmadaActiva.id]
      );

      await client.query(
        `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
        [
          req.usuario.nombre || 'Tutor Familiar',
          'TUTOR',
          `Reprogramó por única vez la cita ${citaConfirmadaActiva.folio || citaConfirmadaActiva.id} de ${paciente.nombre} para el ${fecha} a las ${horaNormalizada}.`
        ]
      );

      await client.query('COMMIT');
      return res.json({
        mensaje: 'Cita reprogramada exitosamente (1/1 reprogramación permitida utilizada).',
        reprogramada: true,
        cita: updated.rows[0]
      });
    }

    const folio = 'TUT-' + Math.floor(100000 + Math.random() * 900000);
    const nuevaCita = await client.query(
      `INSERT INTO citas (folio, fecha, hora, motivo, estado, reprogramada, paciente_id)
       VALUES ($1, $2, $3, $4, 'PENDIENTE_VALIDACION', false, $5)
       RETURNING *`,
      [folio, fecha, horaNormalizada, motivoLimpio, paciente.id]
    );

    await client.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre || 'Tutor Familiar',
        'TUTOR',
        `Solicitó cita ${folio} para su hijo(a) ${paciente.nombre} el ${fecha} a las ${horaNormalizada}.`
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({
      mensaje: 'Solicitud de cita registrada exitosamente.',
      reprogramada: false,
      cita: nuevaCita.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en POST /api/tutor/citas:', error);
    res.status(500).json({ error: 'Error al procesar la solicitud de cita.' });
  } finally {
    client.release();
  }
});

router.put('/citas/:id/reprogramar', async (req, res) => {
  const tutorId = req.usuario.id;
  const { id } = req.params;
  const { fecha, hora, motivo } = req.body;

  if (!fecha || !hora) {
    return res.status(400).json({ error: 'Debes indicar la nueva fecha y hora disponible.' });
  }

  const hoyStrReprog = new Date().toISOString().split('T')[0];
  if (fecha < hoyStrReprog) {
    return res.status(400).json({ error: 'No es posible reprogramar una cita para una fecha en el pasado.' });
  }

  const horaNormalizada = String(hora).trim().slice(0, 5);
  const validacionHorario = validarHorarioClinica(fecha, horaNormalizada);
  if (!validacionHorario.valido) {
    return res.status(400).json({ error: validacionHorario.error });
  }

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const citaQuery = await client.query(
      `SELECT c.id, c.folio, c.fecha, c.hora, c.estado, COALESCE(c.reprogramada, false) AS reprogramada,
              p.id AS paciente_id, p.nombre AS paciente_nombre
       FROM citas c
       JOIN pacientes p ON c.paciente_id = p.id
       WHERE c.id = $1 AND p.tutor_id = $2`,
      [id, tutorId]
    );

    if (citaQuery.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cita no encontrada o no pertenece a tu cuenta.' });
    }

    const citaActual = citaQuery.rows[0];

    if (citaActual.estado !== 'CONFIRMADA') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Solo se pueden reprogramar citas con estado CONFIRMADA.' });
    }

    if (citaActual.reprogramada) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'El tutor solo puede reprogramar la cita una vez. Esta cita ya fue reprogramada anteriormente.'
      });
    }

    const ocupadoQuery = await client.query(
      `SELECT id FROM citas
       WHERE fecha = $1
         AND SUBSTRING(CAST(hora AS TEXT), 1, 5) = $2
         AND estado != 'CANCELADA'
         AND id != $3`,
      [fecha, horaNormalizada, id]
    );

    if (ocupadoQuery.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'El bloque horario seleccionado ya se encuentra ocupado. Elige otro horario disponible.'
      });
    }

    const motivoFinal = motivo && motivo.trim() ? motivo.trim() : undefined;

    const updated = await client.query(
      `UPDATE citas
       SET fecha = $1,
           hora = $2,
           motivo = COALESCE($3, motivo),
           reprogramada = true
       WHERE id = $4
       RETURNING *`,
      [fecha, horaNormalizada, motivoFinal, id]
    );

    await client.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre || 'Tutor Familiar',
        'TUTOR',
        `Reprogramó cita confirmada ${citaActual.folio || id} (${citaActual.paciente_nombre}) al ${fecha} ${horaNormalizada} (1/1 reprogramación).`
      ]
    );

    await client.query('COMMIT');

    res.json({
      mensaje: 'Cita reprogramada exitosamente. Recuerda que solo se permite una reprogramación por cita.',
      cita: updated.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en PUT /api/tutor/citas/:id/reprogramar:', error);
    res.status(500).json({ error: 'Error al reprogramar la cita.' });
  } finally {
    client.release();
  }
});

router.get('/notificaciones', async (req, res) => {
  const tutorId = req.usuario.id;
  try {
    const result = await db.query(
      `SELECT id, titulo, mensaje, leida, creado_en
       FROM notificaciones_push
       WHERE tutor_id = $1 AND leida = false
       ORDER BY creado_en ASC`,
      [tutorId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar notificaciones push.' });
  }
});

router.put('/notificaciones/leer', async (req, res) => {
  const tutorId = req.usuario.id;
  try {
    await db.query(
      `UPDATE notificaciones_push SET leida = true WHERE tutor_id = $1 AND leida = false`,
      [tutorId]
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar notificaciones.' });
  }
});

module.exports = router;
