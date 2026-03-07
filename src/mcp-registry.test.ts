import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock mcp-clients
const mockConnectMcpServer = vi
  .fn()
  .mockResolvedValue([{ name: 'list_projects', description: 'List projects' }]);
const mockCallMcpTool = vi.fn().mockResolvedValue({ id: 'prj_123' });
const mockHasMcpClient = vi.fn().mockReturnValue(false);
const mockDisconnectMcpServer = vi.fn();
const mockGetMcpTools = vi.fn().mockReturnValue(null);

vi.mock('./mcp-clients.js', () => ({
  connectMcpServer: (...args: unknown[]) => mockConnectMcpServer(...args),
  callMcpTool: (...args: unknown[]) => mockCallMcpTool(...args),
  hasMcpClient: (...args: unknown[]) => mockHasMcpClient(...args),
  disconnectMcpServer: (...args: unknown[]) => mockDisconnectMcpServer(...args),
  getMcpTools: (...args: unknown[]) => mockGetMcpTools(...args),
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock DB functions
const mockCredentials: Record<string, string> = {};
vi.mock('./db.js', () => ({
  getSkillCredentials: vi.fn(() => ({ ...mockCredentials })),
  setSkillCredential: vi.fn(
    (group: string, skill: string, key: string, value: string) => {
      mockCredentials[key] = value;
    },
  ),
}));

// Mock group-folder to use temp dirs
let tempDir: string;
vi.mock('./group-folder.js', () => ({
  resolveGroupIpcPath: vi.fn(() => path.join(tempDir, 'ipc', 'test-group')),
}));

// We need to set up the project root to point to a temp directory with skills
let projectRoot: string;

import {
  processSkillRequest,
  connectAndWriteMcpTools,
} from './mcp-registry.js';

describe('mcp-registry', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    // Create IPC directories
    fs.mkdirSync(path.join(tempDir, 'ipc', 'test-group', 'responses'), {
      recursive: true,
    });

    // Reset mocks
    mockConnectMcpServer.mockClear();
    mockCallMcpTool.mockClear();
    mockHasMcpClient.mockClear();
    mockCallMcpTool.mockResolvedValue({ id: 'prj_123' });
    mockConnectMcpServer.mockResolvedValue([
      { name: 'list_projects', description: 'List projects' },
    ]);

    // Reset credentials
    for (const key of Object.keys(mockCredentials)) {
      delete mockCredentials[key];
    }
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('processSkillRequest with MCP-backed skills', () => {
    it('forwards tool calls to MCP client when skill has mcpServer config', async () => {
      // Create a manifest with mcpServer in the project's container/skills dir
      const skillDir = path.join(
        process.cwd(),
        'container',
        'skills',
        '__test_mcp_skill',
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'manifest.json'),
        JSON.stringify({
          name: '__test_mcp_skill',
          description: 'Test MCP skill',
          mcpServer: {
            url: 'https://mcp.test.com/sse',
            auth: { bearer: 'token' },
          },
        }),
      );

      try {
        mockCredentials.token = 'test-token';
        mockHasMcpClient.mockReturnValue(false);

        await processSkillRequest(
          'test-group',
          '__test_mcp_skill',
          'list_projects',
          { team_id: 'team_123' },
          'req-001',
        );

        // Should have connected the MCP client
        expect(mockConnectMcpServer).toHaveBeenCalledWith(
          '__test_mcp_skill',
          { url: 'https://mcp.test.com/sse', auth: { bearer: 'token' } },
          expect.objectContaining({ token: 'test-token' }),
          undefined, // tenantId
        );

        // Should have called the tool
        expect(mockCallMcpTool).toHaveBeenCalledWith(
          '__test_mcp_skill',
          'list_projects',
          { team_id: 'team_123' },
          undefined, // tenantId
        );

        // Should have written the response
        const responsePath = path.join(
          tempDir,
          'ipc',
          'test-group',
          'responses',
          'req-001.json',
        );
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        expect(response.success).toBe(true);
        expect(response.result).toEqual({ id: 'prj_123' });
      } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }
    });

    it('handles setup operation for MCP-backed skills', async () => {
      const skillDir = path.join(
        process.cwd(),
        'container',
        'skills',
        '__test_mcp_setup',
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'manifest.json'),
        JSON.stringify({
          name: '__test_mcp_setup',
          description: 'Test',
          mcpServer: {
            url: 'https://mcp.test.com/sse',
            auth: { bearer: 'token' },
          },
        }),
      );

      try {
        await processSkillRequest(
          'test-group',
          '__test_mcp_setup',
          'setup',
          { token: 'my-api-token' },
          'req-002',
        );

        // Should have stored credentials
        const { setSkillCredential } = await import('./db.js');
        expect(setSkillCredential).toHaveBeenCalledWith(
          'test-group',
          '__test_mcp_setup',
          'token',
          'my-api-token',
        );

        // Should have tried to connect MCP server
        expect(mockConnectMcpServer).toHaveBeenCalled();

        // Should have written success response
        const responsePath = path.join(
          tempDir,
          'ipc',
          'test-group',
          'responses',
          'req-002.json',
        );
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        expect(response.success).toBe(true);
        expect(response.result).toContain('Credentials stored');
      } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }
    });

    it('skips MCP path for skills without mcpServer config', async () => {
      const skillDir = path.join(
        process.cwd(),
        'container',
        'skills',
        '__test_handler_skill',
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'manifest.json'),
        JSON.stringify({
          name: '__test_handler_skill',
          description: 'Test handler skill',
          operations: [{ name: 'do_thing', description: 'Does a thing' }],
        }),
      );
      // Create a handler.js
      fs.writeFileSync(
        path.join(skillDir, 'handler.js'),
        `export default { async do_thing(params, ctx) { return 'handler result'; } };`,
      );

      try {
        await processSkillRequest(
          'test-group',
          '__test_handler_skill',
          'do_thing',
          {},
          'req-003',
        );

        // Should NOT have called MCP client
        expect(mockConnectMcpServer).not.toHaveBeenCalled();
        expect(mockCallMcpTool).not.toHaveBeenCalled();

        // Should have written response from handler
        const responsePath = path.join(
          tempDir,
          'ipc',
          'test-group',
          'responses',
          'req-003.json',
        );
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        expect(response.success).toBe(true);
        expect(response.result).toBe('handler result');
      } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }
    });

    it('reuses existing MCP client connection', async () => {
      const skillDir = path.join(
        process.cwd(),
        'container',
        'skills',
        '__test_reuse',
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'manifest.json'),
        JSON.stringify({
          name: '__test_reuse',
          mcpServer: {
            url: 'https://mcp.test.com/sse',
            auth: { bearer: 'token' },
          },
        }),
      );

      try {
        mockCredentials.token = 'test-token';
        mockHasMcpClient.mockReturnValue(true); // Already connected

        await processSkillRequest(
          'test-group',
          '__test_reuse',
          'list_projects',
          {},
          'req-004',
        );

        // Should NOT have connected again
        expect(mockConnectMcpServer).not.toHaveBeenCalled();
        // But should have called the tool
        expect(mockCallMcpTool).toHaveBeenCalled();
      } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }
    });
  });

  describe('connectAndWriteMcpTools', () => {
    it('connects MCP server and writes discovered tools to IPC', async () => {
      const skillDir = path.join(
        process.cwd(),
        'container',
        'skills',
        '__test_write_tools',
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'manifest.json'),
        JSON.stringify({
          name: '__test_write_tools',
          mcpServer: {
            url: 'https://mcp.test.com/sse',
            auth: { bearer: 'token' },
          },
        }),
      );

      try {
        mockCredentials.token = 'test-token';

        await connectAndWriteMcpTools('__test_write_tools', 'test-group');

        expect(mockConnectMcpServer).toHaveBeenCalled();

        // Should have written tools file
        const toolsFile = path.join(
          tempDir,
          'ipc',
          'test-group',
          'skill_tools',
          '__test_write_tools.json',
        );
        expect(fs.existsSync(toolsFile)).toBe(true);
        const tools = JSON.parse(fs.readFileSync(toolsFile, 'utf-8'));
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('list_projects');
      } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }
    });

    it('skips connection when credentials are missing', async () => {
      const skillDir = path.join(
        process.cwd(),
        'container',
        'skills',
        '__test_no_creds',
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'manifest.json'),
        JSON.stringify({
          name: '__test_no_creds',
          mcpServer: {
            url: 'https://mcp.test.com/sse',
            auth: { bearer: 'token' },
          },
        }),
      );

      try {
        // No credentials set
        await connectAndWriteMcpTools('__test_no_creds', 'test-group');

        // Should NOT have tried to connect
        expect(mockConnectMcpServer).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }
    });

    it('is a no-op for non-MCP skills', async () => {
      const skillDir = path.join(
        process.cwd(),
        'container',
        'skills',
        '__test_no_mcp',
      );
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'manifest.json'),
        JSON.stringify({
          name: '__test_no_mcp',
          operations: [{ name: 'foo', description: 'bar' }],
        }),
      );

      try {
        await connectAndWriteMcpTools('__test_no_mcp', 'test-group');
        expect(mockConnectMcpServer).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(skillDir, { recursive: true, force: true });
      }
    });
  });
});
