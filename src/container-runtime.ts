/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/**
 * Handle containers from previous runs.
 * Recent containers (< 1 hour) are left alone — they'll finish via their
 * own idle/hard timeouts and --rm cleans them up. Only truly stale
 * containers (hours+) are stopped as they likely leaked from a crash.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}\t{{.RunningFor}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const lines = output.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return;

    const stale: string[] = [];
    const active: string[] = [];

    for (const line of lines) {
      const [name, runningFor] = line.split('\t');
      if (!name) continue;
      // Docker formats duration as "X hours", "X minutes", "X seconds", etc.
      const isStale = /hours|days|weeks|months/.test(runningFor || '');
      if (isStale) {
        stale.push(name);
      } else {
        active.push(name);
      }
    }

    if (active.length > 0) {
      logger.info(
        { count: active.length, names: active },
        'Found running containers from previous process, letting them finish',
      );
    }

    for (const name of stale) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (stale.length > 0) {
      logger.info(
        { count: stale.length, names: stale },
        'Stopped stale orphaned containers (running > 1 hour)',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to check for orphaned containers');
  }
}
