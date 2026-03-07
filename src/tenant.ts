/**
 * Tenant Resolution & Management
 *
 * Maps sender identities (phone numbers, Telegram IDs, Slack users) to tenants.
 * Handles BYOK API key encryption, rate limiting, and usage tracking.
 */

import crypto from 'crypto';

import {
  DEFAULT_RATE_LIMIT_DAILY,
  DEFAULT_RATE_LIMIT_RPM,
  DEFAULT_TENANT_ID,
  TENANT_AUTO_CREATE,
} from './config.js';
import {
  createTenant,
  getTenant,
  getTenantUsageToday,
  incrementTenantUsage,
  linkTenantIdentity,
  lookupTenantByIdentity,
  updateTenant,
} from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// In-memory sliding window for RPM tracking
const rpmWindows = new Map<string, number[]>();

/**
 * Resolve a sender identity to a tenant ID.
 * Returns null if tenant not found and auto-create is disabled.
 */
export function resolveTenant(
  senderId: string,
  channel: string,
): string | null {
  // Check existing identity mapping
  const tenantId = lookupTenantByIdentity(senderId, channel);
  if (tenantId) {
    const tenant = getTenant(tenantId);
    if (tenant && tenant.status === 'active') return tenantId;
    if (tenant && tenant.status !== 'active') {
      logger.debug(
        { senderId, channel, tenantId, status: tenant.status },
        'Tenant not active, dropping message',
      );
      return null;
    }
  }

  if (!TENANT_AUTO_CREATE) return null;

  // Auto-create new tenant
  const newId = crypto.randomUUID();
  const displayName = deriveDisplayName(senderId, channel);

  createTenant({
    id: newId,
    display_name: displayName,
    rate_limit_rpm: DEFAULT_RATE_LIMIT_RPM,
    rate_limit_daily: DEFAULT_RATE_LIMIT_DAILY,
  });
  linkTenantIdentity(senderId, channel, newId);

  logger.info(
    { tenantId: newId, senderId, channel, displayName },
    'Auto-created tenant',
  );

  return newId;
}

function deriveDisplayName(senderId: string, channel: string): string {
  if (channel === 'whatsapp') {
    // "15551234567@s.whatsapp.net" → "User 5551234567"
    const num = senderId.replace(/@.*$/, '').replace(/^1/, '');
    return `User ${num}`;
  }
  if (channel === 'telegram') {
    return `Telegram ${senderId.replace(/^tg:/, '')}`;
  }
  if (channel === 'slack') {
    return `Slack ${senderId}`;
  }
  return `User ${senderId.slice(0, 20)}`;
}

// --- BYOK API Key Encryption ---

function getEncryptionKey(): Buffer | null {
  const env = readEnvFile(['TENANT_ENCRYPTION_KEY']);
  const hex = env.TENANT_ENCRYPTION_KEY;
  if (!hex) return null;
  return Buffer.from(hex, 'hex');
}

export function setTenantApiKey(
  tenantId: string,
  plaintextKey: string,
): boolean {
  const encKey = getEncryptionKey();
  if (!encKey) {
    logger.error('TENANT_ENCRYPTION_KEY not set — cannot store BYOK API keys');
    return false;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintextKey, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Store as iv:authTag:ciphertext (all hex)
  const stored = `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  updateTenant(tenantId, { anthropic_api_key_encrypted: stored });
  return true;
}

export function getTenantApiKey(tenantId: string): string | null {
  const tenant = getTenant(tenantId);
  if (!tenant?.anthropic_api_key_encrypted) return null;

  const encKey = getEncryptionKey();
  if (!encKey) return null;

  const [ivHex, authTagHex, ciphertextHex] =
    tenant.anthropic_api_key_encrypted.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) return null;

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encKey,
      Buffer.from(ivHex, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf-8');
  } catch (err) {
    logger.error({ tenantId, err }, 'Failed to decrypt tenant API key');
    return null;
  }
}

// --- Rate Limiting ---

export function checkRateLimit(tenantId: string): {
  allowed: boolean;
  reason?: string;
} {
  const tenant = getTenant(tenantId);
  if (!tenant) return { allowed: false, reason: 'Tenant not found' };

  // Operator tenant and BYOK tenants skip rate limits
  if (tenant.is_operator) return { allowed: true };
  if (tenant.anthropic_api_key_encrypted) return { allowed: true };

  // Check daily limit
  if (tenant.rate_limit_daily > 0) {
    const dailyCount = getTenantUsageToday(tenantId);
    if (dailyCount >= tenant.rate_limit_daily) {
      return {
        allowed: false,
        reason: `Daily limit reached (${tenant.rate_limit_daily} requests). Provide your own API key with \`set-api-key sk-ant-...\` for unlimited access.`,
      };
    }
  }

  // Check RPM (in-memory sliding window)
  if (tenant.rate_limit_rpm > 0) {
    const now = Date.now();
    const window = rpmWindows.get(tenantId) || [];
    const recent = window.filter((t) => now - t < 60_000);
    if (recent.length >= tenant.rate_limit_rpm) {
      return {
        allowed: false,
        reason: 'Rate limit exceeded. Please wait a moment.',
      };
    }
  }

  return { allowed: true };
}

export function recordUsage(tenantId: string): void {
  incrementTenantUsage(tenantId);

  // Update RPM window
  const now = Date.now();
  const window = rpmWindows.get(tenantId) || [];
  window.push(now);
  // Trim old entries
  const cutoff = now - 60_000;
  const trimmed = window.filter((t) => t >= cutoff);
  rpmWindows.set(tenantId, trimmed);
}

/**
 * Check if a tenant is the operator (default) tenant.
 */
export function isOperatorTenant(tenantId: string): boolean {
  return tenantId === DEFAULT_TENANT_ID;
}
