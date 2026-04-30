// Tiny structured logger. In production swap for pino/winston.
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = levels[process.env.LOG_LEVEL || 'info'] || 20;

function emit(level, msg) {
  if (levels[level] < minLevel) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg });
  if (level === 'error') console.error(line);
  else console.log(line);
}

const logger = {
  debug: (m) => emit('debug', m),
  info:  (m) => emit('info', m),
  warn:  (m) => emit('warn', m),
  error: (m) => emit('error', m),
};

module.exports = { logger };
