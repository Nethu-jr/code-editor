/**
 * AIService
 *
 * Thin adapter over a provider (OpenAI by default, Gemini optional).
 * Exposes three primitives:
 *
 *   complete({code, lang, cursorPos})   -> suggested completion string
 *   explain({code, lang, selection})    -> natural-language explanation
 *   debug({code, lang, error})          -> probable cause + fix
 *
 * Caching: identical (code,lang,cursorPos) requests within 30s return
 * cached results — necessary because AI calls dominate latency budget
 * and users tend to hover/retry the same context.
 *
 * The frontend debounces requests, but we still cache server-side because
 * a fleet of clients may all hit the same prefix during a workshop.
 */

const crypto = require('crypto');

class LRUCache {
  constructor(max = 500, ttlMs = 30_000) {
    this.max = max; this.ttlMs = ttlMs; this.map = new Map();
  }
  _key(obj) { return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex'); }
  get(obj) {
    const k = this._key(obj);
    const e = this.map.get(k);
    if (!e) return null;
    if (Date.now() > e.exp) { this.map.delete(k); return null; }
    // Move to end (LRU)
    this.map.delete(k); this.map.set(k, e);
    return e.val;
  }
  set(obj, val) {
    const k = this._key(obj);
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, { val, exp: Date.now() + this.ttlMs });
  }
}

class AIService {
  constructor({ provider = 'openai', apiKey, model } = {}) {
    this.provider = provider;
    this.apiKey = apiKey || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
    this.model = model || (provider === 'openai' ? 'gpt-4o-mini' : 'gemini-1.5-flash');
    this.cache = new LRUCache();
  }

  async _chat(messages, { temperature = 0.2, maxTokens = 256 } = {}) {
    if (!this.apiKey) {
      // Graceful local-dev fallback so the editor still works without keys.
      return '[AI disabled: no API key configured]';
    }
    if (this.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model, messages, temperature, max_tokens: maxTokens,
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      const j = await res.json();
      return j.choices?.[0]?.message?.content?.trim() ?? '';
    }
    if (this.provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      const j = await res.json();
      return j.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    }
    throw new Error(`unknown provider ${this.provider}`);
  }

  async complete({ code, lang, cursorPos }) {
    const key = { kind:'complete', code, lang, cursorPos };
    const hit = this.cache.get(key);
    if (hit) return hit;
    // Take a tight prefix window — the model doesn't need the whole file
    // for inline completion, and smaller prompts are 5-10x cheaper/faster.
    const prefix = code.slice(Math.max(0, cursorPos - 1500), cursorPos);
    const suffix = code.slice(cursorPos, cursorPos + 500);
    const sys = `You complete ${lang} code. Output ONLY the code that should appear at the cursor — no markdown, no explanation, no repetition of context. Stop at a natural boundary (end of line, end of statement).`;
    const user = `\`\`\`${lang}\n${prefix}<CURSOR>${suffix}\n\`\`\``;
    const out = await this._chat([
      { role:'system', content: sys },
      { role:'user', content: user },
    ], { temperature: 0.1, maxTokens: 120 });
    const cleaned = out.replace(/^```[\w]*\n?|```$/g, '').trim();
    this.cache.set(key, cleaned);
    return cleaned;
  }

  async explain({ code, lang, selection }) {
    return this._chat([
      { role:'system', content: `You explain ${lang} code clearly and concisely.` },
      { role:'user', content: `Explain this ${lang} code in 3-5 sentences:\n\n${selection || code}` },
    ], { temperature: 0.3, maxTokens: 400 });
  }

  async debug({ code, lang, error }) {
    return this._chat([
      { role:'system', content: `You diagnose ${lang} bugs. First state the likely cause in one sentence, then a minimal fix.` },
      { role:'user', content: `Code:\n${code}\n\nError:\n${error}` },
    ], { temperature: 0.2, maxTokens: 350 });
  }
}

module.exports = { AIService };
