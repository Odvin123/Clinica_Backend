const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

const router = express.Router();

(async () => {
  try {
    await db.query(`
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS intentos_fallidos INTEGER DEFAULT 0;
      ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS bloqueado_hasta TIMESTAMP WITH TIME ZONE DEFAULT NULL;
    `);
  } catch (e) {

  }
})();

async function buscarUsuario(identificador) {
  const identLimpio = (identificador || '').trim();
  const telDigitos = identLimpio.replace(/\D/g, '');

  const result = await db.query(
    `SELECT * FROM usuarios
     WHERE LOWER(email) = LOWER($1)
        OR telefono = $1
        OR (LENGTH($2) >= 8 AND REPLACE(telefono, ' ', '') LIKE '%' || $2)
        OR LOWER(dni) = LOWER($1)
     ORDER BY creado_en DESC
     LIMIT 1`,
    [identLimpio, telDigitos]
  );
  return result.rows[0];
}

async function validarPinUsuario(usuario, pin) {
  const pinLimpio = (pin || '').trim().replace(/^PIN-/i, '');
  let esValido = false;

  if (usuario.pin_activacion) {
    const pinAct = usuario.pin_activacion.trim();
    if (pinAct.startsWith('$2a$') || pinAct.startsWith('$2b$')) {
      try {
        esValido = await bcrypt.compare(pinLimpio, pinAct);
      } catch (e) {
        esValido = false;
      }
    } else {
      esValido = (pinAct === pinLimpio);
    }
  }

  if (!esValido && usuario.password) {
    try {
      esValido = await bcrypt.compare(pinLimpio, usuario.password);
    } catch (e) {
      esValido = false;
    }
  }

  return esValido;
}

async function registrarIntentoFallido(usuario) {
  const nuevosFallos = (usuario.intentos_fallidos || 0) + 1;
  if (nuevosFallos >= 3) {
    await db.query(
      `UPDATE usuarios
       SET intentos_fallidos = 0,
           bloqueado_hasta = CURRENT_TIMESTAMP + INTERVAL '10 seconds'
       WHERE id = $1`,
      [usuario.id]
    );
    return { bloqueadoAhora: true, segundos: 10 };
  } else {
    await db.query(
      `UPDATE usuarios
       SET intentos_fallidos = $1
       WHERE id = $2`,
      [nuevosFallos, usuario.id]
    );
    return { bloqueadoAhora: false, restantes: 3 - nuevosFallos };
  }
}

async function resetearIntentos(usuarioId) {
  try {
    await db.query(
      `UPDATE usuarios
       SET intentos_fallidos = 0, bloqueado_hasta = NULL
       WHERE id = $1`,
      [usuarioId]
    );
  } catch (e) {
    console.error('Error reseteando intentos fallidos:', e);
  }
}

