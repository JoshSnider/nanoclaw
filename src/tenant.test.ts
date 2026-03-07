import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTenant,
  getTenant,
  linkTenantIdentity,
  updateTenant,
} from './db.js';
import {
  checkRateLimit,
  getTenantApiKey,
  isOperatorTenant,
  recordUsage,
  resolveTenant,
  setTenantApiKey,
} from './tenant.js';

// We need to control the encryption key. Since readEnvFile is called at
// import time by config.ts, we mock it at module level and use a shared
// reference that's available before any imports run.
const encryptionKeyHolder: { value: string } = { value: '' };

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    for (const k of keys) {
      if (k === 'TENANT_ENCRYPTION_KEY' && encryptionKeyHolder.value) {
        result[k] = encryptionKeyHolder.value;
      }
    }
    return result;
  }),
}));

beforeEach(() => {
  _initTestDatabase();
  encryptionKeyHolder.value = '';
});

describe('resolveTenant', () => {
  it('creates a new tenant for unknown sender when auto-create is enabled', () => {
    const tenantId = resolveTenant('15551234567@s.whatsapp.net', 'whatsapp');
    expect(tenantId).toBeTruthy();
    expect(tenantId).not.toBe('default');

    const tenant = getTenant(tenantId!);
    expect(tenant).toBeDefined();
    expect(tenant!.status).toBe('active');
    expect(tenant!.display_name).toContain('5551234567');
  });

  it('returns existing tenant for known sender', () => {
    const id1 = resolveTenant('15551234567@s.whatsapp.net', 'whatsapp');
    const id2 = resolveTenant('15551234567@s.whatsapp.net', 'whatsapp');
    expect(id1).toBe(id2);
  });

  it('returns null for inactive tenant', () => {
    const id = resolveTenant('user@s.whatsapp.net', 'whatsapp');
    expect(id).toBeTruthy();

    updateTenant(id!, { status: 'suspended' });

    const id2 = resolveTenant('user@s.whatsapp.net', 'whatsapp');
    expect(id2).toBeNull();
  });

  it('links multiple identities to same tenant', () => {
    const id = resolveTenant('user1@s.whatsapp.net', 'whatsapp');
    expect(id).toBeTruthy();

    linkTenantIdentity('tg:12345', 'telegram', id!);

    const id2 = resolveTenant('tg:12345', 'telegram');
    expect(id2).toBe(id);
  });
});

describe('isOperatorTenant', () => {
  it('returns true for default tenant', () => {
    expect(isOperatorTenant('default')).toBe(true);
  });

  it('returns false for other tenants', () => {
    expect(isOperatorTenant('some-uuid')).toBe(false);
  });
});

describe('BYOK encryption', () => {
  const testKey = 'a'.repeat(64); // 32 bytes hex

  beforeEach(() => {
    encryptionKeyHolder.value = testKey;
  });

  it('encrypts and decrypts an API key', () => {
    const tenantId = resolveTenant('byok-user@s.whatsapp.net', 'whatsapp')!;
    const apiKey = 'sk-ant-test-key-12345';

    const stored = setTenantApiKey(tenantId, apiKey);
    expect(stored).toBe(true);

    const retrieved = getTenantApiKey(tenantId);
    expect(retrieved).toBe(apiKey);
  });

  it('returns null when no key is stored', () => {
    const tenantId = resolveTenant('no-key@s.whatsapp.net', 'whatsapp')!;
    const retrieved = getTenantApiKey(tenantId);
    expect(retrieved).toBeNull();
  });

  it('returns false when encryption key is not configured', () => {
    encryptionKeyHolder.value = '';
    const tenantId = resolveTenant('no-enc@s.whatsapp.net', 'whatsapp')!;
    const stored = setTenantApiKey(tenantId, 'sk-ant-test');
    expect(stored).toBe(false);
  });
});

describe('rate limiting', () => {
  it('allows operator tenant without limits', () => {
    const result = checkRateLimit('default');
    expect(result.allowed).toBe(true);
  });

  it('allows BYOK tenant without limits', () => {
    encryptionKeyHolder.value = 'a'.repeat(64);
    const tenantId = resolveTenant('byok@s.whatsapp.net', 'whatsapp')!;
    setTenantApiKey(tenantId, 'sk-ant-test');

    const result = checkRateLimit(tenantId);
    expect(result.allowed).toBe(true);
  });

  it('denies when daily limit is exceeded', () => {
    const tenantId = resolveTenant('limited@s.whatsapp.net', 'whatsapp')!;

    updateTenant(tenantId, { rate_limit_daily: 2 });

    recordUsage(tenantId);
    recordUsage(tenantId);

    const result = checkRateLimit(tenantId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily limit');
  });

  it('allows when under daily limit', () => {
    const tenantId = resolveTenant('under@s.whatsapp.net', 'whatsapp')!;
    recordUsage(tenantId);

    const result = checkRateLimit(tenantId);
    expect(result.allowed).toBe(true);
  });
});
