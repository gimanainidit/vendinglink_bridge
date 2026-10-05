import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  PUBLIC_BASE_URL: z.string().url(),
  BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(1),
  ADMIN_TELEGRAM_ID: z.string().min(1),
  DATABASE_PROVIDER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url(),
  VENDINGLINK_URL: z.string().url(),
  BRIDGE_SECRET_KEY: z.string().min(1),
  KEYS_ENCRYPTION_KEY: z.string().min(1),
  MAX_BUY_QTY: z.coerce.number().int().min(1).max(100).default(100),
  SUPPLIER_RZK_BASE_URL: z.string().url().optional(),
  SUPPLIER_RZK_API_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);
