/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'search_memory',
  'Search past conversations. Returns summaries for progressive disclosure. Use read_memory to get the full transcript of a specific conversation.',
  {
    query: z.string().describe('Search keywords'),
    limit: z.number().optional().default(10),
  },
  async (args) => {
    const indexFile = path.join(IPC_DIR, 'memory_index.json');
    if (!fs.existsSync(indexFile)) {
      return {
        content: [{ type: 'text' as const, text: 'No conversation history yet.' }],
      };
    }
    try {
      const index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
      const queryLower = args.query.toLowerCase();
      const results = (index.conversations || [])
        .filter(
          (c: { summary: string }) =>
            c.summary.toLowerCase().includes(queryLower),
        )
        .slice(0, args.limit);

      const text =
        results.length === 0
          ? `No conversations matching "${args.query}".`
          : results
              .map(
                (c: {
                  id: number;
                  archived_at: string;
                  summary: string;
                  message_count: number;
                }) =>
                  `[${c.id}] ${c.archived_at.split('T')[0]} — ${c.summary} (${c.message_count} messages)`,
              )
              .join('\n');

      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading memory index: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'read_memory',
  'Read the full transcript of a past conversation by ID. Use search_memory first to find the ID.',
  {
    id: z.number().describe('Conversation archive ID from search_memory results'),
  },
  async (args) => {
    const filePath = `/workspace/shared/conversations/${args.id}.md`;
    if (!fs.existsSync(filePath)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Conversation ${args.id} not found. It may have been archived before this system was set up.`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text' as const, text: fs.readFileSync(filePath, 'utf-8') }],
    };
  },
);

const SKILLS_DIR = '/home/node/.claude/skills';
const SKILL_INDEX_FILE = path.join(IPC_DIR, 'skill_index.json');

server.tool(
  'list_skills',
  `List available skills. Skills extend your capabilities with service integrations (email, GitHub, etc.).
Each skill exposes MCP tools that are activated when the skill is loaded.
Use load_skill to activate a skill and see its full documentation.`,
  {},
  async () => {
    try {
      if (!fs.existsSync(SKILL_INDEX_FILE)) {
        return {
          content: [{ type: 'text' as const, text: 'No skills registered yet. Use /add-skill to add a new service integration.' }],
        };
      }

      const skills = JSON.parse(fs.readFileSync(SKILL_INDEX_FILE, 'utf-8')) as Array<{
        name: string;
        description: string;
        active: boolean;
      }>;

      if (skills.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No skills registered yet. Use /add-skill to add a new service integration.' }],
        };
      }

      const lines = skills.map(
        (s) => `${s.active ? '✓' : '○'} **${s.name}** — ${s.description}${s.active ? ' (active)' : ''}`,
      );

      return {
        content: [{
          type: 'text' as const,
          text: `Available skills (✓ = active, ○ = inactive):\n\n${lines.join('\n')}\n\nUse load_skill(name) to activate and register tools. Active skill tools are available as mcp__nanoclaw__{skill}__{tool}.`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading skill index: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'load_skill',
  `Activate a skill and register its MCP tools. Tools become available as mcp__nanoclaw__{skill}__{tool}.`,
  {
    name: z.string().describe('The skill name to load (from list_skills)'),
  },
  async (args) => {
    const skillName = args.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const skillDir = path.join(SKILLS_DIR, skillName);
    const manifestPath = path.join(skillDir, 'manifest.json');
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(manifestPath)) {
      return {
        content: [{
          type: 'text' as const,
          text: `Skill "${skillName}" not found. Run list_skills to see available skills, or /add-skill to create a new one.`,
        }],
        isError: true,
      };
    }

    // Check if already active
    let isAlreadyActive = false;
    try {
      if (fs.existsSync(SKILL_INDEX_FILE)) {
        const skills = JSON.parse(fs.readFileSync(SKILL_INDEX_FILE, 'utf-8')) as Array<{
          name: string;
          active: boolean;
        }>;
        isAlreadyActive = skills.some((s) => s.name === skillName && s.active);
      }
    } catch { /* ignore */ }

    // Send activate_skill IPC to host (idempotent)
    if (!isAlreadyActive) {
      writeIpcFile(TASKS_DIR, {
        type: 'activate_skill',
        skillName,
        groupFolder,
        timestamp: new Date().toISOString(),
      });
    }

    // Wait for host to write tools file (MCP-backed skills)
    const toolsFile = path.join(SKILL_TOOLS_DIR, `${skillName}.json`);
    let toolCount = 0;
    if (!fs.existsSync(toolsFile)) {
      // Poll for up to 10s for the host to connect and write tools
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (fs.existsSync(toolsFile)) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    toolCount = registerDiscoveredTools(skillName);

    // Return the SKILL.md docs
    const skillDoc = fs.existsSync(skillMdPath)
      ? fs.readFileSync(skillMdPath, 'utf-8')
      : `# ${skillName}\n\nSkill activated. Check the manifest for available operations.`;

    const status = toolCount > 0
      ? `✓ Skill "${skillName}" active — ${toolCount} tools registered and ready.`
      : `✓ Skill "${skillName}" activated but no tools discovered. Has it been set up? Use /add-skill to configure it.`;

    return {
      content: [{
        type: 'text' as const,
        text: `${status}\n\n---\n\n${skillDoc}`,
      }],
    };
  },
);

server.tool(
  'set_streaming',
  'Toggle streaming of your thinking and tool calls to the chat. Controls how chatty you appear. Only affects this group unless scope is "global".',
  {
    thinking: z.boolean().optional().describe('Stream thinking blocks to chat'),
    tool_calls: z.boolean().optional().describe('Stream tool call summaries to chat'),
    scope: z.enum(['group', 'global']).default('group').describe('group=this chat only, global=all chats'),
  },
  async (args) => {
    const configPath = args.scope === 'global'
      ? '/workspace/shared/streaming_config.json'
      : '/workspace/ipc/streaming_config.json';

    // Global scope requires write access to /workspace/shared/
    if (args.scope === 'global' && !isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can change global streaming settings.' }],
        isError: true,
      };
    }

    // Read existing config, merge provided fields
    let config: Record<string, boolean> = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch { /* file may not exist */ }

    if (args.thinking !== undefined) config.thinking = args.thinking;
    if (args.tool_calls !== undefined) config.toolCalls = args.tool_calls;

    // Atomic write
    const tempPath = `${configPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2));
    fs.renameSync(tempPath, configPath);

    const thinkingStatus = config.thinking !== false ? 'ON' : 'OFF';
    const toolCallsStatus = config.toolCalls !== false ? 'ON' : 'OFF';

    return {
      content: [{ type: 'text' as const, text: `Streaming updated (${args.scope}): thinking=${thinkingStatus}, tool_calls=${toolCallsStatus}` }],
    };
  },
);

const SKILL_TOOLS_DIR = path.join(IPC_DIR, 'skill_tools');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

/**
 * Send a skill_request IPC and wait for the host response.
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

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      try {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        fs.unlinkSync(responsePath);
        if (response.success) return response.result;
        throw new Error(response.error || 'Skill operation failed');
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Skill operation timed out after 30s.`);
}

/** Track which skill tools have been registered to avoid duplicates. */
const registeredSkillTools = new Set<string>();

/**
 * Read discovered tools from IPC and register them on this server.
 * Called after set_credential succeeds and the host writes the tools file.
 */
function registerDiscoveredTools(skillName: string): number {
  const toolsFile = path.join(SKILL_TOOLS_DIR, `${skillName}.json`);
  if (!fs.existsSync(toolsFile)) return 0;

  let tools: Array<{
    name: string;
    description?: string;
    inputSchema?: {
      type?: string;
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
  }>;
  try {
    tools = JSON.parse(fs.readFileSync(toolsFile, 'utf-8'));
  } catch {
    return 0;
  }

  let count = 0;
  for (const tool of tools) {
    const fullName = `${skillName}__${tool.name}`;
    if (registeredSkillTools.has(fullName)) continue;

    // Build Zod schema from JSON schema
    const shape: Record<string, z.ZodTypeAny> = {};
    const props = tool.inputSchema?.properties ?? {};
    const required = new Set(tool.inputSchema?.required ?? []);
    for (const [name, prop] of Object.entries(props)) {
      let s: z.ZodTypeAny = prop.type === 'number' || prop.type === 'integer'
        ? z.number()
        : prop.type === 'boolean'
          ? z.boolean()
          : z.string();
      if (prop.description) s = s.describe(prop.description);
      if (!required.has(name)) s = s.optional();
      shape[name] = s;
    }

    server.tool(
      fullName,
      `[${skillName}] ${tool.description || tool.name}`,
      shape,
      async (args) => {
        try {
          const result = await invokeSkillOperation(skillName, tool.name, args as Record<string, unknown>);
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text' as const, text }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    );
    registeredSkillTools.add(fullName);
    count++;
  }
  return count;
}

server.tool(
  'set_credential',
  'Store a credential for a skill. The host stores it in the DB and connects the MCP server if all required credentials are present. Tools become available immediately.',
  {
    skill: z.string().describe('The skill name (e.g., "vercel", "github")'),
    key: z.string().describe('The credential key (e.g., "token", "api_key")'),
    value: z.string().describe('The credential value'),
  },
  async (args) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const responsesDir = path.join(IPC_DIR, 'responses');
    const responsePath = path.join(responsesDir, `${requestId}.json`);

    fs.mkdirSync(responsesDir, { recursive: true });

    writeIpcFile(TASKS_DIR, {
      type: 'set_credential',
      skillName: args.skill,
      key: args.key,
      value: args.value,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    // Poll for response from host
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (fs.existsSync(responsePath)) {
        try {
          const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
          fs.unlinkSync(responsePath);
          if (response.success) {
            // Host connected MCP and wrote tools file — register them now
            // Brief delay to let the host finish writing the tools file
            await new Promise((r) => setTimeout(r, 500));
            const toolCount = registerDiscoveredTools(args.skill);
            const msg = toolCount > 0
              ? `${response.result} ${toolCount} tools now available.`
              : response.result;
            return { content: [{ type: 'text' as const, text: msg }] };
          } else {
            return {
              content: [{ type: 'text' as const, text: `Error: ${response.error}` }],
              isError: true,
            };
          }
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    return {
      content: [{ type: 'text' as const, text: 'Credential store timed out. The host may be busy.' }],
      isError: true,
    };
  },
);

// Register tools for already-configured skills at startup
try {
  if (fs.existsSync(SKILL_TOOLS_DIR)) {
    for (const file of fs.readdirSync(SKILL_TOOLS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const skillName = file.replace(/\.json$/, '');
      const count = registerDiscoveredTools(skillName);
      if (count > 0) {
        process.stderr.write(`[nanoclaw] Registered ${count} tools for skill "${skillName}"\n`);
      }
    }
  }
} catch (err) {
  process.stderr.write(`[nanoclaw] Failed to scan skill tools: ${err}\n`);
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
