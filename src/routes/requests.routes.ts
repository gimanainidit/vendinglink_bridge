import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { prisma } from '../db';
import { productSearchQueue, supplierOrderQueue } from '../queues/queues';
import { createPendingTransaction } from '../services/orchestrator';
import { logger } from '../lib/logger';

export const requestsRouter = Router();

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

requestsRouter.use(authenticateBridgeSecret);

const createProductRequestSchema = z.object({
  customerRef: z.string().min(1, 'customerRef is required'),
  query: z.string().min(1, 'query is required'),
  categorySlug: z.string().optional(),
  maxBudget: z.coerce.number().positive().optional(),
});

/**
 * POST /api/v1/requests
 * Inbound from Storefront when customer requests a product.
 */
requestsRouter.post('/', async (req: Request, res: Response) => {
  const idempotencyKey = (req.headers['idempotency-key'] as string) || req.body.idempotencyKey;
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Missing required Idempotency-Key header' });
  }

  const parsed = createProductRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation error', details: parsed.error.format() });
  }

  try {
    // 1. Idempotency Check
    const existing = await prisma.productRequest.findUnique({
      where: { idempotencyKey },
    });

    if (existing) {
      return res.status(200).json({
        requestId: existing.id,
        status: existing.status,
        query: existing.query,
        foundSupplierCode: existing.foundSupplierCode,
        foundProductId: existing.foundProductId,
        quotedPrice: existing.quotedPrice,
        rejectionReason: existing.rejectionReason,
      });
    }

    // 2. Persist ProductRequest in SEARCHING state
    const productRequest = await prisma.productRequest.create({
      data: {
        idempotencyKey,
        customerRef: parsed.data.customerRef,
        query: parsed.data.query,
        categorySlug: parsed.data.categorySlug,
        maxBudget: parsed.data.maxBudget,
        status: 'SEARCHING',
      },
    });

    // 3. Enqueue to BullMQ for asynchronous multi-supplier search
    await productSearchQueue.add(
      'search',
      { requestId: productRequest.id },
      { jobId: `req_${productRequest.id}` }
    );

    logger.info(
      { requestId: productRequest.id, query: parsed.data.query },
      'Received new ProductRequest from Storefront'
    );

    return res.status(202).json({
      requestId: productRequest.id,
      status: productRequest.status,
    });
  } catch (err: any) {
    logger.error({ err }, 'Error creating product request');
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

/**
 * GET /api/v1/requests/:id
 * Retrieve request status and quotation.
 */
requestsRouter.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const productRequest = await prisma.productRequest.findUnique({
      where: { id },
    });

    if (!productRequest) {
      return res.status(404).json({ error: 'ProductRequest not found' });
    }

    return res.status(200).json({
      requestId: productRequest.id,
      customerRef: productRequest.customerRef,
      status: productRequest.status,
      query: productRequest.query,
      categorySlug: productRequest.categorySlug,
      maxBudget: productRequest.maxBudget,
      foundSupplierCode: productRequest.foundSupplierCode,
      foundProductId: productRequest.foundProductId,
      quotedPrice: productRequest.quotedPrice,
      rejectionReason: productRequest.rejectionReason,
      transactionId: productRequest.transactionId,
      createdAt: productRequest.createdAt,
      updatedAt: productRequest.updatedAt,
    });
  } catch (err: any) {
    logger.error({ err }, 'Error retrieving product request');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/requests/:id/confirm
 * Customer confirmed quotation -> trigger immediate purchase.
 */
requestsRouter.post('/:id/confirm', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  try {
    const productRequest = await prisma.productRequest.findUnique({
      where: { id },
    });

    if (!productRequest) {
      return res.status(404).json({ error: 'ProductRequest not found' });
    }

    if (productRequest.status === 'CONFIRMED' || productRequest.status === 'PURCHASED') {
      return res.status(200).json({
        requestId: productRequest.id,
        status: productRequest.status,
        transactionId: productRequest.transactionId,
      });
    }

    if (productRequest.status !== 'FOUND') {
      return res.status(400).json({
        error: `Cannot confirm request in status '${productRequest.status}'. Only 'FOUND' requests can be confirmed.`,
      });
    }

    if (!productRequest.foundSupplierCode || !productRequest.foundProductId) {
      return res.status(400).json({
        error: 'ProductRequest does not have supplier or product details attached.',
      });
    }

    const adminChatId = env.ADMIN_TELEGRAM_ID.split(',')[0].trim();

    // 1. Create Transaction in Bridge DB
    const tx = await createPendingTransaction(
      productRequest.foundSupplierCode,
      productRequest.foundProductId,
      1,
      undefined,
      adminChatId
    );

    // 2. Mark ProductRequest as CONFIRMED
    await prisma.productRequest.update({
      where: { id: productRequest.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        transactionId: tx.transactionId,
      },
    });

    // 3. Enqueue order execution
    await supplierOrderQueue.add('order', { txId: tx.id }, { jobId: tx.transactionId });

    logger.info(
      { requestId: productRequest.id, transactionId: tx.transactionId },
      'ProductRequest confirmed and purchase order enqueued'
    );

    return res.status(200).json({
      requestId: productRequest.id,
      status: 'CONFIRMED',
      transactionId: tx.transactionId,
    });
  } catch (err: any) {
    logger.error({ err }, 'Error confirming product request');
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});
