const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { verificarAutenticacion, verificarRol } = require('../middlewares/auth');

const router = express.Router();

(async () => {
  try {
    await db.query(`
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS hora_inicio VARCHAR(20) DEFAULT '08:00 AM';
      ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS perimetro_cefalico NUMERIC(5,2);
      ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS temperatura NUMERIC(4,1);
      ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS antecedentes TEXT;
    `);
  } catch (e) {

  }
})();

router.use(verificarAutenticacion, verificarRol('RECEPCION', 'ADMIN'));

const CATALOGO_PAI = [
  { nombre: 'BCG', dosis: 'Única', edad: 'Al nacer' },
  { nombre: 'Hepatitis B', dosis: 'Neonatal', edad: 'Primeras 24 horas' },
  { nombre: 'Pentavalente', dosis: '1ra Dosis', edad: '2 meses' },
  { nombre: 'Polio', dosis: '1ra Dosis', edad: '2 meses' },
  { nombre: 'Rotavirus', dosis: '1ra Dosis', edad: '2 meses' },
  { nombre: 'Neumococo', dosis: '1ra Dosis', edad: '2 meses' },
  { nombre: 'MMR', dosis: '1ra Dosis', edad: '12 meses' },
  { nombre: 'DPT', dosis: '1er Refuerzo', edad: '18 meses' },
  { nombre: 'dT', dosis: 'Refuerzo escolar', edad: '10 años' },
  { nombre: 'VPH', dosis: '1ra Dosis', edad: '10-14 años' },
  { nombre: 'Influenza', dosis: 'Anual', edad: '6 meses a 2 años' },
  { nombre: 'Fiebre Amarilla', dosis: 'Única', edad: '12 meses' },
  { nombre: 'COVID-19', dosis: 'Esquema pediátrico', edad: 'A partir de 6 meses' }
];

