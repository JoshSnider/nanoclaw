import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: '/mock/mount-allowlist.json',
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => '{}'),
      realpathSync: vi.fn((p: string) => p),
    },
  };
});

import fs from 'fs';
import {
  loadMountAllowlist,
  validateMount,
  _resetAllowlistCache,
} from './mount-security.js';

beforeEach(() => {
  _resetAllowlistCache();
  vi.mocked(fs.existsSync).mockReturnValue(true);
});

describe('loadMountAllowlist', () => {
  it('loads minimal allowlist (only allowedRoots)', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        allowedRoots: [
          { path: '/Users/josh/max', allowReadWrite: true },
        ],
      }),
    );

    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
    // blockedPatterns should default to the built-in defaults
    expect(result!.blockedPatterns.length).toBeGreaterThan(0);
    expect(result!.blockedPatterns).toContain('.ssh');
  });

  it('loads allowlist with explicit blockedPatterns', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        allowedRoots: [{ path: '/projects', allowReadWrite: true }],
        blockedPatterns: ['custom-secret'],
      }),
    );

    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.blockedPatterns).toContain('custom-secret');
    expect(result!.blockedPatterns).toContain('.ssh'); // merged with defaults
  });

  it('rejects allowlist with missing allowedRoots', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null when file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('not json');

    const result = loadMountAllowlist();
    expect(result).toBeNull();
  });
});

describe('validateMount', () => {
  beforeEach(() => {
    // Set up a valid allowlist
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        allowedRoots: [
          { path: '/Users/josh/max', allowReadWrite: true },
          { path: '/Users/josh/docs', allowReadWrite: false },
        ],
      }),
    );
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.realpathSync).mockImplementation((p) => p as string);
  });

  it('allows mount under allowed root', () => {
    const result = validateMount(
      { hostPath: '/Users/josh/max/src', readonly: false },
      true,
    );
    expect(result.allowed).toBe(true);
  });

  it('rejects mount outside allowed roots', () => {
    const result = validateMount(
      { hostPath: '/Users/josh/secret-stuff' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not under any allowed root');
  });

  it('rejects mount matching blocked pattern', () => {
    const result = validateMount(
      { hostPath: '/Users/josh/max/.ssh/keys' },
      true,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.ssh');
  });

  it('forces read-only when root disallows read-write', () => {
    const result = validateMount(
      { hostPath: '/Users/josh/docs/file.txt', readonly: false },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('allows read-write when root permits it', () => {
    const result = validateMount(
      { hostPath: '/Users/josh/max/src', readonly: false },
      true,
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });
});
