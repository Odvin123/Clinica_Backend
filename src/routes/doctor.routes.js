const express = require('express');
const db = require('../config/db');
const { verificarAutenticacion, verificarRol } = require('../middlewares/auth');

const router = express.Router();

(async () => {
  try {
    await db.query(`
      ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS perimetro_cefalico NUMERIC(5,2);
      ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS temperatura NUMERIC(4,1);
      ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS antecedentes TEXT;
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS hora_inicio VARCHAR(20) DEFAULT '08:00 AM';
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS intervalo_minutos INTEGER DEFAULT 480;
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS proximo_envio TIMESTAMP;
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS frecuencia_horas INTEGER DEFAULT 8;
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS dias INTEGER DEFAULT 5;
      ALTER TABLE recetas ALTER COLUMN dias TYPE INTEGER USING dias::integer;
      ALTER TABLE recetas ALTER COLUMN frecuencia_horas TYPE INTEGER USING frecuencia_horas::integer;
    `);
  } catch (e) {

  }
})();

router.use(verificarAutenticacion, verificarRol('ADMIN', 'DOCTOR'));

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

router.get('/dashboard', async (req, res) => {
  const { fecha } = req.query;
  const hoyIso = new Date().toISOString().split('T')[0];

  const fechaHoy = fecha && fecha !== 'all' ? fecha : (fecha === 'all' ? 'all' : hoyIso);

  try {

    const metricasResult = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE c.estado != 'CANCELADA' AND ($1::text = 'all' OR c.fecha = $1::date)) AS total_hoy,
        COUNT(*) FILTER (WHERE p.triage = 'ROJO' AND c.estado IN ('CONFIRMADA', 'EN_SALA') AND ($1::text = 'all' OR c.fecha = $1::date)) AS urgencias_rojo,
        COUNT(*) FILTER (WHERE p.triage = 'VERDE' AND c.estado IN ('CONFIRMADA', 'EN_SALA') AND ($1::text = 'all' OR c.fecha = $1::date)) AS controles_verde,
        COUNT(*) FILTER (WHERE c.estado = 'ATENDIDA' AND ($1::text = 'all' OR c.fecha = $1::date)) AS atendidos_hoy
      FROM citas c
      JOIN pacientes p ON c.paciente_id = p.id
    `, [fecha === 'all' ? 'all' : fechaHoy]);

    let queryEspera = `
      SELECT
        c.id AS cita_id,
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
        u.telefono AS tutor_telefono,
        u.dni AS tutor_dni
      FROM citas c
      JOIN pacientes p ON c.paciente_id = p.id
      JOIN usuarios u ON p.tutor_id = u.id
      WHERE c.estado IN ('CONFIRMADA', 'EN_SALA')
    `;
    const params = [];

    if (fecha !== 'all') {
      params.push(fechaHoy);
      queryEspera += ` AND c.fecha = $1`;
    }

    queryEspera += `
      ORDER BY
        CASE p.triage
          WHEN 'ROJO' THEN 1
          WHEN 'AMARILLO' THEN 2
          ELSE 3
        END ASC,
        c.fecha ASC,
        c.hora ASC
    `;

    const esperaResult = await db.query(queryEspera, params);

    const todosPacientesResult = await db.query(`
      SELECT
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
        u.telefono AS tutor_telefono
      FROM pacientes p
      JOIN usuarios u ON p.tutor_id = u.id
      ORDER BY p.nombre ASC
    `);

    const m = metricasResult.rows[0] || {};
    const totalCalculado = Math.max(parseInt(m.total_hoy, 10) || 0, esperaResult.rows.length);

    res.json({
      fecha: fechaHoy,
      totalHoy: totalCalculado,
      urgenciasRojo: parseInt(m.urgencias_rojo, 10) || 0,
      controlesVerde: parseInt(m.controles_verde, 10) || 0,
      atendidosHoy: parseInt(m.atendidos_hoy, 10) || 0,
      pacientesEspera: esperaResult.rows,
      todosPacientes: todosPacientesResult.rows
    });
  } catch (error) {
    console.error('Error en GET /api/doctor/dashboard:', error);
    res.status(500).json({ error: 'Error al consultar datos del dashboard médico.' });
  }
});

router.get('/fila-espera', async (req, res) => {
  const { fecha } = req.query;

  try {
    let query = `
      SELECT
        c.id AS cita_id,
        c.folio,
        c.fecha,
        c.hora,
        c.motivo,
        c.estado,
        c.doctor_id,
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
        u.telefono AS tutor_telefono,
        u.email AS tutor_email
      FROM citas c
      JOIN pacientes p ON c.paciente_id = p.id
      JOIN usuarios u ON p.tutor_id = u.id
      WHERE c.estado IN ('CONFIRMADA', 'EN_SALA')
    `;
    const params = [];

    if (fecha && fecha !== 'all') {
      params.push(fecha);
      query += ` AND c.fecha = $${params.length}`;
    }

    query += `
      ORDER BY
        CASE p.triage
          WHEN 'ROJO' THEN 1
          WHEN 'AMARILLO' THEN 2
          ELSE 3
        END ASC,
        c.fecha ASC,
        c.hora ASC
    `;

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/doctor/fila-espera:', error);
    res.status(500).json({ error: 'Error al consultar la fila de espera de pacientes.' });
  }
});

router.get('/paciente/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(`
      SELECT
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
        u.telefono AS tutor_telefono,
        u.email AS tutor_email
      FROM pacientes p
      JOIN usuarios u ON p.tutor_id = u.id
      WHERE p.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }

    const pacienteData = result.rows[0];
    const medidasRes = await db.query(
      `SELECT id, fecha, peso_kg, talla_cm, perimetro_cefalico, temperatura, creado_en
       FROM historial_medidas
       WHERE paciente_id = $1
       ORDER BY fecha ASC, creado_en ASC`,
      [id]
    );
    pacienteData.historial_medidas = medidasRes.rows;
    pacienteData.historialMedidas = medidasRes.rows;

    res.json(pacienteData);
  } catch (error) {
    console.error('Error en GET /api/doctor/paciente/:id:', error);
    res.status(500).json({ error: 'Error al obtener datos del paciente.' });
  }
});

