const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { verificarAutenticacion, verificarRol } = require('../middlewares/auth');

const router = express.Router();

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS configuracion_clinica (
        id INTEGER PRIMARY KEY DEFAULT 1,
        nombre_clinica VARCHAR(255) DEFAULT 'Clínica Pediátrica Dr. Elman Urbina',
        director_medico VARCHAR(255) DEFAULT 'Dr. Elman Urbina · Pediatra Neonatólogo',
        codigo_minsa VARCHAR(100) DEFAULT 'MINSA-CHON-042',
        telefono_recepcion VARCHAR(50) DEFAULT '+505 5876 4830',
        correo_contacto VARCHAR(255) DEFAULT 'contacto@clinicaurbina.ni',
        direccion VARCHAR(500) DEFAULT 'Costado Sur Catedral de Juigalpa, 75 varas al Oeste, Juigalpa, Chontales',
        horario_semana VARCHAR(100) DEFAULT '08:00 AM - 05:00 PM',
        horario_sabado VARCHAR(100) DEFAULT '08:00 AM - 12:30 PM',
        duracion_bloque_min INTEGER DEFAULT 30,
        whatsapp_alertas_activo BOOLEAN DEFAULT true,
        actualizado_en TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO configuracion_clinica (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);
  } catch (e) {

  }
})();

router.use(verificarAutenticacion, verificarRol('ADMIN'));

router.post('/crear-personal', async (req, res) => {
  const { nombre, email, rol, dni, telefono } = req.body;

  if (!nombre || !email || !rol) {
    return res.status(400).json({ error: 'Nombre, email y rol son obligatorios.' });
  }

  if (!['DOCTOR', 'RECEPCION'].includes(rol)) {
    return res.status(400).json({ error: 'El rol debe ser DOCTOR o RECEPCION.' });
  }

  try {
    const existe = await db.query('SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    if (existe.rows.length > 0) {
      return res.status(400).json({ error: 'Ya existe un usuario con este correo electrónico.' });
    }

    const pinTemporal = Math.floor(1000 + Math.random() * 9000).toString();
    const hash = await bcrypt.hash(pinTemporal, 10);

    const result = await db.query(
      `INSERT INTO usuarios (email, password, rol, nombre, dni, telefono, pin_activacion, activo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, nombre, email, rol, dni, telefono, pin_activacion, activo, creado_en`,
      [email.trim().toLowerCase(), hash, rol, nombre.trim(), dni ? dni.trim() : null, telefono ? telefono.trim() : null, pinTemporal]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'El usuario ya existe.' });
    }

    const nuevoUsuario = result.rows[0];

    await db.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        'ADMIN',
        `Creó cuenta de personal: ${nuevoUsuario.nombre} (${nuevoUsuario.rol}) con PIN temporal ${pinTemporal}`
      ]
    );

    res.status(201).json({
      mensaje: 'Personal creado exitosamente.',
      usuario: nuevoUsuario,
      pinTemporal: pinTemporal
    });
  } catch (error) {
    console.error('Error en POST /api/admin/crear-personal:', error);
    res.status(500).json({ error: 'Error al registrar al personal.' });
  }
});

router.put('/generar-pin/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const check = await db.query(`SELECT id, nombre, email, rol FROM usuarios WHERE id = $1`, [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const usuario = check.rows[0];
    const nuevoPin = Math.floor(1000 + Math.random() * 9000).toString();
    const hashPin = await bcrypt.hash(nuevoPin, 10);

    const updated = await db.query(
      `UPDATE usuarios
       SET password = $1,
           pin_activacion = $2,
           activo = false,
           intentos_fallidos = 0,
           bloqueado_hasta = NULL
       WHERE id = $3
       RETURNING id, nombre, email, rol, telefono, dni, pin_activacion, activo`,
      [hashPin, nuevoPin, id]
    );

    await db.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        'ADMIN',
        `Generó nuevo PIN de acceso (${nuevoPin}) para ${usuario.nombre} (${usuario.rol}). Estado restablecido a Pendiente.`
      ]
    );

    res.json({
      mensaje: `Nuevo PIN generado para ${usuario.nombre}.`,
      pinTemporal: nuevoPin,
      usuario: updated.rows[0]
    });
  } catch (error) {
    console.error('Error en PUT /api/admin/generar-pin/:id:', error);
    res.status(500).json({ error: 'Error al generar el PIN de acceso.' });
  }
});

router.get('/personal', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nombre, email, rol, telefono, dni, pin_activacion, activo, creado_en
       FROM usuarios
       WHERE rol IN ('DOCTOR', 'RECEPCION')
       ORDER BY creado_en DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/admin/personal:', error);
    res.status(500).json({ error: 'Error al obtener la lista de personal.' });
  }
});

router.get('/usuarios', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, nombre, email, rol, telefono, dni, pin_activacion, activo, creado_en
       FROM usuarios
       WHERE rol IN ('DOCTOR', 'RECEPCION', 'TUTOR')
       ORDER BY creado_en DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/admin/usuarios:', error);
    res.status(500).json({ error: 'Error al obtener los usuarios del sistema.' });
  }
});

