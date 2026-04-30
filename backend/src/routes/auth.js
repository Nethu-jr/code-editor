const express = require('express');
const { sign } = require('../middleware/auth');

const router = express.Router();

/**
 * Dev-only stub. Real implementation wires up to your IdP / Postgres.
 * Returns a JWT bound to a username so WS handshake can authenticate.
 */
router.post('/login', (req, res) => {
  const { username } = req.body || {};
  if (!username || typeof username !== 'string' || username.length > 64) {
    return res.status(400).json({ error: 'username required' });
  }
  const token = sign({ sub: username, name: username });
  res.json({ token, user: { id: username, name: username } });
});

module.exports = router;
