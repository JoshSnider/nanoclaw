import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the MCP SDK before importing the module under test
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    connect = vi.fn().mockResolvedValue(undefined);
    listTools = vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'list_projects',
          description: 'List all projects',
          inputSchema: {
            type: 'object',
            properties: {
              team_id: { type: 'string', description: 'Team ID' },
              limit: { type: 'number', description: 'Max results' },
            },
            required: [],
          },
        },
        {
          name: 'get_deployment',
          description: 'Get deployment details',
          inputSchema: {
            type: 'object',
            properties: {
              deployment_id: { type: 'string', description: 'Deployment ID' },
            },
            required: ['deployment_id'],
          },
        },
      ],
    });
    callTool = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"id":"prj_123","name":"my-app"}' }],
    });
    close = vi.fn().mockResolvedValue(undefined);
  }
  return { Client: MockClient };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  class MockSSEClientTransport {}
  return { SSEClientTransport: MockSSEClientTransport };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockStdioClientTransport {}
  return { StdioClientTransport: MockStdioClientTransport };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class MockStreamableHTTPClientTransport {
    constructor() {
      throw new Error('StreamableHTTP not supported');
    }
  }
  return { StreamableHTTPClientTransport: MockStreamableHTTPClientTransport };
});

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  connectMcpServer,
  callMcpTool,
  getMcpTools,
  hasMcpClient,
  disconnectMcpServer,
  disconnectAllMcpServers,
} from './mcp-clients.js';

describe('mcp-clients', () => {
  afterEach(async () => {
    await disconnectAllMcpServers();
  });

  describe('connectMcpServer', () => {
    it('connects to a remote MCP server via SSE and discovers tools', async () => {
      const tools = await connectMcpServer(
        'vercel',
        { url: 'https://mcp.vercel.com/sse', auth: { bearer: 'token' } },
        { token: 'test-token-123' },
      );

      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('list_projects');
      expect(tools[1].name).toBe('get_deployment');
      expect(hasMcpClient('vercel')).toBe(true);
    });

    it('connects to a local MCP server via stdio and discovers tools', async () => {
      const tools = await connectMcpServer(
        'some-tool',
        { command: 'npx', args: ['-y', '@some/mcp'], env: { API_KEY: 'api_key' } },
        { api_key: 'test-key' },
      );

      expect(tools).toHaveLength(2);
      expect(hasMcpClient('some-tool')).toBe(true);
    });

    it('throws when credential reference is missing', async () => {
      await expect(
        connectMcpServer(
          'vercel',
          { url: 'https://mcp.vercel.com/sse', auth: { bearer: 'token' } },
          {}, // no credentials
        ),
      ).rejects.toThrow('Credential "token" not found');
    });

    it('throws when env credential reference is missing', async () => {
      await expect(
        connectMcpServer(
          'tool',
          { command: 'npx', args: [], env: { API_KEY: 'api_key' } },
          {}, // no credentials
        ),
      ).rejects.toThrow('Credential "api_key" not found');
    });

    it('throws when config has neither url nor command', async () => {
      await expect(
        connectMcpServer('bad', {}, {}),
      ).rejects.toThrow('must have either "url" or "command"');
    });

    it('disconnects existing client before reconnecting', async () => {
      await connectMcpServer(
        'vercel',
        { url: 'https://mcp.vercel.com/sse', auth: { bearer: 'token' } },
        { token: 'token-1' },
      );

      // Reconnect with new credentials
      const tools = await connectMcpServer(
        'vercel',
        { url: 'https://mcp.vercel.com/sse', auth: { bearer: 'token' } },
        { token: 'token-2' },
      );

      expect(tools).toHaveLength(2);
      expect(hasMcpClient('vercel')).toBe(true);
    });
  });

  describe('callMcpTool', () => {
    it('calls a tool and returns parsed JSON result', async () => {
      await connectMcpServer(
        'vercel',
        { url: 'https://mcp.vercel.com/sse', auth: { bearer: 'token' } },
        { token: 'test-token' },
      );

      const result = await callMcpTool('vercel', 'list_projects', { team_id: 'team_123' });
      expect(result).toEqual({ id: 'prj_123', name: 'my-app' });
    });

    it('throws when no client is connected', async () => {
      await expect(
        callMcpTool('nonexistent', 'some_tool', {}),
      ).rejects.toThrow('No MCP client connected');
    });
  });

  describe('getMcpTools', () => {
    it('returns discovered tools for a connected skill', async () => {
      await connectMcpServer(
        'vercel',
        { url: 'https://mcp.vercel.com/sse', auth: { bearer: 'token' } },
        { token: 'test' },
      );

      const tools = getMcpTools('vercel');
      expect(tools).toHaveLength(2);
      expect(tools![0]).toMatchObject({ name: 'list_projects', description: 'List all projects' });
    });

    it('returns null for unknown skill', () => {
      expect(getMcpTools('nonexistent')).toBeNull();
    });
  });

  describe('disconnectMcpServer', () => {
    it('removes the client', async () => {
      await connectMcpServer(
        'vercel',
        { url: 'https://mcp.vercel.com/sse', auth: { bearer: 'token' } },
        { token: 'test' },
      );

      expect(hasMcpClient('vercel')).toBe(true);
      await disconnectMcpServer('vercel');
      expect(hasMcpClient('vercel')).toBe(false);
    });

    it('is a no-op for unknown skill', async () => {
      await expect(disconnectMcpServer('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('disconnectAllMcpServers', () => {
    it('disconnects all clients', async () => {
      await connectMcpServer(
        'vercel',
        { url: 'https://mcp.vercel.com/sse', auth: { bearer: 'token' } },
        { token: 'test' },
      );
      await connectMcpServer(
        'linear',
        { url: 'https://mcp.linear.app/sse', auth: { bearer: 'token' } },
        { token: 'test' },
      );

      expect(hasMcpClient('vercel')).toBe(true);
      expect(hasMcpClient('linear')).toBe(true);

      await disconnectAllMcpServers();

      expect(hasMcpClient('vercel')).toBe(false);
      expect(hasMcpClient('linear')).toBe(false);
    });
  });
});
