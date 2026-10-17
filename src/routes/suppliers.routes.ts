import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../db';
import { encryptCredentials } from '../lib/crypto';
import { supplierFactory } from '../suppliers/SupplierFactory';
import { supplierValidationService } from '../services/supplierValidationService';
import { adapterBuildService } from '../services/adapterBuildService';
import { logger } from '../lib/logger';

export const suppliersRouter = Router();

// Middleware: Authenticate Bearer BRIDGE_SECRET_KEY
const authenticateBridgeSecret = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid Bearer token' });
  }

  const token = authHeader.slice(7).trim();
  if (token !== env.BRIDGE_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid secret key' });
  }

  next();
};

suppliersRouter.use(authenticateBridgeSecret);

const createSupplierSchema = z.object({
  code: z
    .string()
    .min(2)
    .max(20)
    .regex(/^[A-Za-z0-9_]+$/, 'code must be alphanumeric'),
  displayName: z.string().min(1, 'displayName is required'),
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  authType: z.enum(['API_KEY', 'BEARER', 'BASIC', 'CUSTOM']).default('API_KEY'),
  credentials: z.union([z.string(), z.record(z.string(), z.any())]),
  descriptor: z.union([z.string(), z.record(z.string(), z.any())]),
  validateImmediately: z.coerce.boolean().default(true),
});

const updateSupplierSchema = z.object({
  displayName: z.string().optional(),
  baseUrl: z.string().url().optional(),
  authType: z.enum(['API_KEY', 'BEARER', 'BASIC', 'CUSTOM']).optional(),
  credentials: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
  descriptor: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
  status: z.enum(['PENDING_VALIDATION', 'ACTIVE', 'PAUSED', 'DEPRECATED', 'NEEDS_REVIEW']).optional(),
});

/**
 * Format supplier for response, masking encrypted credentials.
 */
function sanitizeSupplier(sup: any) {
  let parsedDescriptor = sup.descriptor;
  if (typeof sup.descriptor === 'string') {
    try {
      parsedDescriptor = JSON.parse(sup.descriptor);
    } catch {
      parsedDescriptor = {};
    }
  }

  return {
    code: sup.code,
    displayName: sup.displayName,
    baseUrl: sup.baseUrl,
    authType: sup.authType,
    status: sup.status,
    descriptor: parsedDescriptor,
    credentialsMasked: '••••••••',
    lastError: sup.lastError,
    createdAt: sup.createdAt,
    updatedAt: sup.updatedAt,
  };
}

/**
 * GET /api/v1/suppliers
 * List all registered suppliers from DB plus built-in adapters.
 */
suppliersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const dbSuppliers = await prisma.supplier.findMany({
      orderBy: { createdAt: 'desc' },
    });

    const sanitized = dbSuppliers.map(sanitizeSupplier);

    // Also include built-in adapters summary
    const builtIns = [
      { code: 'RZK', displayName: 'Rezeki Shop', isBuiltIn: true },
      { code: 'PDA', displayName: 'Prime Digital', isBuiltIn: true },
      { code: 'DAI', displayName: 'Digital AI Store', isBuiltIn: true },
    ];

    res.status(200).json({
      suppliers: sanitized,
      builtIns,
    });
  } catch (err: any) {
    logger.error({ err }, 'Error listing suppliers');
    res.status(500).json({ error: 'Failed to list suppliers' });
  }
});

/**
 * GET /api/v1/suppliers/:code
 * Fetch single supplier detail + real-time balance if active.
 */
suppliersRouter.get('/:code', async (req: Request, res: Response) => {
  const code = String(req.params.code).toUpperCase();
  try {
    const sup = await prisma.supplier.findUnique({
      where: { code },
    });

    if (!sup) {
      return res.status(404).json({ error: `Supplier ${code} not found` });
    }

    const sanitized = sanitizeSupplier(sup);
    let currentBalance: number | null = null;

    if (sup.status === 'ACTIVE' && supplierFactory.hasAdapter(code)) {
      try {
        const adapter = supplierFactory.getAdapter(code);
        currentBalance = await adapter.getBalance();
      } catch {
        // Leave as null if transient balance call fails
      }
    }

    res.status(200).json({
      supplier: sanitized,
      currentBalance,
    });
  } catch (err: any) {
    logger.error({ err, code }, 'Error fetching supplier');
    res.status(500).json({ error: 'Failed to fetch supplier' });
  }
});

