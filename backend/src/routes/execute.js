const express = require('express');
const router = express.Router();

module.exports = ({ exec }) => {
  router.post('/', async (req, res) => {
    const { language, code, stdin, timeoutMs } = req.body || {};
    if (!language || typeof code !== 'string') {
      return res.status(400).json({ error: 'language and code required' });
    }
    const result = await exec.run({
      language,
      code,
      stdin: stdin || '',
      timeoutMs: Math.min(timeoutMs || 5000, 15_000), // hard cap 15s from API
    });
    res.json(result);
  });
  return router;
};
