/**
 * Skills Proxy MCP Server
 *
 * Runs inside the container as a stdio MCP server.
 * Reads the skill index to discover active skills, then registers tools:
 *
 *   - MCP-backed skills (hasMcpServer=true): reads discovered tools from
 *     /workspace/ipc/skill_tools/{name}.json (written by the host after
 *     connecting to the remote/local MCP server)
 *   - Custom handler skills: reads operations from manifest.json
 *
 * All tool invocations are proxied to the host via IPC:
 *   1. Write skill_request to /workspace/ipc/tasks/
 *   2. Poll /workspace/ipc/responses/{reqId}.json until host responds
 *   3. Return the result to the agent
 *
 * Credentials never enter the container — the host holds them and
 * executes operations, returning only results.
 *
 * Tool naming: {skillName}__{operationName}
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
const SKILL_INDEX_FILE = path.join(IPC_DIR, 'skill_index.json');
const SKILL_TOOLS_DIR = path.join(IPC_DIR, 'skill_tools');
const SKILLS_DIR = '/home/node/.claude/skills';

const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;

const POLL_INTERVAL_MS = 300;
const POLL_TIMEOUT_MS = 30_000; // 30 seconds for host to respond

interface SkillIndexEntry {
  name: string;
  description: string;
  active: boolean;
  hasMcpServer?: boolean;
}

interface SkillParam {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  optional?: boolean;
}

interface SkillOperation {
  name: string;
  description: string;
  params?: Record<string, SkillParam>;
}

interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

/**
 * Send a skill_request IPC and wait for the host to write a response.
 */
async function invokeSkillOperation(
  skillName: string,
  operation: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);

  fs.mkdirSync(RESPONSES_DIR, { recursive: true });

  writeIpcFile(TASKS_DIR, {
    type: 'skill_request',
    skillName,
    operation,
    params,
    requestId,
    groupFolder,
    timestamp: new Date().toISOString(),
  });

  // Poll for response
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) {
          return response.result;
        } else {
          throw new Error(response.error || 'Skill operation failed');
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          // File may be partially written, retry
        } else {
          throw err;
        }
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `Skill operation timed out after ${POLL_TIMEOUT_MS / 1000}s. ` +
    `The host may not have a handler registered for ${skillName}.${operation}. ` +
    `Run /create-skill to set up the handler.`,
  );
}

/**
 * Build a Zod schema for an operation's params from the manifest definition.
 */
function buildParamSchema(
  params: Record<string, SkillParam> = {},
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, def] of Object.entries(params)) {
    let schema: z.ZodTypeAny;
    if (def.type === 'number') {
      schema = z.number();
    } else if (def.type === 'boolean') {
      schema = z.boolean();
    } else {
      schema = z.string();
    }
    if (def.description) {
      schema = schema.describe(def.description);
    }
    if (def.optional) {
      schema = schema.optional();
    }
    shape[name] = schema;
  }
  return z.object(shape);
}

/**
 * Build a Zod schema from a JSON Schema (from MCP tool inputSchema).
 * Handles the common cases for MCP tool parameters.
 */
function buildSchemaFromJsonSchema(
  inputSchema?: DiscoveredTool['inputSchema'],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  if (!inputSchema?.properties) return z.object(shape);

  const required = new Set(inputSchema.required || []);

  for (const [name, prop] of Object.entries(inputSchema.properties)) {
    let schema: z.ZodTypeAny;
    switch (prop.type) {
      case 'number':
      case 'integer':
        schema = z.number();
        break;
      case 'boolean':
        schema = z.boolean();
        break;
      default:
        schema = z.string();
    }
    if (prop.description) {
      schema = schema.describe(prop.description);
    }
    if (!required.has(name)) {
      schema = schema.optional();
    }
    shape[name] = schema;
  }
  return z.object(shape);
}

/**
 * Register a tool that proxies to the host via IPC.
 */
