import IORedis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../lib/logger';

// Max retries per request is null as recommended by BullMQ
export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redisConnection.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

redisConnection.on('ready', () => {
  logger.info('Connected to Redis');
});
