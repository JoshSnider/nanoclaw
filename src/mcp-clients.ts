/**
 * MCP Client Manager
 *
 * Manages connections to external MCP servers (remote HTTP or local stdio).
 * The host connects to these servers with credentials injected, then proxies
 * tool calls from container agents via IPC. Credentials never enter the container.
 *
 * Two transport modes:
 *   1. Remote (HTTP/SSE): connect to a hosted MCP server with auth headers
 *   2. Local (stdio): spawn a process (e.g. npx -y @vercel/mcp) with env vars
 */

import { spawn, ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from './logger.js';

export interface McpServerConfig {
  /** Remote MCP server URL (HTTP/SSE). Mutually exclusive with command. */
  url?: string;
  /** Auth config for remote servers. */
  auth?: { bearer: string };
  /** Command to spawn a local MCP server. Mutually exclusive with url. */
  command?: string;
  /** Args for the local command. */
  args?: string[];
  /** Env var mapping for local servers: { ENV_VAR_NAME: "credential_key" } */
  env?: Record<string, string>;
}

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ManagedClient {
  client: Client;
  transport: SSEClientTransport | StdioClientTransport | StreamableHTTPClientTransport;
  tools: DiscoveredTool[];
  config: McpServerConfig;
}

/** Active MCP clients keyed by skill name. */
const clients = new Map<string, ManagedClient>();

/**
 * Resolve credential references in an MCP server config.
 * Values like "token" in auth.bearer or env mappings are looked up
 * in the credentials record (from the DB).
 */
function resolveCredentials(
  config: McpServerConfig,
  credentials: Record<string, string>,
): { resolvedAuth?: { bearer: string }; resolvedEnv?: Record<string, string> } {
  let resolvedAuth: { bearer: string } | undefined;
  if (config.auth?.bearer) {
    const token = credentials[config.auth.bearer];
    if (!token) {
      throw new Error(
        `Credential "${config.auth.bearer}" not found. Run setup first.`,
      );
    }
    resolvedAuth = { bearer: token };
  }

  let resolvedEnv: Record<string, string> | undefined;
  if (config.env) {
    resolvedEnv = {};
    for (const [envVar, credKey] of Object.entries(config.env)) {
      const value = credentials[credKey];
      if (!value) {
        throw new Error(
          `Credential "${credKey}" not found for env var ${envVar}. Run setup first.`,
        );
      }
      resolvedEnv[envVar] = value;
    }
  }

  return { resolvedAuth, resolvedEnv };
}

/**
 * Connect to an MCP server and discover its tools.
 * Returns the list of discovered tools.
 */
export async function connectMcpServer(
  skillName: string,
  config: McpServerConfig,
  credentials: Record<string, string>,
): Promise<DiscoveredTool[]> {
  // Disconnect existing client if any
  await disconnectMcpServer(skillName);

  const { resolvedAuth, resolvedEnv } = resolveCredentials(config, credentials);

  const client = new Client(
    { name: `nanoclaw-${skillName}`, version: '1.0.0' },
    { capabilities: {} },
  );

  let transport: SSEClientTransport | StdioClientTransport | StreamableHTTPClientTransport;

  if (config.url) {
    // Remote MCP server — try StreamableHTTP first, fall back to SSE
    const url = new URL(config.url);
    const headers: Record<string, string> = {};
    if (resolvedAuth?.bearer) {
      headers['Authorization'] = `Bearer ${resolvedAuth.bearer}`;
    }

    try {
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
      await client.connect(transport);
      logger.info(
        { skillName, url: config.url },
        'Connected to remote MCP server via StreamableHTTP',
      );
    } catch {
      // Fall back to SSE transport
      transport = new SSEClientTransport(url, {
        requestInit: { headers },
      });
      await client.connect(transport);
      logger.info(
        { skillName, url: config.url },
        'Connected to remote MCP server via SSE (fallback)',
      );
    }
  } else if (config.command) {
    // Local MCP server — spawn process with credentials as env vars
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...resolvedEnv,
    };

    transport = new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env,
    });
    await client.connect(transport);
    logger.info(
      { skillName, command: config.command, args: config.args },
      'Connected to local MCP server via stdio',
    );
  } else {
    throw new Error(
      `MCP server config for "${skillName}" must have either "url" or "command"`,
    );
  }

  // Discover tools
  const toolsResult = await client.listTools();
  const tools: DiscoveredTool[] = (toolsResult.tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown> | undefined,
  }));

  clients.set(skillName, { client, transport, tools, config });

  logger.info(
    { skillName, toolCount: tools.length },
    'MCP server tools discovered',
  );

  return tools;
}

/**
 * Call a tool on a connected MCP server.
 */
export async function callMcpTool(
  skillName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const managed = clients.get(skillName);
  if (!managed) {
    throw new Error(
      `No MCP client connected for skill "${skillName}". Was the skill activated?`,
    );
  }

  const result = await managed.client.callTool({ name: toolName, arguments: args });

  // Extract text content from the MCP result
  if (result.content && Array.isArray(result.content)) {
    const texts = result.content
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text);

    if (result.isError) {
      throw new Error(texts.join('\n') || 'MCP tool call failed');
    }

    // Try to parse as JSON for structured results
    if (texts.length === 1) {
      try {
        return JSON.parse(texts[0]);
      } catch {
        return texts[0];
      }
    }
    return texts.join('\n');
  }

  return result;
}

/**
 * Get discovered tools for a connected MCP server.
 */
export function getMcpTools(skillName: string): DiscoveredTool[] | null {
  return clients.get(skillName)?.tools ?? null;
}

/**
 * Check if a skill has an active MCP client.
 */
export function hasMcpClient(skillName: string): boolean {
  return clients.has(skillName);
}

/**
 * Disconnect and clean up an MCP client.
 */
export async function disconnectMcpServer(skillName: string): Promise<void> {
  const managed = clients.get(skillName);
  if (!managed) return;

  try {
    await managed.client.close();
  } catch (err) {
    logger.warn({ skillName, err }, 'Error closing MCP client');
  }
  clients.delete(skillName);
  logger.info({ skillName }, 'MCP client disconnected');
}

/**
 * Disconnect all MCP clients (for shutdown).
 */
export async function disconnectAllMcpServers(): Promise<void> {
  const names = [...clients.keys()];
  await Promise.all(names.map(disconnectMcpServer));
}