function registerProxyTool(
  server: McpServer,
  skillName: string,
  toolName: string,
  description: string,
  schema: z.ZodObject<Record<string, z.ZodTypeAny>>,
): void {
  server.tool(
    `${skillName}__${toolName}`,
    `[${skillName}] ${description}`,
    schema.shape,
    async (args) => {
      try {
        const result = await invokeSkillOperation(skillName, toolName, args as Record<string, unknown>);
        const text = typeof result === 'string'
          ? result
          : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}

// Load skill index and active skills
let activeSkills: SkillIndexEntry[] = [];
try {
  if (fs.existsSync(SKILL_INDEX_FILE)) {
    const all: SkillIndexEntry[] = JSON.parse(
      fs.readFileSync(SKILL_INDEX_FILE, 'utf-8'),
    );
    activeSkills = all.filter((s) => s.active);
  }
} catch (err) {
  process.stderr.write(`[skills-mcp] Failed to read skill index: ${err}\n`);
}

const server = new McpServer({
  name: 'skills',
  version: '1.0.0',
});

let toolsRegistered = 0;

for (const entry of activeSkills) {
  if (entry.hasMcpServer) {
    // MCP-backed skill: read discovered tools from IPC
    const toolsFile = path.join(SKILL_TOOLS_DIR, `${entry.name}.json`);
    if (!fs.existsSync(toolsFile)) {
      process.stderr.write(
        `[skills-mcp] No discovered tools for MCP skill "${entry.name}" — ` +
        `run ${entry.name}__setup to configure credentials\n`,
      );

      // Register a setup tool so the agent can configure credentials
      const manifestPath = path.join(SKILLS_DIR, entry.name, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const setupCreds = manifest.setup?.credentials;
          if (setupCreds) {
            const shape: Record<string, z.ZodTypeAny> = {};
            for (const [key, def] of Object.entries(setupCreds as Record<string, { description: string }>)) {
              shape[key] = z.string().describe(def.description);
            }
            registerProxyTool(
              server, entry.name, 'setup',
              'Store credentials (one-time setup)',
              z.object(shape),
            );
            toolsRegistered++;
            process.stderr.write(`[skills-mcp] Registered setup tool for MCP skill: ${entry.name}\n`);
          }
        } catch { /* ignore parse errors */ }
      }
      continue;
    }

    try {
      const tools: DiscoveredTool[] = JSON.parse(fs.readFileSync(toolsFile, 'utf-8'));

      for (const tool of tools) {
        const schema = buildSchemaFromJsonSchema(tool.inputSchema);
        registerProxyTool(
          server, entry.name, tool.name,
          tool.description || tool.name,
          schema,
        );
        toolsRegistered++;
        process.stderr.write(`[skills-mcp] Registered MCP tool: ${entry.name}__${tool.name}\n`);
      }

      // Also register a setup tool for re-configuration
      const manifestPath = path.join(SKILLS_DIR, entry.name, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const setupCreds = manifest.setup?.credentials;
          if (setupCreds) {
            const shape: Record<string, z.ZodTypeAny> = {};
            for (const [key, def] of Object.entries(setupCreds as Record<string, { description: string }>)) {
              shape[key] = z.string().describe(def.description);
            }
            registerProxyTool(
              server, entry.name, 'setup',
              'Store or update credentials',
              z.object(shape),
            );
            toolsRegistered++;
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      process.stderr.write(`[skills-mcp] Failed to read discovered tools for ${entry.name}: ${err}\n`);
    }
  } else {
    // Custom handler skill: read operations from manifest
    const manifestPath = path.join(SKILLS_DIR, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      process.stderr.write(`[skills-mcp] Manifest not found for active skill: ${entry.name}\n`);
      continue;
    }

    let manifest: { operations?: SkillOperation[] };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (err) {
      process.stderr.write(`[skills-mcp] Failed to parse manifest for ${entry.name}: ${err}\n`);
      continue;
    }

    for (const op of manifest.operations || []) {
      const paramSchema = buildParamSchema(op.params);
      registerProxyTool(server, entry.name, op.name, op.description, paramSchema);
      toolsRegistered++;
      process.stderr.write(`[skills-mcp] Registered tool: ${entry.name}__${op.name}\n`);
    }
  }
}

if (toolsRegistered === 0) {
  // Register a no-op info tool so the server starts cleanly with no active skills
  server.tool(
    'skills_info',
    'No skills are currently active. Use the list_skills and load_skill tools (from the nanoclaw MCP server) to activate skills.',
    {},
    async () => ({
      content: [{
        type: 'text' as const,
        text: 'No skills active. Use list_skills to see available skills, then load_skill(name) to activate one.',
      }],
    }),
  );
}

process.stderr.write(`[skills-mcp] Starting with ${toolsRegistered} tools from ${activeSkills.length} active skills\n`);

const transport = new StdioServerTransport();
await server.connect(transport);
