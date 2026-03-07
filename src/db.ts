import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TENANT_ID,
  STORE_DIR,
} from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS conversation_archives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      group_folder TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      transcript TEXT NOT NULL,
      notes TEXT,
      archived_at TEXT NOT NULL,
      message_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ca_date ON conversation_archives(archived_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_archives_fts USING fts5(
      summary,
      content='conversation_archives',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS ca_fts_insert
      AFTER INSERT ON conversation_archives BEGIN
      INSERT INTO conversation_archives_fts(rowid, summary)
      VALUES (new.id, new.summary);
    END;

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS mcp_active_skills (
      group_folder TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      activated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, skill_name)
    );

    CREATE TABLE IF NOT EXISTS mcp_credentials (
      group_folder TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (group_folder, skill_name, key)
    );
  `);

  // --- Multi-tenancy tables ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      anthropic_api_key_encrypted TEXT,
      rate_limit_rpm INTEGER DEFAULT 20,
      rate_limit_daily INTEGER DEFAULT 200,
      is_operator INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenant_identities (
      sender_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      linked_at TEXT NOT NULL,
      PRIMARY KEY (sender_id, channel)
    );

    CREATE TABLE IF NOT EXISTS usage_tracking (
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      date TEXT NOT NULL,
      request_count INTEGER DEFAULT 0,
      PRIMARY KEY (tenant_id, date)
    );
  `);

  // Ensure default operator tenant exists
  database
    .prepare(
      `INSERT OR IGNORE INTO tenants (id, display_name, status, is_operator, rate_limit_rpm, rate_limit_daily, created_at, updated_at)
     VALUES (?, 'Operator', 'active', 1, 0, 0, ?, ?)`,
    )
    .run(DEFAULT_TENANT_ID, new Date().toISOString(), new Date().toISOString());

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add tenant_id columns to existing tables (multi-tenancy migration)
  const tenantMigrations = [
    'chats',
    'messages',
    'registered_groups',
    'scheduled_tasks',
    'sessions',
    'conversation_archives',
    'mcp_active_skills',
    'mcp_credentials',
  ];
  for (const table of tenantMigrations) {
    try {
      database.exec(
        `ALTER TABLE ${table} ADD COLUMN tenant_id TEXT DEFAULT 'default'`,
      );
    } catch {
      /* column already exists */
    }
  }

  // Migrate is_main groups: ensure they have requires_trigger=0
  // so they keep working without triggers after isMain removal.
  database.exec(
    `UPDATE registered_groups SET requires_trigger = 0 WHERE is_main = 1`,
  );
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        tenant_id: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    tenantId: row.tenant_id || DEFAULT_TENANT_ID,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    0, // is_main deprecated — kept for schema compat
    group.tenantId || DEFAULT_TENANT_ID,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    tenant_id: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      tenantId: row.tenant_id || DEFAULT_TENANT_ID,
    };
  }
  return result;
}

// --- Conversation archive accessors ---

export interface ConversationArchive {
  id: number;
  session_id: string | null;
  group_folder: string;
  summary: string;
  transcript: string;
  notes: string | null;
  archived_at: string;
  message_count: number;
}

export interface ConversationArchiveSummary {
  id: number;
  summary: string;
  group_folder: string;
  archived_at: string;
  message_count: number;
}

export function insertConversationArchive(archive: {
  session_id?: string | null;
  group_folder: string;
  summary: string;
  transcript: string;
  notes?: string | null;
  archived_at: string;
  message_count: number;
}): number {
  const result = db
    .prepare(
      `INSERT INTO conversation_archives (session_id, group_folder, summary, transcript, notes, archived_at, message_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      archive.session_id ?? null,
      archive.group_folder,
      archive.summary,
      archive.transcript,
      archive.notes ?? null,
      archive.archived_at,
      archive.message_count,
    );
  return Number(result.lastInsertRowid);
}

export function searchConversations(
  query: string,
  limit: number = 10,
): ConversationArchiveSummary[] {
  return db
    .prepare(
      `SELECT ca.id, ca.summary, ca.group_folder, ca.archived_at, ca.message_count
     FROM conversation_archives_fts fts
     JOIN conversation_archives ca ON ca.id = fts.rowid
     WHERE fts.summary MATCH ?
     ORDER BY ca.archived_at DESC
     LIMIT ?`,
    )
    .all(query, limit) as ConversationArchiveSummary[];
}

export function getRecentConversations(
  limit: number = 200,
): ConversationArchiveSummary[] {
  return db
    .prepare(
      `SELECT id, summary, group_folder, archived_at, message_count
     FROM conversation_archives
     ORDER BY archived_at DESC
     LIMIT ?`,
    )
    .all(limit) as ConversationArchiveSummary[];
}

export function getConversationById(
  id: number,
): ConversationArchive | undefined {
  return db
    .prepare(`SELECT * FROM conversation_archives WHERE id = ?`)
    .get(id) as ConversationArchive | undefined;
}

export function getConversationBySessionId(
  sessionId: string,
): ConversationArchive | undefined {
  return db
    .prepare(`SELECT * FROM conversation_archives WHERE session_id = ?`)
    .get(sessionId) as ConversationArchive | undefined;
}

// --- MCP skill accessors ---

export function activateSkill(groupFolder: string, skillName: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO mcp_active_skills (group_folder, skill_name, activated_at)
     VALUES (?, ?, ?)`,
  ).run(groupFolder, skillName, new Date().toISOString());
}