async function registrarVacunasCatalog(client, pacienteId, vacunasMarcadas = []) {
  const marcadasSet = new Set(
    (Array.isArray(vacunasMarcadas) ? vacunasMarcadas : []).map(v => String(v).trim().toLowerCase())
  );

  for (const item of CATALOGO_PAI) {
    const estaAplicada = marcadasSet.has(item.nombre.toLowerCase());
    const estado = estaAplicada ? 'APLICADA' : 'PENDIENTE';
    const firmadaPor = estaAplicada ? 'Cartilla Física' : null;
    const aplicadaBool = estaAplicada;
    const fechaApp = estaAplicada ? new Date().toISOString().split('T')[0] : null;

    const existe = await client.query(
      `SELECT id, estado FROM vacunas WHERE paciente_id = $1 AND LOWER(nombre) = LOWER($2)`,
      [pacienteId, item.nombre]
    );

    if (existe.rows.length === 0) {
      await client.query(
        `INSERT INTO vacunas (paciente_id, nombre, dosis, edad_recomendada, estado, aplicada, fecha_aplicacion, firmada_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [pacienteId, item.nombre, item.dosis, item.edad, estado, aplicadaBool, fechaApp, firmadaPor]
      );
    } else if (estaAplicada && existe.rows[0].estado !== 'APLICADA') {
      await client.query(
        `UPDATE vacunas
         SET estado = 'APLICADA', aplicada = true, fecha_aplicacion = $1, firmada_por = $2
         WHERE id = $3`,
        [fechaApp, firmadaPor, existe.rows[0].id]
      );
    }
  }
}

router.get('/citas-pendientes', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        c.id,
        c.folio,
        c.fecha,
        c.hora,
        c.motivo,
        c.estado,
        p.id AS paciente_id,
        p.nombre AS paciente_nombre,
        p.fecha_nacimiento,
        p.triage,
        p.cronicos,
        u.id AS tutor_id,
        u.nombre AS tutor_nombre,
        u.email AS tutor_email,
        u.telefono AS tutor_telefono,
        u.dni AS tutor_dni,
        u.pin_activacion,
        (u.activo = true AND u.pin_activacion IS NULL) AS tutor_activo
      FROM citas c
      JOIN pacientes p ON c.paciente_id = p.id
      JOIN usuarios u ON p.tutor_id = u.id
      WHERE c.estado = 'PENDIENTE_VALIDACION'
      ORDER BY c.fecha ASC, c.hora ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/recepcion/citas-pendientes:', error);
    res.status(500).json({ error: 'Error al consultar las citas pendientes.' });
  }
});

router.get('/agenda', async (req, res) => {
  const { fecha } = req.query;
  const hoyIso = new Date().toISOString().split('T')[0];

  const fechaFiltro = fecha ? (fecha === 'all' ? null : fecha) : hoyIso;

  try {
    let query = `
      SELECT
        c.id,
        c.folio,
        c.fecha,
        c.hora,
        c.motivo,
        c.estado,
        p.id AS paciente_id,
        p.nombre AS paciente_nombre,
        p.fecha_nacimiento,
        p.peso_kg,
        p.talla_cm,
        p.perimetro_cefalico,
        p.temperatura,
        p.antecedentes,
        p.triage,
        p.cronicos,
        u.id AS tutor_id,
        u.nombre AS tutor_nombre,
        u.email AS tutor_email,
        u.telefono AS tutor_telefono,
        u.dni AS tutor_dni,
        u.pin_activacion,
        (u.activo = true AND u.pin_activacion IS NULL) AS tutor_activo
      FROM citas c
      JOIN pacientes p ON c.paciente_id = p.id
      JOIN usuarios u ON p.tutor_id = u.id
      WHERE c.estado != 'CANCELADA'
    `;
    const params = [];

    if (fechaFiltro) {
      params.push(fechaFiltro);
      query += ` AND c.fecha = $1`;
    }

    query += ` ORDER BY c.fecha ASC, c.hora ASC`;

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/recepcion/agenda:', error);
    res.status(500).json({ error: 'Error al consultar la agenda médica.' });
  }
});

router.put('/validar-cita/:id', async (req, res) => {
  const { id } = req.params;
  const {
    dniTutor,
    emailTutor,
    cronicos,
    vacunasAplicadas,
    pesoKg,
    tallaCm,
    perimetroCefalico,
    temperatura,
    antecedentes
  } = req.body;

  if (!dniTutor) {
    return res.status(400).json({ error: 'La cédula o DNI del tutor es obligatoria para la validación.' });
  }

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const citaQuery = await client.query(
      `SELECT c.id, c.folio, c.paciente_id, p.nombre AS paciente_nombre, u.id AS tutor_id, u.nombre AS tutor_nombre, u.email AS tutor_email, u.pin_activacion
       FROM citas c
       JOIN pacientes p ON c.paciente_id = p.id
       JOIN usuarios u ON p.tutor_id = u.id
       WHERE c.id = $1`,
      [id]
    );

    if (citaQuery.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cita no encontrada.' });
    }

    const infoCita = citaQuery.rows[0];

    let emailFinal = infoCita.tutor_email;
    if (emailTutor && emailTutor.trim()) {
      const emailLimpio = emailTutor.trim().toLowerCase();
      const emailOcupado = await client.query(
        'SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1) AND id != $2',
        [emailLimpio, infoCita.tutor_id]
      );
      if (emailOcupado.rows.length === 0) {
        emailFinal = emailLimpio;
      }
    }

    await client.query(
      `UPDATE usuarios
       SET dni = $1,
           email = $2,
           activo = CASE WHEN pin_activacion IS NULL THEN true ELSE false END
       WHERE id = $3`,
      [dniTutor.trim(), emailFinal, infoCita.tutor_id]
    );

    const pesoNum = (pesoKg !== undefined && pesoKg !== '' && pesoKg !== null) ? parseFloat(pesoKg) : null;
    const tallaNum = (tallaCm !== undefined && tallaCm !== '' && tallaCm !== null) ? parseFloat(tallaCm) : null;
    const pcNum = (perimetroCefalico !== undefined && perimetroCefalico !== '' && perimetroCefalico !== null) ? parseFloat(perimetroCefalico) : null;
    const tempNum = (temperatura !== undefined && temperatura !== '' && temperatura !== null) ? parseFloat(temperatura) : null;
    const antText = antecedentes !== undefined ? String(antecedentes).trim() : null;
    const cronText = cronicos !== undefined ? String(cronicos).trim() : null;

    await client.query(
      `UPDATE pacientes
       SET cronicos = COALESCE($1, cronicos),
           peso_kg = COALESCE($2, peso_kg),
           talla_cm = COALESCE($3, talla_cm),
           perimetro_cefalico = COALESCE($4, perimetro_cefalico),
           temperatura = COALESCE($5, temperatura),
           antecedentes = COALESCE($6, antecedentes)
       WHERE id = $7`,
      [cronText, pesoNum, tallaNum, pcNum, tempNum, antText, infoCita.paciente_id]
    );

    if (pesoNum !== null || tallaNum !== null || pcNum !== null || tempNum !== null) {
      await client.query(
        `INSERT INTO historial_medidas (paciente_id, fecha, peso_kg, talla_cm, perimetro_cefalico, temperatura, creado_por)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)`,
        [infoCita.paciente_id, pesoNum, tallaNum, pcNum, tempNum, req.usuario.id]
      );
    }

    await registrarVacunasCatalog(client, infoCita.paciente_id, vacunasAplicadas || []);

    await client.query(
      `UPDATE citas
       SET estado = 'EN_SALA'
       WHERE id = $1`,
      [id]
    );

    await client.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        req.usuario.rol,
        `Validó cita folio ${infoCita.folio || id} para el paciente ${infoCita.paciente_nombre} (En Sala). Tutor ${infoCita.tutor_nombre} verificado (DNI: ${dniTutor.trim()}) y carnet PAI sincronizado.`
      ]
    );

    await client.query('COMMIT');

    res.json({
      mensaje: 'Cita validada (En Sala) y esquema de vacunas PAI registrado exitosamente.',
      citaId: id,
      estado: 'EN_SALA'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en PUT /api/recepcion/validar-cita/:id:', error);
    res.status(500).json({ error: 'Error al validar la cita en recepción.' });
  } finally {
    client.release();
  }
});

router.put('/cita/:id/estado', async (req, res) => {
  const { id } = req.params;
  const { estado } = req.body;
  const estadosValidos = ['PENDIENTE_VALIDACION', 'CONFIRMADA', 'EN_SALA', 'ATENDIDA', 'CANCELADA'];

  if (!estado || !estadosValidos.includes(estado)) {
    return res.status(400).json({ error: 'Estado de cita no válido.' });
  }

  try {
    const result = await db.query(
      `UPDATE citas SET estado = $1 WHERE id = $2 RETURNING *`,
      [estado, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Cita no encontrada.' });
    }
    res.json({ mensaje: 'Estado de cita actualizado.', cita: result.rows[0] });
  } catch (error) {
    console.error('Error en PUT /api/recepcion/cita/:id/estado:', error);
    res.status(500).json({ error: 'Error al actualizar el estado de la cita.' });
  }
});

router.post('/crear-tutor-paciente', async (req, res) => {
  const {
    tutorNombre, tutorDni, tutorTelefono, tutorEmail, pin,
    childNombre, childDob, childWeight, childTalla, childHeadCirc, childTemp,
    childAntecedentes, childTriage, cronicos,
    vacunasAplicadas
  } = req.body;

  if (!tutorNombre || !tutorDni || !tutorTelefono || !childNombre) {
    return res.status(400).json({ error: 'Datos del tutor y nombre del paciente son obligatorios.' });
  }

  const soloLetrasRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s]+$/;
  if (!soloLetrasRegex.test(tutorNombre.trim())) {
    return res.status(400).json({ error: 'El nombre del tutor solo puede contener letras y espacios.' });
  }
  if (!soloLetrasRegex.test(childNombre.trim())) {
    return res.status(400).json({ error: 'El nombre del paciente solo puede contener letras y espacios.' });
  }

  const telDigitos = tutorTelefono.replace(/\D/g, '');
  if (telDigitos.length !== 8) {
    return res.status(400).json({ error: 'El teléfono debe contener exactamente 8 dígitos numéricos.' });
  }

  if (tutorEmail && tutorEmail.trim()) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(tutorEmail.trim())) {
      return res.status(400).json({ error: 'El correo electrónico no tiene un formato válido.' });
    }
  }

  if (childWeight !== undefined && childWeight !== null && childWeight !== '') {
    const pesoNum = parseFloat(childWeight);
    if (isNaN(pesoNum) || pesoNum <= 0 || pesoNum > 150) {
      return res.status(400).json({ error: 'El peso de ingreso debe ser un número válido en kg (ej. 12.5).' });
    }
  }

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const pinFinal = pin && /^\d{4}$/.test(pin.trim())
      ? pin.trim()
      : Math.floor(1000 + Math.random() * 9000).toString();

    const hashPin = await bcrypt.hash(pinFinal, 10);
    const emailFinal = tutorEmail && tutorEmail.trim()
      ? tutorEmail.trim().toLowerCase()
      : `tutor_${telDigitos}@temp.ni`;

    const tutorResult = await client.query(
      `INSERT INTO usuarios (email, password, rol, nombre, telefono, dni, pin_activacion, activo)
       VALUES ($1, $2, 'TUTOR', $3, $4, $5, $6, false)
       ON CONFLICT (email) DO UPDATE
         SET telefono = EXCLUDED.telefono, dni = EXCLUDED.dni
       RETURNING id`,
      [emailFinal, hashPin, tutorNombre.trim(), telDigitos, tutorDni.trim(), pinFinal]
    );

    let tutorId;
    if (tutorResult.rows.length > 0) {
      tutorId = tutorResult.rows[0].id;
    } else {
      const exist = await client.query('SELECT id FROM usuarios WHERE email = $1', [emailFinal]);
      tutorId = exist.rows[0].id;
    }

    const triageEnum = ['ROJO', 'AMARILLO', 'VERDE'].includes((childTriage || '').toUpperCase())
      ? (childTriage || '').toUpperCase()
      : 'VERDE';

    const pesoNum = (childWeight !== undefined && childWeight !== null && childWeight !== '') ? parseFloat(childWeight) : null;
    const tallaNum = (childTalla !== undefined && childTalla !== null && childTalla !== '') ? parseFloat(childTalla) : null;
    const pcNum = (childHeadCirc !== undefined && childHeadCirc !== null && childHeadCirc !== '') ? parseFloat(childHeadCirc) : null;
    const tempNum = (childTemp !== undefined && childTemp !== null && childTemp !== '') ? parseFloat(childTemp) : null;
    const antTxt = childAntecedentes ? String(childAntecedentes).trim() : null;

    const pacResult = await client.query(
      `INSERT INTO pacientes (nombre, fecha_nacimiento, peso_kg, talla_cm, perimetro_cefalico, temperatura, antecedentes, triage, cronicos, tutor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, nombre`,
      [
        childNombre.trim(),
        childDob || '2024-01-01',
        pesoNum,
        tallaNum,
        pcNum,
        tempNum,
        antTxt,
        triageEnum,
        cronicos ? cronicos.trim() : null,
        tutorId
      ]
    );
    const pacienteId = pacResult.rows[0].id;

    if (pesoNum !== null || tallaNum !== null || pcNum !== null || tempNum !== null) {
      await client.query(
        `INSERT INTO historial_medidas (paciente_id, fecha, peso_kg, talla_cm, perimetro_cefalico, temperatura, creado_por)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)`,
        [pacienteId, pesoNum, tallaNum, pcNum, tempNum, req.usuario.id]
      );
    }

    await registrarVacunasCatalog(client, pacienteId, vacunasAplicadas || []);

    await client.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        req.usuario.rol,
        `Alta en recepción de Tutor ${tutorNombre} y Paciente ${childNombre} con PIN ${pinFinal}, signos vitales y cartilla PAI inicializada.`
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      mensaje: 'Tutor, paciente con signos vitales y carnet PAI registrados exitosamente.',
      tutorId,
      pacienteId,
      pin: pinFinal
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en POST /api/recepcion/crear-tutor-paciente:', error);
    res.status(500).json({ error: 'Error al registrar tutor y paciente.' });
  } finally {
    client.release();
  }
});

router.get('/pacientes', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        p.id,
        p.nombre,
        p.fecha_nacimiento,
        p.peso_kg,
        p.talla_cm,
        p.perimetro_cefalico,
        p.temperatura,
        p.antecedentes,
        p.triage,
        p.cronicos,
        u.id AS tutor_id,
        u.nombre AS tutor_nombre,
        u.telefono AS tutor_telefono,
        u.dni AS tutor_dni,
        u.email AS tutor_email
      FROM pacientes p
      JOIN usuarios u ON p.tutor_id = u.id
      ORDER BY p.nombre ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/recepcion/pacientes:', error);
    res.status(500).json({ error: 'Error al consultar la lista de pacientes.' });
  }
});

router.get('/paciente/:id/vacunas', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT * FROM vacunas WHERE paciente_id = $1 ORDER BY creado_en ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/recepcion/paciente/:id/vacunas:', error);
    res.status(500).json({ error: 'Error al consultar vacunas del paciente.' });
  }
});

router.get('/familias', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        u.id AS tutor_id,
        u.nombre AS tutor_nombre,
        u.email AS tutor_email,
        u.telefono AS tutor_telefono,
        u.dni AS tutor_dni,
        u.pin_activacion,
        (u.activo = true AND u.pin_activacion IS NULL) AS tutor_activo,
        u.creado_en AS tutor_creado,
        COALESCE(
          json_agg(
            json_build_object(
              'id', p.id,
              'nombre', p.nombre,
              'fecha_nacimiento', p.fecha_nacimiento,
              'peso_kg', p.peso_kg,
              'talla_cm', p.talla_cm,
              'perimetro_cefalico', p.perimetro_cefalico,
              'temperatura', p.temperatura,
              'antecedentes', p.antecedentes,
              'triage', p.triage,
              'cronicos', p.cronicos
            )
          ) FILTER (WHERE p.id IS NOT NULL), '[]'
        ) AS hijos
      FROM usuarios u
      LEFT JOIN pacientes p ON p.tutor_id = u.id
      WHERE u.rol = 'TUTOR'
      GROUP BY u.id
      ORDER BY u.nombre ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/recepcion/familias:', error);
    res.status(500).json({ error: 'Error al consultar el padrón de familias.' });
  }
});

router.get('/recetas', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
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
        u.id AS tutor_id,
        u.nombre AS tutor_nombre,
        u.telefono AS tutor_telefono,
        doc.nombre AS doctor_nombre
      FROM recetas r
      JOIN pacientes p ON r.paciente_id = p.id
      JOIN usuarios u ON p.tutor_id = u.id
      LEFT JOIN usuarios doc ON r.doctor_id = doc.id
      ORDER BY r.creado_en DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/recepcion/recetas:', error);
    res.status(500).json({ error: 'Error al consultar las recetas en la bandeja de alertas.' });
  }
});

router.put('/recetas/:id/programar', async (req, res) => {
  const { id } = req.params;
  const { horaInicio, frecuenciaHoras, intervaloMinutos, dias } = req.body;

  const frecInt = frecuenciaHoras !== undefined && frecuenciaHoras !== null ? parseInt(frecuenciaHoras, 10) : NaN;
  const diasInt = dias !== undefined && dias !== null ? parseInt(dias, 10) : NaN;
  const minInt = intervaloMinutos !== undefined && intervaloMinutos !== null ? parseInt(intervaloMinutos, 10) : NaN;

  const minCalc = !isNaN(minInt) && minInt > 0
    ? minInt
    : (!isNaN(frecInt) && frecInt > 0 ? frecInt * 60 : 480);
  const horasCalc = !isNaN(frecInt) && frecInt > 0
    ? frecInt
    : Math.max(1, Math.round(minCalc / 60));
  const diasCalc = !isNaN(diasInt) && diasInt > 0 ? diasInt : null;
  const proximoEnvio = new Date(Date.now() + minCalc * 60 * 1000);

  try {
    const result = await db.query(
      `UPDATE recetas
       SET estado = 'ACTIVA',
           hora_inicio = COALESCE($1, hora_inicio, '08:00'),
           frecuencia_horas = $2,
           intervalo_minutos = $3,
           proximo_envio = $4,
           dias = COALESCE($5, dias)
       WHERE id = $6
       RETURNING *`,
      [
        horaInicio || '08:00',
        horasCalc,
        minCalc,
        proximoEnvio,
        diasCalc,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Receta no encontrada.' });
    }

    const rec = result.rows[0];

    await db.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        req.usuario.rol,
        `Programó y activó notificaciones Push para receta ${rec.medicamento} (Intervalo: cada ${minCalc} min, inicio ${rec.hora_inicio}, próximo envío: ${rec.proximo_envio ? new Date(rec.proximo_envio).toLocaleString('es-NI') : ''})`
      ]
    );

    res.json({
      mensaje: 'Receta programada y activada exitosamente.',
      receta: rec
    });
  } catch (error) {
    console.error('Error en PUT /api/recepcion/recetas/:id/programar:', error);
    res.status(500).json({ error: 'Error al programar la receta.' });
  }
});

router.post('/probar-push', async (req, res) => {
  const { recetaId, tutorId, medicamento, dosis } = req.body;

  try {
    let info = null;
    if (recetaId) {
      const rQuery = await db.query(
        `SELECT r.id, r.medicamento, r.dosis, p.id AS paciente_id, p.nombre AS paciente_nombre,
                u.id AS tutor_id, u.nombre AS tutor_nombre, u.telefono AS tutor_telefono
         FROM recetas r
         JOIN pacientes p ON r.paciente_id = p.id
         JOIN usuarios u ON p.tutor_id = u.id
         WHERE r.id = $1`,
        [recetaId]
      );
      if (rQuery.rows.length > 0) info = rQuery.rows[0];
    }

    if (!info && tutorId) {
      const tQuery = await db.query(
        `SELECT u.id AS tutor_id, u.nombre AS tutor_nombre, u.telefono AS tutor_telefono,
                p.id AS paciente_id, p.nombre AS paciente_nombre
         FROM usuarios u
         LEFT JOIN pacientes p ON p.tutor_id = u.id
         WHERE u.id = $1
         LIMIT 1`,
        [tutorId]
      );
      if (tQuery.rows.length > 0) info = tQuery.rows[0];
    }

    if (!info) {
      return res.status(404).json({ error: 'No se encontró el tutor o la receta para enviar la prueba Push.' });
    }

    const medNombre = medicamento || info.medicamento || 'Medicamento Pediátrico';
    const medDosis = dosis || info.dosis || 'Dosis indicada';
    const pacNombre = info.paciente_nombre || 'su hijo(a)';
    const titulo = `🔔 [Prueba Push] Hora de toma: ${medNombre}`;
    const mensaje = `Hola ${info.tutor_nombre}, recordatorio inmediato: Administrar ${medDosis} de ${medNombre} a ${pacNombre}.`;

    const enviarFn = req.app.locals.enviarNotificacionPushTutor;
    let notifGuardada = null;
    if (typeof enviarFn === 'function') {
      notifGuardada = await enviarFn({
        tutorId: info.tutor_id,
        tutorNombre: info.tutor_nombre,
        pacienteId: info.paciente_id,
        pacienteNombre: info.paciente_nombre,
        recetaId: info.id || null,
        titulo,
        mensaje
      });
    }

    await db.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        req.usuario.rol,
        `Envió Prueba Push inmediata a ${info.tutor_nombre} (${pacNombre}): ${medNombre} - ${medDosis}`
      ]
    );

    res.json({
      ok: true,
      mensaje: `Notificación Push enviada inmediatamente a ${info.tutor_nombre}.`,
      tutor: info.tutor_nombre,
      paciente: pacNombre,
      titulo,
      cuerpo: mensaje,
      notificacion: notifGuardada
    });
  } catch (error) {
    console.error('Error en POST /api/recepcion/probar-push:', error);
    res.status(500).json({ error: 'Error al enviar la notificación Push de prueba.' });
  }
});

router.post('/agendar-cita', async (req, res) => {
  const { pacienteId, fecha, hora, motivo, triage } = req.body;

  if (!pacienteId || !fecha || !hora) {
    return res.status(400).json({ error: 'Paciente, fecha y horario son obligatorios.' });
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
    if (!hStr) return null;
    const match = hStr.match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
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

  try {
    const ocupado = await db.query(
      `SELECT id FROM citas WHERE fecha = $1 AND hora = $2 AND estado != 'CANCELADA'`,
      [fecha, hora]
    );

    if (ocupado.rows.length > 0) {
      return res.status(409).json({ error: 'El horario seleccionado ya se encuentra reservado. Elige otro bloque.' });
    }

    const pacQuery = await db.query('SELECT nombre, tutor_id FROM pacientes WHERE id = $1', [pacienteId]);
    if (pacQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }
    const paciente = pacQuery.rows[0];

    if (triage) {
      const triageEnum = ['ROJO', 'AMARILLO', 'VERDE'].includes(triage.toUpperCase()) ? triage.toUpperCase() : 'VERDE';
      await db.query('UPDATE pacientes SET triage = $1 WHERE id = $2', [triageEnum, pacienteId]);
    }

    const randomFolio = `URB-${Math.floor(1000 + Math.random() * 9000)}`;
    const nuevaCita = await db.query(
      `INSERT INTO citas (folio, fecha, hora, motivo, estado, paciente_id)
       VALUES ($1, $2, $3, $4, 'EN_SALA', $5)
       RETURNING *`,
      [randomFolio, fecha, hora, motivo ? motivo.trim() : 'Control Pediátrico', pacienteId]
    );

    await db.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        req.usuario.rol,
        `Agendó cita ${randomFolio} para paciente ${paciente.nombre} para el ${fecha} a las ${hora}`
      ]
    );

    res.status(201).json({
      mensaje: 'Cita agendada y confirmada exitosamente.',
      cita: nuevaCita.rows[0]
    });
  } catch (error) {
    console.error('Error en POST /api/recepcion/agendar-cita:', error);
    res.status(500).json({ error: 'Error al agendar la cita en el sistema.' });
  }
});

router.put('/pacientes/:id/medidas', async (req, res) => {
  const { id } = req.params;
  const { peso, talla, perimetroCefalico, temperatura } = req.body;

  if (peso !== undefined && peso !== null && peso !== '') {
    const p = parseFloat(peso);
    if (isNaN(p) || p <= 0 || p > 200) {
      return res.status(400).json({ error: 'El peso debe ser un número positivo en kg (ej. 9.40).' });
    }
  }

  if (talla !== undefined && talla !== null && talla !== '') {
    const t = parseFloat(talla);
    if (isNaN(t) || t <= 0 || t > 250) {
      return res.status(400).json({ error: 'La talla debe ser un número positivo en cm (ej. 75.0).' });
    }
  }

  if (perimetroCefalico !== undefined && perimetroCefalico !== null && perimetroCefalico !== '') {
    const pc = parseFloat(perimetroCefalico);
    if (isNaN(pc) || pc <= 0 || pc > 100) {
      return res.status(400).json({ error: 'El perímetro cefálico debe ser un número positivo en cm.' });
    }
  }

  if (temperatura !== undefined && temperatura !== null && temperatura !== '') {
    const temp = parseFloat(temperatura);
    if (isNaN(temp) || temp < 30 || temp > 45) {
      return res.status(400).json({ error: 'La temperatura debe ser válida en °C (ej. 36.8).' });
    }
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const pacRes = await client.query('SELECT id, nombre, tutor_id FROM pacientes WHERE id = $1', [id]);
    if (pacRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }
    const paciente = pacRes.rows[0];

    const pesoNum = (peso !== undefined && peso !== '' && peso !== null) ? parseFloat(peso) : null;
    const tallaNum = (talla !== undefined && talla !== '' && talla !== null) ? parseFloat(talla) : null;
    const pcNum = (perimetroCefalico !== undefined && perimetroCefalico !== '' && perimetroCefalico !== null) ? parseFloat(perimetroCefalico) : null;
    const tempNum = (temperatura !== undefined && temperatura !== '' && temperatura !== null) ? parseFloat(temperatura) : null;

    const pacUpdate = await client.query(
      `UPDATE pacientes
       SET peso_kg = COALESCE($1, peso_kg),
           talla_cm = COALESCE($2, talla_cm),
           perimetro_cefalico = COALESCE($3, perimetro_cefalico),
           temperatura = COALESCE($4, temperatura)
       WHERE id = $5
       RETURNING *`,
      [pesoNum, tallaNum, pcNum, tempNum, id]
    );

    const histInsert = await client.query(
      `INSERT INTO historial_medidas (paciente_id, fecha, peso_kg, talla_cm, perimetro_cefalico, temperatura, creado_por)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, pesoNum, tallaNum, pcNum, tempNum, req.usuario.id]
    );

    await client.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        req.usuario.rol,
        `Actualizó medidas e historial de crecimiento para paciente ${paciente.nombre}: Peso=${pesoNum || 'N/A'} kg, Talla=${tallaNum || 'N/A'} cm, PC=${pcNum || 'N/A'} cm, Temp=${tempNum || 'N/A'} °C`
      ]
    );

    await client.query('COMMIT');

    res.json({
      mensaje: 'Medidas antropométricas actualizadas e historial OMS registrado con éxito.',
      paciente: pacUpdate.rows[0],
      medida: histInsert.rows[0]
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en PUT /api/recepcion/pacientes/:id/medidas:', error);
    res.status(500).json({ error: 'Error al actualizar las medidas del paciente.' });
  } finally {
    client.release();
  }
});

router.get('/pacientes/:id/medidas', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT id, fecha, peso_kg, talla_cm, perimetro_cefalico, temperatura, creado_en
       FROM historial_medidas
       WHERE paciente_id = $1
       ORDER BY fecha DESC, creado_en DESC`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/recepcion/pacientes/:id/medidas:', error);
    res.status(500).json({ error: 'Error al consultar historial de medidas.' });
  }
});

module.exports = router;
