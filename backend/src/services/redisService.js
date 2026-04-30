/**
 * RedisService
 *
 * Two roles:
 *   1. Pub/Sub fanout of ops across Node.js instances.
 *      Channel naming: room:{sessionId} for ops, presence:{sessionId} for joins/leaves.
 *   2. Persistence of session state:
 *      - snapshot:{sessionId} -> JSON {text, rev}  (TTL 24h)
 *      - oplog:{sessionId}    -> Redis LIST of recent ops (capped via LTRIM)
 *
 * Two clients are required: one for SUBSCRIBE (which puts the conn in
 * subscriber mode and can't issue normal commands), one for everything else.
 *
 * Reconnection: ioredis handles this automatically with exponential backoff.
 * On reconnect, all our subscribed channels are re-subscribed via the
 * 'reconnecting' event handler.
 */

const Redis = require('ioredis');
const { logger } = require('../utils/logger');

class RedisService {
  constructor({ url } = {}) {
    const redisUrl = url || process.env.REDIS_URL || 'redis://localhost:6379';
    this.pub = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.channelHandlers = new Map(); // channel -> Set<handler>

    this.sub.on('message', (channel, raw) => {
      const handlers = this.channelHandlers.get(channel);
      if (!handlers) return;
      let msg;
      try { msg = JSON.parse(raw); }
      catch { logger.warn(`Bad JSON on ${channel}: ${raw}`); return; }
      for (const h of handlers) {
        try { h(msg, channel); }
        catch (e) { logger.error(`Handler error on ${channel}: ${e.message}`); }
      }
    });

    this.sub.on('reconnecting', () => logger.warn('[Redis] sub reconnecting...'));
    this.pub.on('error', (e) => logger.error(`[Redis pub] ${e.message}`));
    this.sub.on('error', (e) => logger.error(`[Redis sub] ${e.message}`));
  }

  // --- Pub/Sub -----------------------------------------------------------

  async subscribe(channel, handler) {
    let set = this.channelHandlers.get(channel);
    if (!set) {
      set = new Set();
      this.channelHandlers.set(channel, set);
      await this.sub.subscribe(channel);
    }
    set.add(handler);
  }

  async unsubscribe(channel, handler) {
    const set = this.channelHandlers.get(channel);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.channelHandlers.delete(channel);
      await this.sub.unsubscribe(channel);
    }
  }

  async publish(channel, message) {
    await this.pub.publish(channel, JSON.stringify(message));
  }

  // --- Persistence -------------------------------------------------------

  async saveSnapshot(sessionId, snapshot) {
    const key = `snapshot:${sessionId}`;
    await this.pub.set(key, JSON.stringify(snapshot), 'EX', 60 * 60 * 24);
  }

  async loadSnapshot(sessionId) {
    const raw = await this.pub.get(`snapshot:${sessionId}`);
    return raw ? JSON.parse(raw) : null;
  }

  async appendOpLog(sessionId, op, capLength = 5000) {
    const key = `oplog:${sessionId}`;
    const pipeline = this.pub.pipeline();
    pipeline.rpush(key, JSON.stringify(op));
    pipeline.ltrim(key, -capLength, -1);
    pipeline.expire(key, 60 * 60 * 24);
    await pipeline.exec();
  }

  async getOpLog(sessionId, sinceIdx = 0) {
    const items = await this.pub.lrange(`oplog:${sessionId}`, sinceIdx, -1);
    return items.map(s => JSON.parse(s));
  }

  // --- Cluster-wide presence (sets) --------------------------------------

  async addPresence(sessionId, userId) {
    await this.pub.sadd(`presence:${sessionId}`, userId);
    await this.pub.expire(`presence:${sessionId}`, 60 * 60);
  }
  async removePresence(sessionId, userId) {
    await this.pub.srem(`presence:${sessionId}`, userId);
  }
  async getPresence(sessionId) {
    return await this.pub.smembers(`presence:${sessionId}`);
  }

  async close() {
    await this.pub.quit();
    await this.sub.quit();
  }
}

module.exports = { RedisService };
