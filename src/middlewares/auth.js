const jwt = require('jsonwebtoken');
const db = require('../config/db');

const verificarAutenticacion = async (req, res, next) => {
  let token = null;
  const authHeader = req.headers.authorization || req.headers.Authorization || req.headers['x-access-token'];

  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else {
      token = authHeader.trim();
    }
  } else if (req.body && req.body.token) {
    token = req.body.token;
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token || token === 'null' || token === 'undefined' || token === '') {
    return res.status(401).json({ error: 'No autorizado. Falta token de autenticación.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const result = await db.query(
      'SELECT id, email, rol, nombre, activo FROM usuarios WHERE id = $1',
      [decoded.id]
    );
    const usuario = result.rows[0];

    if (!usuario) {
      return res.status(401).json({ error: 'Usuario no encontrado en el sistema.' });
    }

    if (!usuario.activo) {
      return res.status(403).json({ error: 'Cuenta inactiva o suspendida.' });
    }

    req.usuario = usuario;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
};

const verificarRol = (...rolesPermitidos) => {
  return (req, res, next) => {
    if (!req.usuario || !rolesPermitidos.includes(req.usuario.rol)) {
      return res.status(403).json({ error: 'Acceso denegado: permisos insuficientes para tu rol.' });
    }
    next();
  };
};

module.exports = { verificarAutenticacion, verificarRol };
