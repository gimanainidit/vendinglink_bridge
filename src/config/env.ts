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
  // Suppliers
  // @deprecated Use dynamic DB Supplier entries instead. Retained for backward compatibility fallback.
  SUPPLIER_RZK_BASE_URL: z.string().url().optional(),
  SUPPLIER_RZK_API_KEY: z.string().optional(),
  SUPPLIER_PDA_BASE_URL: z.string().url().default('https://prime-digital-ai.com'),
  SUPPLIER_PDA_API_KEY: z.string().optional(),
  // DAI (Digital AI Store)
  SUPPLIER_DAI_BASE_URL: z.string().url().default('http://43.156.46.152:8000'),
  SUPPLIER_DAI_API_KEY: z.string().optional(),
  // Backup & DR (BR-8)
  BACKUP_RCLONE_REMOTE: z.string().optional(),
  BACKUP_ENCRYPTION_KEY: z.string().optional(),
  // Agentic Purchasing Guardrails (P2a)
  AGENT_ENABLED: z.coerce.boolean().default(true),
  AGENT_MAX_SPEND_PER_REQUEST: z.coerce.number().default(500000),
  AGENT_MAX_SPEND_PER_DAY: z.coerce.number().default(5000000),
  AGENT_MIN_BALANCE_FLOOR: z.coerce.number().default(200000),
  AGENT_PRICE_DELTA_ALERT_PCT: z.coerce.number().default(20),
  AGENT_ALLOWED_SUPPLIER_CODES: z.string().default('RZK,PDA,DAI'),
  AGENT_HIGH_VALUE_THRESHOLD: z.coerce.number().default(1000000),
  // Hermes Agent Runner Integration (P2b / Localhost)
  HERMES_API_SECRET: z.string().default('hermes-local-secret-change-in-prod'),
});

// Normalize environment aliases for DAI
if (!process.env.SUPPLIER_DAI_BASE_URL && process.env.SUPLIER_DAI_BASE_URL) {
  process.env.SUPPLIER_DAI_BASE_URL = process.env.SUPLIER_DAI_BASE_URL;
}
if (!process.env.SUPPLIER_DAI_API_KEY && process.env.DAI_API_KEY) {
  process.env.SUPPLIER_DAI_API_KEY = process.env.DAI_API_KEY;
}

export const env = envSchema.parse(process.env);
