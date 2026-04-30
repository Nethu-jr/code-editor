/**
 * server.js — entry point.
 *
 * Wires together:
 *   - Express HTTP server (REST: auth, AI, run)
 *   - WebSocket server attached to the same HTTP listener
 *   - SessionManager + RedisService + AI + Execution clients
 *
 * Single process owns one HTTP+WS port. Multiple processes are coordinated
 * via Redis. Sticky sessions at the LB ensure each WS lands on one node
 * for its lifetime.
 */

const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { logger } = require('./utils/logger');
const { SessionManager } = require('./services/sessionManager');
const { RedisService } = require('./services/redisService');
const { AIService } = require('./services/aiService');
const { ExecutionService } = require('./services/executionService');
const { attachSocketHandlers } = require('./ws/socketHandler');
const auth = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const sessions = new SessionManager();
const redis = new RedisService({ url: config.redisUrl });
const ai = new AIService({ provider: config.aiProvider, model: config.aiModel });
const exec = new ExecutionService({ url: config.execEngineUrl });

app.get('/health', (_req, res) => res.json({
  ok: true,
  instanceId: config.instanceId,
  ...sessions.stats(),
}));

app.use('/auth', require('./routes/auth'));
app.use('/ai', require('./routes/ai')({ ai }));
app.use('/run', require('./routes/execute')({ exec }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const wsDeps = {
  sessions,
  redis,
  instanceId: config.instanceId,
  jwtVerify: config.authRequired ? auth.verify : null,
};

wss.on('connection', (ws, req) => {
  attachSocketHandlers({ ws, req, deps: wsDeps });
});

server.listen(config.port, () => {
  logger.info(`backend listening on :${config.port} instance=${config.instanceId}`);
});

// Graceful shutdown — drain WS, close Redis.
async function shutdown(signal) {
  logger.info(`received ${signal}, shutting down`);
  wss.clients.forEach((c) => c.close(1001, 'server_shutdown'));
  server.close();
  await redis.close().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