export function deactivateSkill(groupFolder: string, skillName: string): void {
  db.prepare(
    `DELETE FROM mcp_active_skills WHERE group_folder = ? AND skill_name = ?`,
  ).run(groupFolder, skillName);
}

export function getActiveSkills(groupFolder: string): string[] {
  const rows = db
    .prepare(
      `SELECT skill_name FROM mcp_active_skills WHERE group_folder = ? ORDER BY activated_at`,
    )
    .all(groupFolder) as Array<{ skill_name: string }>;
  return rows.map((r) => r.skill_name);
}

export function setSkillCredential(
  groupFolder: string,
  skillName: string,
  key: string,
  value: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO mcp_credentials (group_folder, skill_name, key, value)
     VALUES (?, ?, ?, ?)`,
  ).run(groupFolder, skillName, key, value);
}

export function getSkillCredentials(
  groupFolder: string,
  skillName: string,
): Record<string, string> {
  const rows = db
    .prepare(
      `SELECT key, value FROM mcp_credentials WHERE group_folder = ? AND skill_name = ?`,
    )
    .all(groupFolder, skillName) as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function deleteSkillCredentials(
  groupFolder: string,
  skillName: string,
): void {
  db.prepare(
    `DELETE FROM mcp_credentials WHERE group_folder = ? AND skill_name = ?`,
  ).run(groupFolder, skillName);
}

// --- Tenant accessors ---

export interface Tenant {
  id: string;
  display_name: string;
  status: string;
  anthropic_api_key_encrypted: string | null;
  rate_limit_rpm: number;
  rate_limit_daily: number;
  is_operator: number;
  created_at: string;
  updated_at: string;
}

export function getTenant(id: string): Tenant | undefined {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as
    | Tenant
    | undefined;
}

export function createTenant(tenant: {
  id: string;
  display_name: string;
  rate_limit_rpm?: number;
  rate_limit_daily?: number;
  is_operator?: boolean;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tenants (id, display_name, status, rate_limit_rpm, rate_limit_daily, is_operator, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?)`,
  ).run(
    tenant.id,
    tenant.display_name,
    tenant.rate_limit_rpm ?? 20,
    tenant.rate_limit_daily ?? 200,
    tenant.is_operator ? 1 : 0,
    now,
    now,
  );
}

export function updateTenant(
  id: string,
  updates: Partial<
    Pick<
      Tenant,
      | 'display_name'
      | 'status'
      | 'anthropic_api_key_encrypted'
      | 'rate_limit_rpm'
      | 'rate_limit_daily'
    >
  >,
): void {
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [new Date().toISOString()];

  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.anthropic_api_key_encrypted !== undefined) {
    fields.push('anthropic_api_key_encrypted = ?');
    values.push(updates.anthropic_api_key_encrypted);
  }
  if (updates.rate_limit_rpm !== undefined) {
    fields.push('rate_limit_rpm = ?');
    values.push(updates.rate_limit_rpm);
  }
  if (updates.rate_limit_daily !== undefined) {
    fields.push('rate_limit_daily = ?');
    values.push(updates.rate_limit_daily);
  }

  values.push(id);
  db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function lookupTenantByIdentity(
  senderId: string,
  channel: string,
): string | undefined {
  const row = db
    .prepare(
      'SELECT tenant_id FROM tenant_identities WHERE sender_id = ? AND channel = ?',
    )
    .get(senderId, channel) as { tenant_id: string } | undefined;
  return row?.tenant_id;
}

export function linkTenantIdentity(
  senderId: string,
  channel: string,
  tenantId: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO tenant_identities (sender_id, channel, tenant_id, linked_at)
     VALUES (?, ?, ?, ?)`,
  ).run(senderId, channel, tenantId, new Date().toISOString());
}

export function getTenantUsageToday(tenantId: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(
      'SELECT request_count FROM usage_tracking WHERE tenant_id = ? AND date = ?',
    )
    .get(tenantId, today) as { request_count: number } | undefined;
  return row?.request_count ?? 0;
}

export function incrementTenantUsage(tenantId: string): void {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO usage_tracking (tenant_id, date, request_count)
     VALUES (?, ?, 1)
     ON CONFLICT(tenant_id, date) DO UPDATE SET request_count = request_count + 1`,
  ).run(tenantId, today);
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
