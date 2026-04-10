const Redis = require('ioredis');
const logger = require('./logger');

const TTL = 600; // 10 minutes

let redis = null;

function getRedis() {
  if (!redis) {
    redis = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
    redis.on('error', (e) => logger.warn('Redis error', { error: e.message }));
  }
  return redis;
}

async function get(projectId) {
  try {
    const val = await getRedis().get(`project_ctx:${projectId}`);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

async function set(projectId, context) {
  try {
    await getRedis().set(`project_ctx:${projectId}`, JSON.stringify(context), 'EX', TTL);
  } catch {
    // Redis unavailable — continue without caching
  }
}

async function invalidate(projectId) {
  try {
    await getRedis().del(`project_ctx:${projectId}`);
    await getRedis().del(`route_map:${projectId}`);
  } catch {}
}

// Generic raw key access (for route maps etc.)
async function getRaw(key) {
  try {
    const val = await getRedis().get(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

async function setRaw(key, value, ttl = TTL) {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', ttl);
  } catch {}
}

module.exports = { get, set, invalidate, getRaw, setRaw };
