/**
 * Repo Manager for NanoClaw
 *
 * When a group mounts a git repository (or worktree), this module prepares
 * a self-contained local clone that is safe to mount into a container.
 *
 * Why clones instead of worktrees:
 *   - Worktrees use a .git *file* with an absolute Mac path — that path
 *     doesn't exist inside the container, so git commands fail.
 *   - Clones have a self-contained .git directory that works anywhere.
 *
 * Before each container run the clone is synced: fetch origin, reset to
 * origin/<branch>. Agents get a clean, up-to-date working copy and can
 * commit/push their own branches without affecting the host working tree.
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

/**
 * Detect if a path is a git repository or worktree.
 */
export function isGitRepo(hostPath: string): boolean {
  const dotGit = path.join(hostPath, '.git');
  return fs.existsSync(dotGit);
}

/**
 * Resolve the main working tree root, handling git worktrees.
 *
 * A worktree has .git as a *file* containing:
 *   gitdir: /abs/path/to/main/.git/worktrees/<name>
 *
 * Inside that worktrees/<name>/ directory, `commondir` points (relatively)
 * back to the main .git directory. The main working tree is its parent.
 */
function resolveMainWorkingTree(hostPath: string): string {
  const dotGit = path.join(hostPath, '.git');

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return hostPath;
  }

  if (stat.isDirectory()) {
    return hostPath; // Normal repo, nothing to resolve
  }

  // Worktree: .git is a file pointing to the worktree-specific git dir
  const content = fs.readFileSync(dotGit, 'utf-8').trim();
  const match = content.match(/^gitdir:\s*(.+)$/);
  if (!match) return hostPath;

  // Resolve relative gitdir paths (the spec allows them)
  const worktreeGitDir = path.resolve(path.dirname(dotGit), match[1].trim());

  // commondir inside the worktree git dir is a relative path to the main .git
  const commonDirFile = path.join(worktreeGitDir, 'commondir');
  if (fs.existsSync(commonDirFile)) {
    const commonDir = fs.readFileSync(commonDirFile, 'utf-8').trim();
    const mainGitDir = path.resolve(worktreeGitDir, commonDir);
    return path.dirname(mainGitDir); // parent of .git = working tree root
  }

  // Fallback: worktrees/<name> -> ../../.. = working tree root
  return path.resolve(worktreeGitDir, '../../..');
}

/**
 * Prepare a local clone of a git repo for mounting into a container.
 *
 * - First run: clones from the local repo path into data/repos/<group>/<name>/
 * - Subsequent runs: fetches from local origin, resets to origin/<branch>
 *
 * The clone has a self-contained .git directory and works correctly inside
 * the container without any path tricks.
 *
 * @param hostPath   - Host path to a git repo or worktree
 * @param groupFolder - Group this clone belongs to (for isolation)
 * @param repoName   - Name for the clone directory
 * @param branch     - Branch to track (default: 'main')
 * @returns          - Absolute path to the prepared clone
 */
export async function prepareRepoClone(
  hostPath: string,
  groupFolder: string,
  repoName: string,
  branch = 'main',
): Promise<string> {
  const cloneDir = path.join(DATA_DIR, 'repos', groupFolder, repoName);
  const repoRoot = resolveMainWorkingTree(hostPath);

  if (!fs.existsSync(path.join(cloneDir, '.git'))) {
    logger.info(
      { groupFolder, repoName, repoRoot, branch },
      'Cloning repo for container mount',
    );

    fs.mkdirSync(cloneDir, { recursive: true });

    // Clone from local path (not origin URL) to avoid SSH auth issues
    // when running as a launchd/systemd service without access to ssh-agent.
    // The clone still gets origin set to the local path; containers can
    // fetch/push to the real remote if needed.
    await execAsync(`git clone "${repoRoot}" "${cloneDir}"`);
    await execAsync(`git checkout "${branch}"`, { cwd: cloneDir });

    logger.info({ groupFolder, repoName, cloneDir }, 'Repo clone ready');
  } else {
    logger.info(
      { groupFolder, repoName, branch },
      'Syncing repo clone from origin',
    );

    await execAsync('git fetch origin', { cwd: cloneDir });
    // Ensure we're on the right branch before resetting
    await execAsync(`git checkout "${branch}"`, { cwd: cloneDir });
    await execAsync(`git reset --hard "origin/${branch}"`, { cwd: cloneDir });

    logger.info({ groupFolder, repoName }, 'Repo clone synced');
  }

  return cloneDir;
}
