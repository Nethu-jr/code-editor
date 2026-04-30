const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';

function sign(payload, opts = {}) {
  return jwt.sign(payload, SECRET, { expiresIn: '24h', ...opts });
}

function verify(token) {
  if (!token) throw new Error('no_token');
  return jwt.verify(token, SECRET);
}

function middleware(req, res, next) {
  // Bearer token in Authorization header.
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = verify(token);
    next();
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
}

module.exports = { sign, verify, middleware };