router.put('/paciente/:id/signos', async (req, res) => {
  const { id } = req.params;
  const { peso, talla, perimetroCefalico, temperatura, antecedentes, cronicos } = req.body;

  if (peso !== undefined && peso !== null && peso !== '') {
    const p = parseFloat(peso);
    if (isNaN(p) || p <= 0 || p > 200) {
      return res.status(400).json({ error: 'El peso debe ser un número positivo en kg (ej. 10.5).' });
    }
  }

  if (talla !== undefined && talla !== null && talla !== '') {
    const t = parseFloat(talla);
    if (isNaN(t) || t <= 0 || t > 250) {
      return res.status(400).json({ error: 'La talla debe ser un número positivo en cm (ej. 85.0).' });
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
    if (isNaN(temp) || temp <= 0 || temp < 30 || temp > 45) {
      return res.status(400).json({ error: 'La temperatura debe ser un número positivo válido en °C (ej. 36.8).' });
    }
  }

  try {
    const pacResult = await db.query('SELECT id, nombre FROM pacientes WHERE id = $1', [id]);
    if (pacResult.rows.length === 0) {
      return res.status(404).json({ error: 'Paciente no encontrado.' });
    }

    const pesoNum = (peso !== undefined && peso !== '') ? parseFloat(peso) : null;
    const tallaNum = (talla !== undefined && talla !== '') ? parseFloat(talla) : null;
    const pcNum = (perimetroCefalico !== undefined && perimetroCefalico !== '') ? parseFloat(perimetroCefalico) : null;
    const tempNum = (temperatura !== undefined && temperatura !== '') ? parseFloat(temperatura) : null;
    const antTxt = antecedentes !== undefined ? String(antecedentes).trim() : null;
    const cronTxt = cronicos !== undefined ? String(cronicos).trim() : null;

    const updated = await db.query(`
      UPDATE pacientes
      SET peso_kg = COALESCE($1, peso_kg),
          talla_cm = COALESCE($2, talla_cm),
          perimetro_cefalico = COALESCE($3, perimetro_cefalico),
          temperatura = COALESCE($4, temperatura),
          antecedentes = COALESCE($5, antecedentes),
          cronicos = COALESCE($6, cronicos)
      WHERE id = $7
      RETURNING *
    `, [pesoNum, tallaNum, pcNum, tempNum, antTxt, cronTxt, id]);

    if (pesoNum !== null || tallaNum !== null || pcNum !== null || tempNum !== null) {
      await db.query(
        `INSERT INTO historial_medidas (paciente_id, fecha, peso_kg, talla_cm, perimetro_cefalico, temperatura, creado_por)
         VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)`,
        [id, pesoNum, tallaNum, pcNum, tempNum, req.usuario.id]
      );
    }

    await db.query(`
      INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)
    `, [
      req.usuario.nombre,
      'DOCTOR',
      `Actualizó signos vitales de ${pacResult.rows[0].nombre}: Peso=${pesoNum || 'N/A'} kg, Talla=${tallaNum || 'N/A'} cm, PC=${pcNum || 'N/A'} cm, Temp=${tempNum || 'N/A'} °C`
    ]);

    const historialActualizado = await db.query(
      `SELECT id, fecha, peso_kg, talla_cm, perimetro_cefalico, temperatura, creado_en
       FROM historial_medidas
       WHERE paciente_id = $1
       ORDER BY fecha ASC, creado_en ASC`,
      [id]
    );

    res.json({
      mensaje: 'Signos vitales y antropometría actualizados en la base de datos.',
      paciente: updated.rows[0],
      historialMedidas: historialActualizado.rows
    });
  } catch (error) {
    console.error('Error en PUT /api/doctor/paciente/:id/signos:', error);
    res.status(500).json({ error: 'Error al actualizar los signos vitales del paciente.' });
  }
});

router.get('/paciente/:id/historial', async (req, res) => {
  const { id } = req.params;

  try {
    const recetasRes = await db.query(`
      SELECT
        r.id,
        r.cie10,
        r.medicamento,
        r.dosis,
        r.frecuencia_horas,
        r.dias,
        r.notas,
        r.estado,
        r.creado_en AS fecha,
        COALESCE(u.nombre, 'Dr. Elman Urbina') AS doctor_nombre
      FROM recetas r
      LEFT JOIN usuarios u ON r.doctor_id = u.id
      WHERE r.paciente_id = $1
      ORDER BY r.creado_en DESC
    `, [id]);

    const citasRes = await db.query(`
      SELECT
        c.id,
        c.folio,
        c.fecha,
        c.hora,
        c.motivo,
        c.estado,
        COALESCE(u.nombre, 'Dr. Elman Urbina') AS doctor_nombre
      FROM citas c
      LEFT JOIN usuarios u ON c.doctor_id = u.id
      WHERE c.paciente_id = $1 AND c.estado = 'ATENDIDA'
      ORDER BY c.fecha DESC, c.hora DESC
    `, [id]);

    const medidasRes = await db.query(`
      SELECT
        id,
        fecha,
        peso_kg,
        talla_cm,
        perimetro_cefalico,
        temperatura,
        creado_en
      FROM historial_medidas
      WHERE paciente_id = $1
      ORDER BY fecha ASC, creado_en ASC
    `, [id]);

    res.json({
      recetas: recetasRes.rows,
      citasAtendidas: citasRes.rows,
      historialMedidas: medidasRes.rows
    });
  } catch (error) {
    console.error('Error en GET /api/doctor/paciente/:id/historial:', error);
    res.status(500).json({ error: 'Error al consultar el historial clínico del paciente.' });
  }
});

router.get('/paciente/:id/vacunas', async (req, res) => {
  const { id } = req.params;

  try {
    let result = await db.query(
      `SELECT * FROM vacunas WHERE paciente_id = $1 ORDER BY creado_en ASC`,
      [id]
    );

    if (result.rows.length === 0) {
      for (const v of CATALOGO_PAI) {
        await db.query(`
          INSERT INTO vacunas (paciente_id, nombre, dosis, edad_recomendada, estado, aplicada)
          VALUES ($1, $2, $3, $4, 'PENDIENTE', false)
        `, [id, v.nombre, v.dosis, v.edad]);
      }

      result = await db.query(
        `SELECT * FROM vacunas WHERE paciente_id = $1 ORDER BY creado_en ASC`,
        [id]
      );
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/doctor/paciente/:id/vacunas:', error);
    res.status(500).json({ error: 'Error al consultar el esquema de vacunas del paciente.' });
  }
});

router.put('/vacuna/:vacunaId/aplicar', async (req, res) => {
  const { vacunaId } = req.params;
  const nombreDoctor = req.usuario.nombre || 'Dr. Elman Urbina';

  try {
    const result = await db.query(`
      UPDATE vacunas
      SET estado = 'APLICADA',
          aplicada = true,
          fecha_aplicacion = CURRENT_DATE,
          firmada_por = $1,
          doctor_nombre = $1
      WHERE id = $2
      RETURNING *
    `, [nombreDoctor, vacunaId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Vacuna no encontrada.' });
    }

    res.json({
      mensaje: 'Vacuna marcada como APLICADA y sellada exitosamente.',
      vacuna: result.rows[0]
    });
  } catch (error) {
    console.error('Error en PUT /api/doctor/vacuna/:vacunaId/aplicar:', error);
    res.status(500).json({ error: 'Error al sellar la vacuna.' });
  }
});

router.get('/recetas', async (req, res) => {
  const { fecha } = req.query;

  try {
    let query = `
      SELECT
        r.id,
        r.cie10,
        r.medicamento,
        r.dosis,
        r.frecuencia_horas,
        r.intervalo_minutos,
        r.proximo_envio,
        r.hora_inicio,
        r.dias,
        r.notas,
        r.estado,
        r.creado_en,
        p.id AS paciente_id,
        p.nombre AS paciente_nombre,
        u.id AS tutor_id,
        u.nombre AS tutor_nombre,
        u.telefono AS tutor_telefono
      FROM recetas r
      JOIN pacientes p ON r.paciente_id = p.id
      JOIN usuarios u ON p.tutor_id = u.id
    `;
    const params = [];

    if (fecha && fecha !== 'all') {
      params.push(fecha);
      query += ` WHERE DATE(r.creado_en) = $1::date`;
    }

    query += ` ORDER BY r.creado_en DESC`;

    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/doctor/recetas:', error);
    res.status(500).json({ error: 'Error al consultar las recetas emitidas.' });
  }
});

router.post('/receta', async (req, res) => {
  const {
    pacienteId,
    cie10,
    medicamento,
    dosis,
    frecuenciaHoras,
    intervaloMinutos,
    dias,
    notas,
    horaInicio,
    activarPush
  } = req.body;
  const doctorId = req.usuario.id;

  if (!pacienteId || !cie10 || !medicamento || !dosis) {
    return res.status(400).json({ error: 'Paciente, diagnóstico CIE-10, medicamento y dosis son obligatorios.' });
  }

  const frecInt = parseInt(frecuenciaHoras, 10);
  const diasInt = parseInt(dias, 10);
  const minInt = intervaloMinutos ? parseInt(intervaloMinutos, 10) : NaN;

  const minCalc = !isNaN(minInt) && minInt > 0
    ? minInt
    : (!isNaN(frecInt) && frecInt > 0 ? frecInt * 60 : 480);

  const horasCalc = !isNaN(frecInt) && frecInt > 0
    ? frecInt
    : Math.max(1, Math.round(minCalc / 60));

  const diasCalc = !isNaN(diasInt) && diasInt > 0 ? diasInt : 5;
  const estadoInicial = activarPush ? 'ACTIVA' : 'PENDIENTE_RECEPCION';
  const proximoEnvio = new Date(Date.now() + minCalc * 60 * 1000);

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    const pacResult = await client.query('SELECT id, nombre FROM pacientes WHERE id = $1', [pacienteId]);
    if (pacResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'El paciente especificado no existe.' });
    }
    const paciente = pacResult.rows[0];

    const horaInicioFinal = horaInicio && String(horaInicio).trim() ? String(horaInicio).trim() : '08:00';

    const recetaResult = await client.query(`
      INSERT INTO recetas (
        cie10, medicamento, dosis, frecuencia_horas, intervalo_minutos, proximo_envio,
        dias, hora_inicio, notas, estado, paciente_id, doctor_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      cie10.trim(),
      medicamento.trim(),
      dosis.trim(),
      horasCalc,
      minCalc,
      proximoEnvio,
      diasCalc,
      horaInicioFinal,
      notas ? notas.trim() : null,
      estadoInicial,
      pacienteId,
      doctorId
    ]);

    const nuevaReceta = recetaResult.rows[0];

    await client.query(`
      UPDATE citas
      SET estado = 'ATENDIDA',
          doctor_id = COALESCE(doctor_id, $2)
      WHERE paciente_id = $1
        AND estado IN ('CONFIRMADA', 'EN_SALA', 'PENDIENTE_VALIDACION')
    `, [pacienteId, doctorId]);

    await client.query(`
      INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        'DOCTOR',
        `Finalizó consulta y emitió receta médica de ${medicamento} (${cie10}) para ${paciente.nombre} (Intervalo: cada ${minCalc} min)`
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      mensaje: 'Consulta finalizada. Cita marcada como ATENDIDA y receta registrada.',
      receta: {
        ...nuevaReceta,
        paciente_nombre: paciente.nombre
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en POST /api/doctor/receta:', error);
    res.status(500).json({ error: 'Error al emitir y guardar la receta médica.' });
  } finally {
    client.release();
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
        'DOCTOR',
        `Programó horarios Push para receta ${rec.medicamento} (Cada ${minCalc} min, próximo envío: ${rec.proximo_envio ? new Date(rec.proximo_envio).toLocaleString('es-NI') : ''})`
      ]
    );

    res.json({
      mensaje: 'Horario e intervalo Push programado exitosamente.',
      receta: rec
    });
  } catch (error) {
    console.error('Error en PUT /api/doctor/recetas/:id/programar:', error);
    res.status(500).json({ error: 'Error al programar horarios de la receta.' });
  }
});

