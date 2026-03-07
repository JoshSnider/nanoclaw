import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isValidGroupFolder,
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from './group-folder.js';

describe('group folder validation', () => {
  it('accepts normal group folder names', () => {
    expect(isValidGroupFolder('main')).toBe(true);
    expect(isValidGroupFolder('family-chat')).toBe(true);
    expect(isValidGroupFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidGroupFolder('../../etc')).toBe(false);
    expect(isValidGroupFolder('/tmp')).toBe(false);
    expect(isValidGroupFolder('global')).toBe(false);
    expect(isValidGroupFolder('_tenants')).toBe(false);
    expect(isValidGroupFolder('')).toBe(false);
  });

  it('resolves safe paths under groups directory', () => {
    const resolved = resolveGroupFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveGroupIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveGroupFolderPath('../../etc')).toThrow();
    expect(() => resolveGroupIpcPath('/tmp')).toThrow();
  });

  it('resolves tenant-scoped group paths', () => {
    const tenantId = '12345678-1234-1234-1234-123456789abc';
    const resolved = resolveGroupFolderPath('my-group', tenantId);
    expect(resolved).toContain(tenantId);
    expect(resolved).toContain('my-group');
  });

  it('resolves tenant-scoped IPC paths', () => {
    const tenantId = '12345678-1234-1234-1234-123456789abc';
    const resolved = resolveGroupIpcPath('my-group', tenantId);
    expect(resolved).toContain(tenantId);
    expect(resolved).toContain('my-group');
  });

  it('default tenant uses flat path (backward compat)', () => {
    const resolved = resolveGroupFolderPath('my-group', 'default');
    expect(resolved.endsWith(`${path.sep}groups${path.sep}my-group`)).toBe(
      true,
    );
    // No 'default' segment in path
    expect(resolved).not.toContain(`${path.sep}default${path.sep}`);
  });

  it('throws for invalid tenant ID', () => {
    expect(() => resolveGroupFolderPath('my-group', 'bad-tenant')).toThrow();
    expect(() => resolveGroupIpcPath('my-group', '../escape')).toThrow();
  });
});
