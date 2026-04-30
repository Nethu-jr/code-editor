const express = require('express');
const router = express.Router();

module.exports = ({ ai }) => {
  router.post('/complete', async (req, res) => {
    try {
      const { code, lang, cursorPos } = req.body;
      if (typeof code !== 'string' || typeof cursorPos !== 'number') {
        return res.status(400).json({ error: 'code, cursorPos required' });
      }
      const out = await ai.complete({ code, lang: lang || 'plaintext', cursorPos });
      res.json({ suggestion: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/explain', async (req, res) => {
    try {
      const out = await ai.explain(req.body || {});
      res.json({ explanation: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/debug', async (req, res) => {
    try {
      const out = await ai.debug(req.body || {});
      res.json({ analysis: out });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