router.post('/probar-push', async (req, res) => {
  const { recetaId, pacienteId, tutorId, medicamento, dosis } = req.body;

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

    if (!info && pacienteId) {
      const pQuery = await db.query(
        `SELECT p.id AS paciente_id, p.nombre AS paciente_nombre,
                u.id AS tutor_id, u.nombre AS tutor_nombre, u.telefono AS tutor_telefono
         FROM pacientes p
         JOIN usuarios u ON p.tutor_id = u.id
         WHERE p.id = $1`,
        [pacienteId]
      );
      if (pQuery.rows.length > 0) info = pQuery.rows[0];
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
      return res.status(404).json({ error: 'Selecciona un paciente o receta válida para enviar la prueba Push.' });
    }

    const medNombre = medicamento || info.medicamento || 'Medicamento Pediátrico';
    const medDosis = dosis || info.dosis || 'Dosis indicada';
    const pacNombre = info.paciente_nombre || 'su hijo(a)';
    const titulo = `🔔 [Prueba Push] Hora de toma: ${medNombre}`;
    const mensaje = `Hola ${info.tutor_nombre}, recordatorio inmediato del Dr. Elman Urbina: Administrar ${medDosis} de ${medNombre} a ${pacNombre}.`;

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
        'DOCTOR',
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
    console.error('Error en POST /api/doctor/probar-push:', error);
    res.status(500).json({ error: 'Error al enviar la notificación Push de prueba.' });
  }
});

module.exports = router;
