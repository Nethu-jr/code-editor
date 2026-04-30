module.exports = {
  port: parseInt(process.env.PORT || '4000', 10),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  execEngineUrl: process.env.EXEC_ENGINE_URL || 'http://localhost:7000',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  aiProvider: process.env.AI_PROVIDER || 'openai',
  aiModel: process.env.AI_MODEL,
  authRequired: process.env.AUTH_REQUIRED === 'true',
  // Stable per-process id used to filter Redis Pub/Sub echoes.
  instanceId: process.env.INSTANCE_ID || `node-${process.pid}-${Date.now().toString(36)}`,
};