/**
 * POST /api/v1/suppliers
 * Register a new supplier.
 */
suppliersRouter.post('/', async (req: Request, res: Response) => {
  const parseResult = createSupplierSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: parseResult.error.flatten().fieldErrors,
    });
  }

  const { code: rawCode, displayName, baseUrl, authType, credentials, descriptor, validateImmediately } =
    parseResult.data;
  const code = rawCode.toUpperCase();

  try {
    const credentialsEnc = encryptCredentials(credentials);
    const descriptorStr = typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor);

    const supplier = await prisma.supplier.upsert({
      where: { code },
      update: {
        displayName,
        baseUrl,
        authType,
        credentialsEnc,
        descriptor: descriptorStr,
        status: 'PENDING_VALIDATION',
        lastError: null,
      },
      create: {
        code,
        displayName,
        baseUrl,
        authType,
        credentialsEnc,
        descriptor: descriptorStr,
        status: 'PENDING_VALIDATION',
      },
    });

    let validationResult = null;
    if (validateImmediately) {
      validationResult = await supplierValidationService.validateSupplier(code);
    }

    const reloaded = await prisma.supplier.findUnique({ where: { code } });
    const responseSupplier = sanitizeSupplier(reloaded || supplier);

    res.status(201).json({
      supplier: responseSupplier,
      validation: validationResult,
    });
  } catch (err: any) {
    logger.error({ err, code }, 'Error creating supplier');
    res.status(500).json({ error: `Failed to create supplier: ${err.message}` });
  }
});

/**
 * PATCH /api/v1/suppliers/:code
 * Update existing supplier details or status.
 */
suppliersRouter.patch('/:code', async (req: Request, res: Response) => {
  const code = String(req.params.code).toUpperCase();
  const parseResult = updateSupplierSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: parseResult.error.flatten().fieldErrors,
    });
  }

  const updateData: any = {};
  const { displayName, baseUrl, authType, credentials, descriptor, status } = parseResult.data;

  if (displayName) updateData.displayName = displayName;
  if (baseUrl) updateData.baseUrl = baseUrl;
  if (authType) updateData.authType = authType;
  if (status) updateData.status = status;
  if (credentials) updateData.credentialsEnc = encryptCredentials(credentials);
  if (descriptor) {
    updateData.descriptor = typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor);
  }

  try {
    const updated = await prisma.supplier.update({
      where: { code },
      data: updateData,
    });

    if (updated.status === 'ACTIVE') {
      supplierFactory.registerFromRecord(updated);
    } else {
      supplierFactory.unregister(code);
    }

    res.status(200).json({
      supplier: sanitizeSupplier(updated),
    });
  } catch (err: any) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: `Supplier ${code} not found` });
    }
    logger.error({ err, code }, 'Error updating supplier');
    res.status(500).json({ error: 'Failed to update supplier' });
  }
});

/**
 * POST /api/v1/suppliers/:code/validate
 * Trigger on-demand dry-run validation for a supplier.
 */
suppliersRouter.post('/:code/validate', async (req: Request, res: Response) => {
  const code = String(req.params.code).toUpperCase();
  try {
    const result = await supplierValidationService.validateSupplier(code);
    const updated = await prisma.supplier.findUnique({ where: { code } });

    res.status(200).json({
      supplier: updated ? sanitizeSupplier(updated) : null,
      validation: result,
    });
  } catch (err: any) {
    logger.error({ err, code }, 'Error validating supplier');
    res.status(500).json({ error: `Validation request failed: ${err.message}` });
  }
});

/**
 * POST /api/v1/suppliers/:code/build-adapter
 * Queue an autonomous adapter builder job for Hermes Agent runner (BR-P2b-6).
 */
suppliersRouter.post('/:code/build-adapter', async (req: Request, res: Response) => {
  const code = String(req.params.code).toUpperCase();
  try {
    const result = await adapterBuildService.createBuildJob(code);
    if (!result.queued) {
      return res.status(400).json({ error: result.reason || 'Could not queue build job' });
    }

    res.status(202).json({
      success: true,
      message: `Adapter build job for ${code} enqueued for Hermes`,
      job: result.job,
    });
  } catch (err: any) {
    logger.error({ err, code }, 'Error triggering adapter build job');
    res.status(500).json({ error: `Failed to queue build job: ${err.message}` });
  }
});