router.post('/verificar-pin', async (req, res) => {
  const { email, pin } = req.body;

  if (!email || !pin) {
    return res.status(400).json({ error: 'Debes proporcionar tu correo/teléfono y el PIN temporal de 4 dígitos.' });
  }

  try {
    const usuario = await buscarUsuario(email);

    if (!usuario) {
      return res.status(401).json({ error: 'Credenciales o identificador no encontrado.' });
    }

    if (usuario.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > new Date()) {
      const segundosRestantes = Math.max(1, Math.ceil((new Date(usuario.bloqueado_hasta) - new Date()) / 1000));
      return res.status(429).json({
        bloqueado: true,
        segundosRestantes,
        error: `Demasiados intentos fallidos. Cuenta temporalmente bloqueada por ${segundosRestantes} segundos.`
      });
    }

    const pinValido = await validarPinUsuario(usuario, pin);

    if (!pinValido) {
      const fallo = await registrarIntentoFallido(usuario);
      if (fallo.bloqueadoAhora) {
        return res.status(429).json({
          bloqueado: true,
          segundosRestantes: 10,
          error: 'Has superado el límite de 3 intentos fallidos. Acceso bloqueado por 10 segundos.'
        });
      }
      return res.status(401).json({
        intentosRestantes: fallo.restantes,
        error: `El PIN ingresado es incorrecto. Intentos restantes: ${fallo.restantes}`
      });
    }

    await resetearIntentos(usuario.id);

    res.json({
      valido: true,
      mensaje: 'PIN verificado correctamente.',
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        email: usuario.email,
        telefono: usuario.telefono
      }
    });
  } catch (error) {
    console.error('Error en POST /api/auth/verificar-pin:', error);
    res.status(500).json({ error: 'Error del servidor al verificar el PIN.' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Debes proporcionar correo electrónico o teléfono y tu contraseña o PIN.' });
  }

  try {
    const usuario = await buscarUsuario(email);

    if (!usuario) {
      return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }

    if (usuario.bloqueado_hasta && new Date(usuario.bloqueado_hasta) > new Date()) {
      const segundosRestantes = Math.max(1, Math.ceil((new Date(usuario.bloqueado_hasta) - new Date()) / 1000));
      return res.status(429).json({
        bloqueado: true,
        segundosRestantes,
        error: `Demasiados intentos fallidos. Acceso bloqueado por ${segundosRestantes} segundos.`
      });
    }

    let passwordValida = false;
    try {
      passwordValida = await bcrypt.compare(password.trim(), usuario.password);
    } catch (e) {
      passwordValida = false;
    }

    if (!passwordValida && /^\d{4}$/.test(password.trim())) {
      passwordValida = await validarPinUsuario(usuario, password);
    }

    if (!passwordValida) {
      const fallo = await registrarIntentoFallido(usuario);
      if (fallo.bloqueadoAhora) {
        return res.status(429).json({
          bloqueado: true,
          segundosRestantes: 10,
          error: 'Has superado el límite de 3 intentos fallidos. Acceso bloqueado por 10 segundos.'
        });
      }
      return res.status(401).json({
        intentosRestantes: fallo.restantes,
        error: `Credenciales incorrectas. Intentos restantes: ${fallo.restantes}`
      });
    }

    if (usuario.pin_activacion) {
      await resetearIntentos(usuario.id);
      return res.status(403).json({
        requiereCambioPin: true,
        pinTemporal: usuario.pin_activacion,
        error: 'Debes actualizar tu PIN temporal por una contraseña segura de al menos 8 caracteres.'
      });
    }

    if (!usuario.activo) {
      return res.status(403).json({ error: 'Tu cuenta se encuentra suspendida o pendiente de activación.' });
    }

    await resetearIntentos(usuario.id);

    const payload = { id: usuario.id, rol: usuario.rol, nombre: usuario.nombre };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h'
    });

    res.json({
      token,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        email: usuario.email,
        rol: usuario.rol,
        telefono: usuario.telefono,
        dni: usuario.dni
      }
    });
  } catch (error) {
    console.error('Error en POST /api/auth/login:', error);
    res.status(500).json({ error: 'Error interno del servidor al procesar el inicio de sesión.' });
  }
});

router.post('/cambiar-password', async (req, res) => {
  const { email, pinTemporal, nuevaPassword } = req.body;

  if (!email || !pinTemporal || !nuevaPassword) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios (email/teléfono, PIN temporal y nueva contraseña).' });
  }

  if (String(nuevaPassword).length < 8) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener un mínimo obligatorio de 8 caracteres.' });
  }

  try {
    const usuario = await buscarUsuario(email);

    if (!usuario) {
      return res.status(404).json({ error: 'No se encontró ninguna cuenta asociada a este correo o teléfono.' });
    }

    const pinValido = await validarPinUsuario(usuario, pinTemporal);

    if (!pinValido) {
      return res.status(401).json({ error: 'El PIN temporal es incorrecto o ya ha expirado.' });
    }

    const nuevoHash = await bcrypt.hash(nuevaPassword, 10);

    await db.query(
      `UPDATE usuarios
       SET password = $1, activo = true, pin_activacion = NULL, intentos_fallidos = 0, bloqueado_hasta = NULL
       WHERE id = $2`,
      [nuevoHash, usuario.id]
    );

    await db.query(
      `INSERT INTO auditoria (usuario, rol, accion) VALUES ($1, $2, $3)`,
      [usuario.nombre, usuario.rol, 'Primer acceso completado: Contraseña definitiva configurada y cuenta activada']
    );

    res.json({ mensaje: 'Contraseña actualizada exitosamente. Ya puedes iniciar sesión con tu nueva contraseña.' });
  } catch (error) {
    console.error('Error en POST /api/auth/cambiar-password:', error);
    res.status(500).json({ error: 'Error interno al actualizar la contraseña.' });
  }
});

module.exports = router;
