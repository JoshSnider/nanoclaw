/**
 * MCP Skill Registry
 *
 * Handles operation requests from container skill MCP servers.
 * Containers write a skill_request IPC file; the host reads it here,
 * looks up the registered handler, runs it with stored credentials,
 * and writes the response back to ipc/{group}/responses/{reqId}.json.
 *
 * Two handler styles are supported:
 *
 * 1. Collocated handler.js (preferred, no build step):
 *    container/skills/{name}/handler.js — plain ESM file, exports a default
 *    object whose keys are operation names:
 *      export default { setup: async (params, ctx) => ..., list_foo: async ... }
 *    Loaded lazily on first use; drop the file and it works immediately.
 *
 * 2. Compiled TypeScript handlers (legacy / complex handlers):
 *    src/skill-handlers/{name}.ts → dist/skill-handlers/{name}.js
 *    Files call registerSkillHandler() on import. Require `npm run build`.
 *
 * Security: credentials never leave the host process. The container only
 * ever receives operation results.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DATA_DIR } from './config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { getSkillCredentials, setSkillCredential } from './db.js';
import {
  callMcpTool,
  connectMcpServer,
  disconnectMcpServer,
  getMcpTools,
  hasMcpClient,
  type McpServerConfig,
} from './mcp-clients.js';

export interface SkillOperationContext {
  groupFolder: string;
  /** Credentials previously stored for this skill (read from DB). */
  credentials: Record<string, string>;
  /** Store a credential for this skill. Use in setup operations. */
  setCredential: (key: string, value: string) => void;
}

export type SkillHandler = (
  params: Record<string, unknown>,
  ctx: SkillOperationContext,
) => Promise<unknown>;

const handlers: Map<string, SkillHandler> = new Map();

/** Directory where compiled TS skill handlers live. Set by loadSkillHandlers(). */
let compiledHandlersDir: string | null = null;

/** Root directory of the nanoclaw project (where container/skills/ lives). */
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * Register a handler for a skill operation.
 * Key format: "{skillName}.{operationName}" (e.g., "email.send")
 *
 * Called by legacy compiled handler modules. New-style handler.js files
 * don't call this directly — the loader auto-registers them.
 */
export function registerSkillHandler(
  skillName: string,
  operationName: string,
  handler: SkillHandler,
): void {
  const key = `${skillName}.${operationName}`;
  handlers.set(key, handler);
  logger.debug(
    { skill: skillName, operation: operationName },
    'Skill handler registered',
  );
}

/**
 * Read a skill's manifest.json to check for mcpServer config.
 */
function readSkillManifest(skillName: string): {
  mcpServer?: McpServerConfig;
  setup?: { credentials?: Record<string, { description: string }> };
} | null {
  const manifestPath = path.join(
    projectRoot,
    'container',
    'skills',
    skillName,
    'manifest.json',
  );
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Handle the setup operation for MCP-backed skills.
 * Stores credentials, then connects the MCP client.
 */
async function handleMcpSetup(
  skillName: string,
  params: Record<string, unknown>,
  groupFolder: string,
  mcpConfig: McpServerConfig,
): Promise<string> {
  // Store all provided params as credentials
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value) {
      setSkillCredential(groupFolder, skillName, key, value);
    }
  }

  // Connect the MCP server with the new credentials
  const credentials = getSkillCredentials(groupFolder, skillName);
  try {
    const tools = await connectMcpServer(skillName, mcpConfig, credentials);
    return `Credentials stored. Connected to MCP server — ${tools.length} tools available: ${tools.map((t) => t.name).join(', ')}`;
  } catch (err) {
    return `Credentials stored but MCP connection failed: ${err instanceof Error ? err.message : String(err)}. Check your credentials and try again.`;
  }
}

/**
 * Try to load a skill's handler.js (new style: collocated plain JS, no build needed)
 * or compiled dist/skill-handlers/{name}.js (legacy style).
 * Returns true if something was loaded.
 */
async function lazyLoadSkill(skillName: string): Promise<boolean> {
  // 1. New style: container/skills/{name}/handler.js — no build required
  const handlerJs = path.join(
    projectRoot,
    'container',
    'skills',
    skillName,
    'handler.js',
  );
  if (fs.existsSync(handlerJs)) {
    try {
      const mod = await import(handlerJs);
      const ops: Record<string, SkillHandler> = mod.default ?? mod;
      for (const [opName, fn] of Object.entries(ops)) {
        if (typeof fn === 'function') {
          registerSkillHandler(skillName, opName, fn as SkillHandler);
        }
      }
      logger.info({ skillName, handlerJs }, 'Loaded collocated handler.js');
      return true;
    } catch (err) {
      logger.error({ skillName, handlerJs, err }, 'Failed to load handler.js');
    }
  }

  // 2. Legacy style: dist/skill-handlers/{name}.js — needs npm run build
  if (compiledHandlersDir) {
    const compiledJs = path.join(compiledHandlersDir, `${skillName}.js`);
    if (fs.existsSync(compiledJs)) {
      try {
        await import(compiledJs);
        logger.info(
          { skillName, compiledJs },
          'Lazy-loaded compiled skill handler',
        );
        return true;
      } catch (err) {
        logger.error(
          { skillName, compiledJs, err },
          'Failed to load compiled skill handler',
        );
      }
    }
  }

  return false;
}

/**
 * Process a skill_request IPC message from a container.
 * Writes the result (or error) to ipc/{groupFolder}/responses/{requestId}.json.
 */
