import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeMemorySnapshot,
  writeSkillIndexSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getConversationBySessionId,
  getMessagesSince,
  getNewMessages,
  getRecentConversations,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  insertConversationArchive,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { loadSkillHandlers } from './mcp-registry.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { checkRateLimit, recordUsage, resolveTenant } from './tenant.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { DATA_DIR, DEFAULT_TENANT_ID } from './config.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/** Derive channel name from a chat JID pattern. */
function detectChannel(chatJid: string): string | null {
  if (chatJid.includes('@g.us') || chatJid.includes('@s.whatsapp.net'))
    return 'whatsapp';
  if (chatJid.startsWith('tg:')) return 'telegram';
  if (chatJid.startsWith('slack:')) return 'slack';
  if (chatJid.startsWith('dc:')) return 'discord';
  return null;
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

/**
 * In-flight tracking: persist which groups have active containers and their
 * pre-advance cursor value. If the process is killed mid-work, startup
 * recovery rolls back these cursors so messages get re-processed.
 */
function getInFlightGroups(): Record<string, string> {
  const raw = getRouterState('in_flight_groups');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function markInFlight(chatJid: string, previousCursor: string): void {
  const inFlight = getInFlightGroups();
  inFlight[chatJid] = previousCursor;
  setRouterState('in_flight_groups', JSON.stringify(inFlight));
}

function clearInFlight(chatJid: string): void {
  const inFlight = getInFlightGroups();
  delete inFlight[chatJid];
  setRouterState('in_flight_groups', JSON.stringify(inFlight));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder, group.tenantId);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;
  const tenantId = group.tenantId || DEFAULT_TENANT_ID;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // Rate limit check for non-operator tenants
  const rateCheck = checkRateLimit(tenantId);
  if (!rateCheck.allowed) {
    const channel = findChannel(channels, chatJid);
    if (channel && rateCheck.reason) {
      channel
        .sendMessage(chatJid, `_${rateCheck.reason}_`)
        .catch((err) =>
          logger.warn({ chatJid, err }, 'Failed to send rate limit message'),
        );
    }
    // Advance cursor so we don't re-check these messages
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    saveState();
    return true;
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  markInFlight(chatJid, previousCursor);
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Send a status message so the user knows what's happening
  const hasExistingSession = !!sessions[group.folder];
  const statusMsg = hasExistingSession
    ? '_Rehydrating session…_'
    : '_Establishing session…_';
  channel
    .sendMessage(chatJid, statusMsg)
    .catch((err) =>
      logger.warn({ chatJid, err }, 'Failed to send status message'),
    );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // Record usage for rate limiting
  recordUsage(tenantId);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Archive session transcript + notes to DB and shared/conversations/
  processSessionArchive(group.folder, sessions[group.folder], tenantId).catch(
    (err: unknown) =>
      logger.error({ group: group.name, err }, 'Failed to archive session'),
  );

  clearInFlight(chatJid);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const tenantId = group.tenantId || DEFAULT_TENANT_ID;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
    tenantId,
  );

  // Update memory index snapshot for container to search
  const conversations = getRecentConversations(200);
  writeMemorySnapshot(group.folder, conversations, tenantId);

  // Update skill index snapshot (which skills are active for this group)
  writeSkillIndexSnapshot(group.folder, tenantId);

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
    tenantId,
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        tenantId,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscriptJsonl(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
): string {
  const now = new Date();
  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(
    `Archived: ${now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`,
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function processSessionArchive(
  groupFolder: string,
  sessionId: string | undefined,
  tenantId?: string,
): Promise<void> {
  const groupDir = resolveGroupFolderPath(groupFolder, tenantId);
  const allMessages: ParsedMessage[] = [];

  // 1. Read pre-compact transcripts from groups/{folder}/transcripts/
  const transcriptsDir = path.join(groupDir, 'transcripts');
  const transcriptFiles: string[] = [];
  if (fs.existsSync(transcriptsDir)) {
    const files = fs
      .readdirSync(transcriptsDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const file of files) {
      const filePath = path.join(transcriptsDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (data.messages && Array.isArray(data.messages)) {
          allMessages.push(...data.messages);
        }
        transcriptFiles.push(filePath);
      } catch (err) {
        logger.warn(
          { file, err },
          'Failed to parse pre-compact transcript, skipping',
        );
      }
    }
  }

  // 2. Read final JSONL transcript from session file
  if (sessionId) {
    // Check idempotency: skip if already archived for this session
    const existing = getConversationBySessionId(sessionId);
    if (existing) {
      logger.debug(
        { groupFolder, sessionId },
        'Session already archived, cleaning up source files',
      );
      // Clean up source files even if already archived
      for (const f of transcriptFiles) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
      const notesFile = path.join(groupDir, 'session-notes.md');
      try {
        fs.unlinkSync(notesFile);
      } catch {
        /* ignore */
      }
      return;
    }

    const sessionDir = path.join(
      DATA_DIR,
      'sessions',
      groupFolder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) {
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const finalMessages = parseTranscriptJsonl(content);
      allMessages.push(...finalMessages);
    }
  }

  if (allMessages.length === 0) {
    // Nothing to archive — clean up empty transcript files
    for (const f of transcriptFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // 3. Read session notes
  const notesFile = path.join(groupDir, 'session-notes.md');
  let notes: string | null = null;
  if (fs.existsSync(notesFile)) {
    notes = fs.readFileSync(notesFile, 'utf-8');
  }

  // 4. Extract summary from first user message
  const firstUserMsg = allMessages.find((m) => m.role === 'user');
  const summary = firstUserMsg
    ? firstUserMsg.content.slice(0, 200).replace(/\n/g, ' ')
    : 'Conversation';

  // 5. Deduplicate consecutive messages with same content
  const deduped: ParsedMessage[] = [];
  for (const msg of allMessages) {
    const last = deduped[deduped.length - 1];
    if (last && last.role === msg.role && last.content === msg.content)
      continue;
    deduped.push(msg);
  }

  // 6. Format as markdown
  const markdown = formatTranscriptMarkdown(deduped, summary);

  // 7. Insert into DB
  const archivedAt = new Date().toISOString();
  const archiveId = insertConversationArchive({
    session_id: sessionId ?? null,
    group_folder: groupFolder,
    summary,
    transcript: markdown,
    notes,
    archived_at: archivedAt,
    message_count: deduped.length,
  });

  // 8. Write markdown to shared/conversations/
  const conversationsDir = path.join(process.cwd(), 'shared', 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });
  fs.writeFileSync(path.join(conversationsDir, `${archiveId}.md`), markdown);

  logger.info(
    {
      archiveId,
      groupFolder,
      sessionId,
      messageCount: deduped.length,
    },
    'Session archived',
  );

  // 9. Delete processed source files (only after successful DB insert + file write)
  for (const f of transcriptFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  if (notes) {
    try {
      fs.unlinkSync(notesFile);
    } catch {
      /* ignore */
    }
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Also rolls back cursors for groups that had in-flight containers when
 * the process was killed (e.g. service restart).
 */
function recoverPendingMessages(): void {
  // Roll back cursors for groups that were mid-work when process was killed
  const inFlight = getInFlightGroups();
  const inFlightCount = Object.keys(inFlight).length;
  if (inFlightCount > 0) {
    for (const [chatJid, previousCursor] of Object.entries(inFlight)) {
      logger.info(
        { chatJid, previousCursor },
        'Recovery: rolling back cursor for interrupted container',
      );
      lastAgentTimestamp[chatJid] = previousCursor;
    }
    setRouterState('in_flight_groups', '{}');
    saveState();
  }

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Load skill handlers (generated by /add-skill, live in src/skill-handlers/)
  const skillHandlersDir = new URL('../dist/skill-handlers', import.meta.url)
    .pathname;
  await loadSkillHandlers(skillHandlersDir);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      // For thread JIDs (slack:CHANNEL:THREAD_TS), check against the parent channel JID
      const allowlistJid = chatJid.replace(/^(slack:[^:]+):.+$/, '$1');
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        (registeredGroups[chatJid] || registeredGroups[allowlistJid])
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(allowlistJid, cfg) &&
          !isSenderAllowed(allowlistJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }

      // Resolve tenant from sender identity (for non-bot inbound messages)
      if (!msg.is_from_me && !msg.is_bot_message && msg.sender) {
        const channelName = detectChannel(chatJid);
        if (channelName) {
          resolveTenant(msg.sender, channelName);
        }
      }

      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onThreadGroup: (jid: string, group: RegisteredGroup) => {
      registerGroup(jid, group);
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj, ti) =>
      writeGroupsSnapshot(gf, im, ag, rj, ti),
    writeSkillIndexSnapshot: (gf, ti) => writeSkillIndexSnapshot(gf, ti),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
