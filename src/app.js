require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const db = require('./config/db');

const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const recepcionRoutes = require('./routes/recepcion.routes');
const doctorRoutes = require('./routes/doctor.routes');
const tutorRoutes = require('./routes/tutor.routes');
const publicRoutes = require('./routes/public.routes');

const app = express();

app.use(cors());
app.use(express.json());

let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY || '',
  privateKey: process.env.VAPID_PRIVATE_KEY || ''
};

try {
  if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
    vapidKeys = webpush.generateVAPIDKeys();
  }
  webpush.setVapidDetails(
    'mailto:contacto@clinicaurbina.ni',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
} catch (err) {
  console.warn('⚠️ Aviso al configurar VAPID WebPush:', err.message);
}

app.locals.vapidPublicKey = vapidKeys.publicKey;

(async () => {
  try {
    await db.query(`
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS hora_inicio VARCHAR(20) DEFAULT '08:00 AM';
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS intervalo_minutos INTEGER DEFAULT 480;
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS proximo_envio TIMESTAMP;
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS frecuencia_horas INTEGER DEFAULT 8;
      ALTER TABLE recetas ADD COLUMN IF NOT EXISTS dias INTEGER DEFAULT 5;
      ALTER TABLE recetas ALTER COLUMN dias TYPE INTEGER USING dias::integer;
      ALTER TABLE recetas ALTER COLUMN frecuencia_horas TYPE INTEGER USING frecuencia_horas::integer;

      CREATE TABLE IF NOT EXISTS notificaciones_push (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tutor_id UUID REFERENCES usuarios(id) ON DELETE CASCADE,
        paciente_id UUID REFERENCES pacientes(id) ON DELETE CASCADE,
        receta_id UUID REFERENCES recetas(id) ON DELETE SET NULL,
        titulo VARCHAR(255) NOT NULL,
        mensaje TEXT NOT NULL,
        leida BOOLEAN DEFAULT false,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS suscripciones_push (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tutor_id UUID REFERENCES usuarios(id) ON DELETE CASCADE,
        endpoint TEXT UNIQUE NOT NULL,
        keys_p256dh TEXT,
        keys_auth TEXT,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS historial_medidas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        paciente_id UUID REFERENCES pacientes(id) ON DELETE CASCADE,
        fecha DATE DEFAULT CURRENT_DATE,
        peso_kg NUMERIC(5,2),
        talla_cm NUMERIC(5,2),
        perimetro_cefalico NUMERIC(5,2),
        temperatura NUMERIC(4,1),
        creado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
        creado_en TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Columnas intervalo_minutos y proximo_envio verificadas en tabla recetas, y tabla historial_medidas lista.');
  } catch (err) {
    console.warn('⚠️ No se pudo verificar migración inicial de recetas:', err.message);
  }
})();

async function enviarNotificacionPushTutor({ tutorId, tutorNombre, pacienteId, pacienteNombre, recetaId, titulo, mensaje }) {

  const insertRes = await db.query(
    `INSERT INTO notificaciones_push (tutor_id, paciente_id, receta_id, titulo, mensaje, leida, creado_en)
     VALUES ($1, $2, $3, $4, $5, false, NOW())
     RETURNING *`,
    [tutorId || null, pacienteId || null, recetaId || null, titulo, mensaje]
  );

  if (tutorId) {
    try {
      const subs = await db.query(
        `SELECT endpoint, keys_p256dh, keys_auth FROM suscripciones_push WHERE tutor_id = $1`,
        [tutorId]
      );
      const payload = JSON.stringify({
        title: titulo,
        body: mensaje,
        icon: '/assets/hero-peluche.jpg',
        timestamp: Date.now()
      });

      for (const s of subs.rows) {
        if (s.endpoint && s.keys_p256dh && s.keys_auth) {
          await webpush.sendNotification(
            {
              endpoint: s.endpoint,
              keys: { p256dh: s.keys_p256dh, auth: s.keys_auth }
            },
            payload
          ).catch(() => {});
        }
      }
    } catch (e) {

    }
  }

  console.log(`📲 [PUSH NOTIFICACIÓN] Tutor: ${tutorNombre || tutorId} | Paciente: ${pacienteNombre || ''} | ${titulo} -> ${mensaje}`);
  return insertRes.rows[0];
}

app.locals.enviarNotificacionPushTutor = enviarNotificacionPushTutor;

setInterval(async () => {
  try {
    const result = await db.query(`
      SELECT
        r.id,
        r.medicamento,
        r.dosis,
        r.intervalo_minutos,
        r.frecuencia_horas,
        r.proximo_envio,
        p.id AS paciente_id,
        p.nombre AS paciente_nombre,
        u.id AS tutor_id,
        u.nombre AS tutor_nombre,
        u.telefono AS tutor_telefono
      FROM recetas r
      JOIN pacientes p ON r.paciente_id = p.id
      JOIN usuarios u ON p.tutor_id = u.id
      WHERE r.estado = 'ACTIVA'
        AND r.proximo_envio IS NOT NULL
        AND r.proximo_envio <= NOW()
    `);

    if (result.rows.length > 0) {
      for (const rx of result.rows) {
        const intervaloMin = parseInt(rx.intervalo_minutos, 10) || (parseInt(rx.frecuencia_horas, 10) * 60) || 480;
        const titulo = `⏰ Hora de Medicamento: ${rx.medicamento}`;
        const mensaje = `Recordatorio pediátrico para ${rx.tutor_nombre}: Administrar ${rx.dosis} de ${rx.medicamento} a ${rx.paciente_nombre}.`;

        await enviarNotificacionPushTutor({
          tutorId: rx.tutor_id,
          tutorNombre: rx.tutor_nombre,
          pacienteId: rx.paciente_id,
          pacienteNombre: rx.paciente_nombre,
          recetaId: rx.id,
          titulo,
          mensaje
        });

        const updateRes = await db.query(
          `UPDATE recetas
           SET proximo_envio = CASE
             WHEN proximo_envio + ($1 || ' minutes')::interval <= NOW()
             THEN NOW() + ($1 || ' minutes')::interval
             ELSE proximo_envio + ($1 || ' minutes')::interval
           END
           WHERE id = $2
           RETURNING proximo_envio`,
          [intervaloMin, rx.id]
        );

        const nuevoProximo = updateRes.rows[0]?.proximo_envio;

        await db.query(
          `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
          [
            'Timer Push Automático',
            'SISTEMA',
            `Push enviado a ${rx.tutor_nombre} (${rx.paciente_nombre}): ${rx.medicamento} (${rx.dosis}). Próximo envío reprogramado (+${intervaloMin} min): ${nuevoProximo ? new Date(nuevoProximo).toLocaleString('es-NI') : ''}`
          ]
        );
      }
    }
  } catch (error) {
    console.error('❌ Error en el Timer de Notificaciones Push (30s):', error.message);
  }
}, 30 * 1000);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/recepcion', recepcionRoutes);
app.use('/api/doctor', doctorRoutes);
app.use('/api/tutor', tutorRoutes);
app.use('/api/public', publicRoutes);

app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.url}` });
});

app.use((err, req, res, next) => {
  console.error('❌ Error no controlado en la aplicación:', err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT} (Timer Push activo cada 30s)`));