router.put('/suspender-personal/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const check = await db.query(
      `SELECT id, nombre, rol, activo FROM usuarios WHERE id = $1`,
      [id]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    const usuarioActual = check.rows[0];
    const nuevoEstado = !usuarioActual.activo;

    const result = await db.query(
      `UPDATE usuarios SET activo = $1 WHERE id = $2 RETURNING id, nombre, email, rol, activo, pin_activacion`,
      [nuevoEstado, id]
    );

    const actualizado = result.rows[0];
    const accionTxt = nuevoEstado ? 'Reactivó la cuenta de' : 'Suspendió la cuenta de';

    await db.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        'ADMIN',
        `${accionTxt}: ${actualizado.nombre} (${actualizado.rol})`
      ]
    );

    res.json({
      mensaje: `Usuario ${nuevoEstado ? 'activado' : 'suspendido'} exitosamente.`,
      usuario: actualizado
    });
  } catch (error) {
    console.error('Error en PUT /api/admin/suspender-personal/:id:', error);
    res.status(500).json({ error: 'Error al actualizar el estado del personal.' });
  }
});

router.get('/metricas', async (req, res) => {
  try {
    const staffCount = await db.query(
      "SELECT COUNT(*) FROM usuarios WHERE rol IN ('DOCTOR', 'RECEPCION')"
    );
    const tutoresCount = await db.query(
      "SELECT COUNT(*) FROM usuarios WHERE rol = 'TUTOR'"
    );
    const citasAtendidasCount = await db.query(
      "SELECT COUNT(*) FROM citas WHERE estado = 'ATENDIDA'"
    );
    const citasEsperaCount = await db.query(
      "SELECT COUNT(*) FROM citas WHERE estado IN ('PENDIENTE_VALIDACION', 'CONFIRMADA', 'EN_SALA')"
    );
    const recetasCount = await db.query(
      "SELECT COUNT(*) FROM recetas"
    );
    const auditLogs = await db.query(
      "SELECT id, usuario, rol, accion, creado_en FROM auditoria ORDER BY creado_en DESC LIMIT 10"
    );

    res.json({
      staffActivos: parseInt(staffCount.rows[0].count, 10) || 0,
      tutoresTotal: parseInt(tutoresCount.rows[0].count, 10) || 0,
      atencionesMes: parseInt(citasAtendidasCount.rows[0].count, 10) || 0,
      citasEnEspera: parseInt(citasEsperaCount.rows[0].count, 10) || 0,
      recetasEmitidas: parseInt(recetasCount.rows[0].count, 10) || 0,
      bitacora: auditLogs.rows
    });
  } catch (error) {
    console.error('Error en GET /api/admin/metricas:', error);
    res.status(500).json({ error: 'Error al recopilar métricas y auditoría.' });
  }
});

router.get('/configuracion', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM configuracion_clinica WHERE id = 1');
    res.json(result.rows[0] || {});
  } catch (error) {
    console.error('Error en GET /api/admin/configuracion:', error);
    res.status(500).json({ error: 'Error al cargar la configuración de la clínica.' });
  }
});

router.put('/configuracion', async (req, res) => {
  const {
    nombreClinica,
    directorMedico,
    codigoMinsa,
    telefonoRecepcion,
    correoContacto,
    direccion,
    horarioSemana,
    horarioSabado,
    duracionBloqueMin,
    whatsappAlertasActivo
  } = req.body;

  try {
    const result = await db.query(
      `UPDATE configuracion_clinica
       SET nombre_clinica = COALESCE($1, nombre_clinica),
           director_medico = COALESCE($2, director_medico),
           codigo_minsa = COALESCE($3, codigo_minsa),
           telefono_recepcion = COALESCE($4, telefono_recepcion),
           correo_contacto = COALESCE($5, correo_contacto),
           direccion = COALESCE($6, direccion),
           horario_semana = COALESCE($7, horario_semana),
           horario_sabado = COALESCE($8, horario_sabado),
           duracion_bloque_min = COALESCE($9, duracion_bloque_min),
           whatsapp_alertas_activo = COALESCE($10, whatsapp_alertas_activo),
           actualizado_en = CURRENT_TIMESTAMP
       WHERE id = 1
       RETURNING *`,
      [
        nombreClinica ? nombreClinica.trim() : null,
        directorMedico ? directorMedico.trim() : null,
        codigoMinsa ? codigoMinsa.trim() : null,
        telefonoRecepcion ? telefonoRecepcion.trim() : null,
        correoContacto ? correoContacto.trim() : null,
        direccion ? direccion.trim() : null,
        horarioSemana ? horarioSemana.trim() : null,
        horarioSabado ? horarioSabado.trim() : null,
        duracionBloqueMin ? parseInt(duracionBloqueMin, 10) : 30,
        whatsappAlertasActivo !== undefined ? Boolean(whatsappAlertasActivo) : true
      ]
    );

    await db.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [
        req.usuario.nombre,
        'ADMIN',
        `Actualizó la Configuración Institucional de la Clínica (Horarios: ${horarioSemana || 'L-V'}, Tel: ${telefonoRecepcion || 'N/A'})`
      ]
    );

    res.json({
      mensaje: 'Configuración de la clínica guardada exitosamente en PostgreSQL.',
      configuracion: result.rows[0]
    });
  } catch (error) {
    console.error('Error en PUT /api/admin/configuracion:', error);
    res.status(500).json({ error: 'Error al guardar la configuración de la clínica.' });
  }
});

module.exports = router;
