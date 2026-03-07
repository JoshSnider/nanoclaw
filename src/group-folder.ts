import path from 'path';

import { DATA_DIR, DEFAULT_TENANT_ID, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global', '_tenants']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

/** Tenant IDs are UUIDs or 'default' — validate accordingly */
function assertValidTenantId(tenantId: string): void {
  if (
    tenantId !== DEFAULT_TENANT_ID &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      tenantId,
    )
  ) {
    throw new Error(`Invalid tenant ID "${tenantId}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

/**
 * Resolve group folder path: groups/{tenantId}/{folder}
 * Falls back to groups/{folder} for default tenant (backward compat).
 */
export function resolveGroupFolderPath(
  folder: string,
  tenantId: string = DEFAULT_TENANT_ID,
): string {
  assertValidGroupFolder(folder);
  assertValidTenantId(tenantId);
  const groupPath =
    tenantId === DEFAULT_TENANT_ID
      ? path.resolve(GROUPS_DIR, folder)
      : path.resolve(GROUPS_DIR, tenantId, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

/**
 * Resolve group IPC path: data/ipc/{tenantId}/{folder}
 * Falls back to data/ipc/{folder} for default tenant (backward compat).
 */
export function resolveGroupIpcPath(
  folder: string,
  tenantId: string = DEFAULT_TENANT_ID,
): string {
  assertValidGroupFolder(folder);
  assertValidTenantId(tenantId);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath =
    tenantId === DEFAULT_TENANT_ID
      ? path.resolve(ipcBaseDir, folder)
      : path.resolve(ipcBaseDir, tenantId, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
