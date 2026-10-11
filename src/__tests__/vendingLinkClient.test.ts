import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { deliverToVendingLink, VendingLinkDeliveryError } from '../vendinglink/vendingLinkClient';
import * as transactionService from '../services/transactionService';

vi.mock('axios');
vi.mock('../services/transactionService', () => ({
  appendLog: vi.fn().mockResolvedValue(undefined),
}));

describe('vendingLinkClient - deliverToVendingLink', () => {
  const transactionId = 'BRG-20261011-TEST01';
  const supplierCode = 'RZK';
  const supplierProductId = 'loc_test1';
  const vlProductId = 'vl-product-123';
  const qty = 2;
  const items = ['KEY-123-ABC', 'KEY-456-DEF'];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delivers successfully when storefront returns 201 Created', async () => {
    const mockSuccessResponse = {
      status: 201,
      message: 'Top-up successful',
      transaction_id: transactionId,
      product_id: vlProductId,
      inserted: 2,
      skipped: 0,
    };

    (axios.post as any).mockResolvedValueOnce({
      status: 201,
      data: mockSuccessResponse,
    });

    const result = await deliverToVendingLink(
      transactionId,
      supplierCode,
      supplierProductId,
      vlProductId,
      qty,
      items
    );

    expect(result).toEqual(mockSuccessResponse);
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/api/bridge/webhook/stock/topup'),
      expect.objectContaining({
        transaction_id: transactionId,
        product_id: vlProductId,
        supplier_code: supplierCode,
        supplier_product_id: supplierProductId,
        added_qty: qty,
        items,
        source: 'BRIDGE_BOT',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'Idempotency-Key': transactionId,
          Authorization: expect.stringContaining('Bearer '),
        }),
        timeout: 10000,
      })
    );

    expect(transactionService.appendLog).toHaveBeenCalledWith(
      transactionId,
      'VENDING_REQ',
      expect.objectContaining({ items: '[REDACTED]' })
    );
    expect(transactionService.appendLog).toHaveBeenCalledWith(
      transactionId,
      'VENDING_RES',
      mockSuccessResponse,
      201,
      expect.any(Number)
    );
  });

  it('acknowledges delivery as success when 409 Conflict has existingEvent COMPLETED', async () => {
    const mock409Completed = {
      status: 409,
      message: 'Transaction already completed',
      existingEvent: {
        id: 'evt_123',
        status: 'COMPLETED',
      },
    };

    (axios.post as any).mockRejectedValueOnce({
      response: {
        status: 409,
        data: mock409Completed,
      },
    });

    const result = await deliverToVendingLink(
      transactionId,
      supplierCode,
      supplierProductId,
      vlProductId,
      qty,
      items
    );

    expect(result).toEqual(mock409Completed);
  });

  it('throws retryable VendingLinkDeliveryError when 409 Conflict has existingEvent PROCESSING', async () => {
    const mock409Processing = {
      status: 409,
      message: 'Transaction is already processing',
      existingEvent: {
        id: 'evt_123',
        status: 'PROCESSING',
      },
    };

    (axios.post as any).mockRejectedValueOnce({
      response: {
        status: 409,
        data: mock409Processing,
      },
    });

    try {
      await deliverToVendingLink(
        transactionId,
        supplierCode,
        supplierProductId,
        vlProductId,
        qty,
        items
      );
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VendingLinkDeliveryError);
      expect(err.isRetryable).toBe(true);
      expect(err.message).toContain('PROCESSING');
    }
  });

  it('throws non-retryable error on 400 Bad Request with sentinel [UNMAPPED]', async () => {
    const mock400Unmapped = {
      status: 400,
      code: 'PRODUCT_NOT_MAPPED',
      message: 'product_id is "[UNMAPPED]". Admin must map this product.',
    };

    (axios.post as any).mockRejectedValueOnce({
      response: {
        status: 400,
        data: mock400Unmapped,
      },
    });

    try {
      await deliverToVendingLink(
        transactionId,
        supplierCode,
        supplierProductId,
        '[UNMAPPED]',
        qty,
        items
      );
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VendingLinkDeliveryError);
      expect(err.isRetryable).toBe(false);
      expect(err.message).toContain('Non-retryable');
    }
  });

  it('throws non-retryable error on 401 Unauthorized / 403 Forbidden', async () => {
    (axios.post as any).mockRejectedValueOnce({
      response: {
        status: 401,
        data: { error: 'Unauthorized' },
      },
    });

    try {
      await deliverToVendingLink(
        transactionId,
        supplierCode,
        supplierProductId,
        vlProductId,
        qty,
        items
      );
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VendingLinkDeliveryError);
      expect(err.isRetryable).toBe(false);
    }
  });

  it('throws retryable error on 429 Too Many Requests', async () => {
    (axios.post as any).mockRejectedValueOnce({
      response: {
        status: 429,
        data: { error: 'Too Many Requests' },
      },
    });

    try {
      await deliverToVendingLink(
        transactionId,
        supplierCode,
        supplierProductId,
        vlProductId,
        qty,
        items
      );
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VendingLinkDeliveryError);
      expect(err.isRetryable).toBe(true);
    }
  });

  it('throws retryable error on 500 Internal Server Error or network failure', async () => {
    (axios.post as any).mockRejectedValueOnce({
      response: {
        status: 500,
        data: { error: 'Internal Server Error' },
      },
      message: 'Request failed with status code 500',
    });

    try {
      await deliverToVendingLink(
        transactionId,
        supplierCode,
        supplierProductId,
        vlProductId,
        qty,
        items
      );
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(VendingLinkDeliveryError);
      expect(err.isRetryable).toBe(true);
    }
  });
});
