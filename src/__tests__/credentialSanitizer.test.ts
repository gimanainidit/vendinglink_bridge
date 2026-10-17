import { describe, it, expect } from 'vitest';
import { credentialSanitizer } from '../services/credentialSanitizer';

describe('Credential Sanitizer Layer (BR-P2b-6)', () => {
  it('masks secret keys in credentials object with mock placeholders', () => {
    const rawCredentials = {
      apiKey: 'sk-test-live-secret-key-1234567890abcdef',
      api_secret: 'super_secret_token_value_xyz999',
      merchantPassword: 'p@ssw0rd123Secure!',
      bearerToken: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
      subAccountId: 'sub_acc_101', // harmless field
      environment: 'production',
    };

    const { sanitized, redactedCount } = credentialSanitizer.sanitizeCredentials(rawCredentials);

    expect(sanitized.apiKey).toBe('<MOCK_API_KEY>');
    expect(sanitized.api_secret).toBe('<MOCK_SECRET>');
    expect(sanitized.merchantPassword).toBe('<MOCK_PASSWORD>');
    expect(sanitized.bearerToken).toBe('<MOCK_BEARER_TOKEN>');
    expect(sanitized.subAccountId).toBe('sub_acc_101');
    expect(sanitized.environment).toBe('production');
    expect(redactedCount).toBe(4);
  });

  it('masks JSON string credentials safely', () => {
    const jsonStr = JSON.stringify({
      token: 'secret-token-xyz-1234567890abcdef',
      username: 'partner_test',
    });

    const { sanitized, redactedCount } = credentialSanitizer.sanitizeCredentials(jsonStr);
    expect(sanitized.token).toBe('<MOCK_BEARER_TOKEN>');
    expect(sanitized.username).toBe('partner_test');
    expect(redactedCount).toBe(1);
  });

  it('masks sensitive headers in descriptor object', () => {
    const descriptor = {
      headers: {
        'X-API-Key': 'sk-ant-live-real-secret-token-123456789',
        'User-Agent': 'VendingLink/1.0',
      },
      auth: {
        type: 'API_KEY',
        headerName: 'X-API-Key',
      },
      endpoints: {
        balance: { path: '/v1/balance' },
      },
    };

    const { sanitized, redactedCount } = credentialSanitizer.sanitizeDescriptor(descriptor);
    expect(sanitized.headers['X-API-Key']).toBe('<MOCK_API_KEY>');
    expect(sanitized.headers['User-Agent']).toBe('VendingLink/1.0');
    expect(redactedCount).toBeGreaterThan(0);
  });

  it('builds a complete sanitized spec ready for LLM code generation', () => {
    const spec = credentialSanitizer.buildSanitizedSpec({
      code: 'TEST_SUPP',
      displayName: 'Test Supplier International',
      baseUrl: 'https://api.test-supplier.com',
      authType: 'API_KEY',
      credentials: {
        api_key: 'live_secret_12345678901234567890',
      },
      descriptor: {
        endpoints: {
          balance: { path: '/account/balance' },
          products: { path: '/items/list' },
        },
      },
    });

    expect(spec.code).toBe('TEST_SUPP');
    expect(spec.displayName).toBe('Test Supplier International');
    expect((spec.sanitizedCredentials as any).api_key).toBe('<MOCK_API_KEY>');
    expect(spec.redactedFieldCount).toBe(1);
    // Real secret should NOT be present in JSON output
    expect(JSON.stringify(spec)).not.toContain('live_secret_12345678901234567890');
  });
});