export async function processSkillRequest(
  groupFolder: string,
  skillName: string,
  operation: string,
  params: Record<string, unknown>,
  requestId: string,
): Promise<void> {
  const responsesDir = path.join(resolveGroupIpcPath(groupFolder), 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const responsePath = path.join(responsesDir, `${requestId}.json`);

  try {
    // Check if this skill has an MCP server config
    const manifest = readSkillManifest(skillName);
    const mcpConfig = manifest?.mcpServer;

    if (mcpConfig) {
      // MCP-backed skill
      if (operation === 'setup') {
        // Setup stores credentials and connects the MCP client
        const result = await handleMcpSetup(
          skillName,
          params,
          groupFolder,
          mcpConfig,
        );
        fs.writeFileSync(
          responsePath,
          JSON.stringify({ success: true, result }, null, 2),
        );
        logger.info(
          { groupFolder, skillName, operation },
          'MCP skill setup processed',
        );
        return;
      }

      // Ensure MCP client is connected (lazy connect on first tool call)
      if (!hasMcpClient(skillName)) {
        const credentials = getSkillCredentials(groupFolder, skillName);
        await connectMcpServer(skillName, mcpConfig, credentials);
      }

      // Forward to MCP server
      const result = await callMcpTool(skillName, operation, params);
      fs.writeFileSync(
        responsePath,
        JSON.stringify({ success: true, result }, null, 2),
      );
      logger.info(
        { groupFolder, skillName, operation },
        'MCP skill request proxied',
      );
      return;
    }

    // Mode 3: custom handler.js
    const key = `${skillName}.${operation}`;

    // Lazy-load handler if not yet registered
    if (!handlers.has(key)) {
      await lazyLoadSkill(skillName);
    }

    const handler = handlers.get(key);
    if (!handler) {
      logger.warn(
        { groupFolder, skillName, operation, key },
        'No handler registered for skill operation',
      );
      const response = {
        success: false,
        error: `No handler registered for ${key}. Has the skill been fully set up? Run /add-skill to configure it.`,
      };
      fs.writeFileSync(responsePath, JSON.stringify(response, null, 2));
      return;
    }

    const credentials = getSkillCredentials(groupFolder, skillName);
    const ctx: SkillOperationContext = {
      groupFolder,
      credentials,
      setCredential: (k, v) => setSkillCredential(groupFolder, skillName, k, v),
    };
    const result = await handler(params, ctx);
    fs.writeFileSync(
      responsePath,
      JSON.stringify({ success: true, result }, null, 2),
    );
    logger.info(
      { groupFolder, skillName, operation },
      'Skill request processed',
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { groupFolder, skillName, operation, err },
      'Skill handler error',
    );
    fs.writeFileSync(
      responsePath,
      JSON.stringify({ success: false, error: errorMsg }, null, 2),
    );
  }
}

/**
 * Connect MCP server for a skill and write discovered tools to the IPC directory.
 * Called on activate_skill and at container startup for active MCP-backed skills.
 */
export async function connectAndWriteMcpTools(
  skillName: string,
  groupFolder: string,
): Promise<void> {
  const manifest = readSkillManifest(skillName);
  if (!manifest?.mcpServer) return; // Not an MCP-backed skill

  const credentials = getSkillCredentials(groupFolder, skillName);

  // Need credentials to connect — skip if not yet configured
  const mcpConfig = manifest.mcpServer;
  const needsAuth =
    (mcpConfig.auth?.bearer && !credentials[mcpConfig.auth.bearer]) ||
    (mcpConfig.env &&
      Object.values(mcpConfig.env).some((credKey) => !credentials[credKey]));

  if (needsAuth) {
    logger.debug(
      { skillName },
      'Skipping MCP connection — credentials not yet configured',
    );
    return;
  }

  try {
    const tools = await connectMcpServer(skillName, mcpConfig, credentials);
    const toolsJson = JSON.stringify(tools, null, 2);

    // Write discovered tools to ALL group IPC dirs so any session can use them
    const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
    if (fs.existsSync(ipcBaseDir)) {
      for (const dir of fs.readdirSync(ipcBaseDir)) {
        const toolsDir = path.join(ipcBaseDir, dir, 'skill_tools');
        fs.mkdirSync(toolsDir, { recursive: true });
        fs.writeFileSync(path.join(toolsDir, `${skillName}.json`), toolsJson);
      }
    }

    logger.info(
      { skillName, toolCount: tools.length },
      'MCP tools discovered and written to all IPC dirs',
    );
  } catch (err) {
    logger.warn(
      { skillName, err },
      'Failed to connect MCP server for skill',
    );
  }
}

/**
 * Load legacy compiled skill handlers from dist/skill-handlers/*.js at startup.
 * Each file calls registerSkillHandler() on import.
 * New-style handler.js files don't need this — they're loaded lazily on demand.
 */
export async function loadSkillHandlers(dir: string): Promise<void> {
  compiledHandlersDir = dir; // remember for lazy-loading legacy handlers

  if (!fs.existsSync(dir)) {
    logger.debug({ dir }, 'No compiled skill-handlers directory, skipping');
    return;
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      await import(filePath);
      logger.info({ file }, 'Loaded compiled skill handler module');
    } catch (err) {
      logger.error(
        { file, err },
        'Failed to load compiled skill handler module',
      );
    }
  }
}
