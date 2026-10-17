import { logger } from '../lib/logger';

export interface SanitizedSupplierSpec {
  code: string;
  displayName: string;
  baseUrl: string;
  authType: string;
  sanitizedCredentials: Record<string, any> | string;
  sanitizedDescriptor: Record<string, any>;
  redactedFieldCount: number;
}

const SENSITIVE_KEY_REGEX = /(api[_-]?key|secret|token|password|auth|signature|private[_-]?key|bearer|credential)/i;
const SENSITIVE_VALUE_REGEX = /(Bearer\s+[A-Za-z0-9._~+/-]+=*)|([A-Za-z0-9_-]{24,})|(ghp_[A-Za-z0-9_]{30,})|(sk-[A-Za-z0-9_-]{20,})/g;

export const credentialSanitizer = {
  /**
   * Deeply sanitizes credentials by replacing all secret values with mock placeholders.
   */
  sanitizeCredentials(credentials: any): { sanitized: any; redactedCount: number } {
    let redactedCount = 0;

    if (!credentials) {
      return { sanitized: {}, redactedCount: 0 };
    }

    if (typeof credentials === 'string') {
      try {
        const parsed = JSON.parse(credentials);
        const res = this.sanitizeObject(parsed);
        return { sanitized: res.sanitized, redactedCount: res.redactedCount };
      } catch {
        return { sanitized: '<MOCK_SECRET_CREDENTIAL>', redactedCount: 1 };
      }
    }

    if (typeof credentials === 'object') {
      return this.sanitizeObject(credentials);
    }

    return { sanitized: '<MOCK_SECRET>', redactedCount: 1 };
  },

  sanitizeObject(obj: Record<string, any>): { sanitized: Record<string, any>; redactedCount: number } {
    const result: Record<string, any> = {};
    let redactedCount = 0;

    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        if (/api[_-]?key/i.test(key)) {
          result[key] = '<MOCK_API_KEY>';
        } else if (/password/i.test(key)) {
          result[key] = '<MOCK_PASSWORD>';
        } else if (/bearer|token/i.test(key)) {
          result[key] = '<MOCK_BEARER_TOKEN>';
        } else {
          result[key] = '<MOCK_SECRET>';
        }
        redactedCount++;
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = this.sanitizeObject(value);
        result[key] = nested.sanitized;
        redactedCount += nested.redactedCount;
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) => {
          if (typeof item === 'object' && item !== null) {
            const nested = this.sanitizeObject(item);
            redactedCount += nested.redactedCount;
            return nested.sanitized;
          }
          if (typeof item === 'string' && SENSITIVE_VALUE_REGEX.test(item)) {
            redactedCount++;
            return '<MOCK_SECRET>';
          }
          return item;
        });
      } else if (typeof value === 'string' && SENSITIVE_VALUE_REGEX.test(value)) {
        result[key] = '<MOCK_SECRET>';
        redactedCount++;
      } else {
        result[key] = value;
      }
    }

    return { sanitized: result, redactedCount };
  },

  /**
   * Sanitizes a supplier descriptor (JSON or string).
   */
  sanitizeDescriptor(descriptor: any): { sanitized: Record<string, any>; redactedCount: number } {
    let parsed: Record<string, any> = {};
    if (typeof descriptor === 'string') {
      try {
        parsed = JSON.parse(descriptor);
      } catch {
        parsed = { raw: descriptor };
      }
    } else if (typeof descriptor === 'object' && descriptor !== null) {
      parsed = descriptor;
    }

    return this.sanitizeObject(parsed);
  },

  /**
   * Produces a fully redacted, safe supplier spec for LLM code generation.
   */
  buildSanitizedSpec(supplier: {
    code: string;
    displayName: string;
    baseUrl: string;
    authType: string;
    descriptor: any;
    credentials?: any;
  }): SanitizedSupplierSpec {
    const credRes = this.sanitizeCredentials(supplier.credentials);
    const descRes = this.sanitizeDescriptor(supplier.descriptor);
    const totalRedacted = credRes.redactedCount + descRes.redactedCount;

    logger.info(
      { code: supplier.code, redactedCount: totalRedacted },
      'Sanitized supplier credentials and descriptor for agentic pipeline'
    );

    return {
      code: supplier.code,
      displayName: supplier.displayName,
      baseUrl: supplier.baseUrl,
      authType: supplier.authType,
      sanitizedCredentials: credRes.sanitized,
      sanitizedDescriptor: descRes.sanitized,
      redactedFieldCount: totalRedacted,
    };
  },
};
