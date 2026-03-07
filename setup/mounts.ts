/**
 * Step: mounts — Write mount allowlist config file.
 * Replaces 07-configure-mounts.sh
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from '../src/logger.js';
import { isRoot } from './platform.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { empty: boolean; json: string } {
  let empty = false;
  let json = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--empty') empty = true;
    if (args[i] === '--json' && args[i + 1]) {
      json = args[i + 1];
      i++;
    }
  }
  return { empty, json };
}

export async function run(args: string[]): Promise<void> {
  const { empty, json } = parseArgs(args);
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.config', 'nanoclaw');
  const configFile = path.join(configDir, 'mount-allowlist.json');

  if (isRoot()) {
    logger.warn(
      'Running as root — mount allowlist will be written to root home directory',
    );
  }

  fs.mkdirSync(configDir, { recursive: true });

  let allowedRoots = 0;

  if (empty) {
    logger.info('Writing empty mount allowlist');
    const emptyConfig = {
      allowedRoots: [],
      blockedPatterns: [],
    };
    fs.writeFileSync(configFile, JSON.stringify(emptyConfig, null, 2) + '\n');
  } else if (json) {
    // Validate JSON with JSON.parse (not piped through shell)
    let parsed: { allowedRoots?: unknown[] };
    try {
      parsed = JSON.parse(json);
    } catch {
      logger.error('Invalid JSON input');
      emitStatus('CONFIGURE_MOUNTS', {
        PATH: configFile,
        ALLOWED_ROOTS: 0,
        STATUS: 'failed',
        ERROR: 'invalid_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
      return; // unreachable but satisfies TS
    }

    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2) + '\n');
    allowedRoots = Array.isArray(parsed.allowedRoots)
      ? parsed.allowedRoots.length
      : 0;
  } else {
    // Read from stdin
    logger.info('Reading mount allowlist from stdin');
    const input = fs.readFileSync(0, 'utf-8');
    let parsed: { allowedRoots?: unknown[] };
    try {
      parsed = JSON.parse(input);
    } catch {
      logger.error('Invalid JSON from stdin');
      emitStatus('CONFIGURE_MOUNTS', {
        PATH: configFile,
        ALLOWED_ROOTS: 0,
        STATUS: 'failed',
        ERROR: 'invalid_json',
        LOG: 'logs/setup.log',
      });
      process.exit(4);
      return;
    }

    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2) + '\n');
    allowedRoots = Array.isArray(parsed.allowedRoots)
      ? parsed.allowedRoots.length
      : 0;
  }

  logger.info(
    { configFile, allowedRoots },
    'Allowlist configured',
  );

  emitStatus('CONFIGURE_MOUNTS', {
    PATH: configFile,
    ALLOWED_ROOTS: allowedRoots,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
