# /create-skill

Create a new skill that gives agents access to any third-party service or API — without exposing credentials to the container.

## Critical: How Skills Work (read this first)

The skills system IS the way to integrate external services into NanoClaw. Agents run in sandboxed containers. Credentials (API keys, OAuth tokens) must NEVER enter the container. The skills system enforces this — the host holds credentials and proxies all external calls.

### Three integration modes (in order of preference)

**1. Remote MCP server (preferred, zero-code)**
The service hosts its own MCP server (e.g., Vercel, Stripe). The host acts as an authenticating proxy — it injects credentials and forwards requests. No local processes, no dependencies, no code.

```json
{
  "name": "vercel",
  "description": "Vercel deployments and logs",
  "mcpServer": {
    "url": "https://mcp.vercel.com/sse",
    "auth": { "bearer": "token" }
  }
}
```

**2. Local MCP server (zero-code)**
The service publishes an MCP package but doesn't host it. The host spawns it as a child process via `npx`, injecting credentials as env vars. Each MCP server runs in its own process — no dependency contamination, no changes to host's `package.json`.

```json
{
  "name": "some-tool",
  "description": "Some tool integration",
  "mcpServer": {
    "command": "npx",
    "args": ["-y", "@some/mcp-server"],
    "env": { "API_KEY": "api_key" }
  }
}
```

**3. Custom handler.js (last resort, for services with no MCP server)**
Only when the service has no MCP server at all. Write a `handler.js` that calls the API directly from the host. This is the most work — avoid it if an MCP server exists.

```
┌─────────────────────────────────────┐
│  Container (sandboxed)              │
│                                     │
│  Agent calls vercel__list_projects  │
│       │                             │
│       ▼                             │
│  skills-mcp-server (dumb proxy)     │
│  writes IPC file to /workspace/ipc  │
│  polls for response file            │
│       │                             │
└───────┼─────────────────────────────┘
        │ IPC (filesystem)
┌───────┼─────────────────────────────┐
│  Host │                             │
│       ▼                             │
│  mcp-registry.ts                    │
│  ├─ mode 1: proxy to remote MCP    │
│  ├─ mode 2: proxy to local MCP     │
│  └─ mode 3: run handler.js         │
│  (all read credentials from DB)    │
│  writes response to IPC             │
└─────────────────────────────────────┘
```

In all three modes, credential values in the manifest (e.g., `"token"`, `"api_key"`) reference keys in the skill's credential store. The agent calls `{name}__setup` to store them. The host resolves them from DB before connecting.

### Do NOT

- **Run MCP servers inside the container** — this would expose credentials to the agent, defeating the entire security model
- **Modify `agent-runner/src/index.ts`** to add MCP server configs — the skills system already handles this
- **Duplicate the proxy system** — don't create parallel mechanisms for registering tools; use the existing manifest + handler pattern
- **Require a service restart** — handlers are lazy-loaded on first use, no rebuild or restart needed
- **Write a handler.js when an MCP server exists** — always prefer remote > local MCP > custom handler

### Architecture Summary

Each skill lives in `container/skills/{name}/` and requires:
1. **`manifest.json`** — declares the MCP server config (remote URL or local command) OR operation schemas for custom handlers. Also declares a `setup` operation for credential collection.
2. **`SKILL.md`** — agent-facing docs, shown when agent calls `load_skill("{name}")`.
3. **`handler.js`** (only for mode 3) — host-side handler (plain ESM). Called by `src/mcp-registry.ts` with credentials from the DB. Drop the file and it works — no build, no restart.

### Key Files

| File | Purpose |
|------|---------|
| `container/skills/{name}/manifest.json` | Declares operations + param schemas |
| `container/skills/{name}/SKILL.md` | Agent-facing docs (shown on `load_skill`) |
| `container/skills/{name}/handler.js` | Host-side handler — plain ESM, no build needed |
| `src/mcp-registry.ts` | `registerSkillHandler()`, `loadSkillHandlers()`, `processSkillRequest()` |
| `src/db.ts` | `getSkillCredentials()`, `setSkillCredential()`, `activateSkill()`, `getActiveSkills()` |
| `src/ipc.ts` | Processes `skill_request` IPC messages, routes to handlers |
| `src/container-runner.ts` | `writeSkillIndexSnapshot()`, `SkillManifest` interface |
| `container/agent-runner/src/skills-mcp-server.ts` | Container-side dumb proxy (reads manifests, writes IPC) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Provides `list_skills` and `load_skill` tools to agent |

### Data Flow

```
Agent calls load_skill("name")
  -> IPC activate_skill -> host activates in DB -> skill_index.json updated

Agent calls name__operation(params)
  -> skills-mcp-server.ts writes IPC skill_request
  -> host ipc.ts reads task -> mcp-registry.ts processSkillRequest()
  -> lazy-loads container/skills/{name}/handler.js if not yet loaded
  -> reads credentials from DB, executes handler
  -> writes response to ipc/{group}/responses/{requestId}.json
  -> skills-mcp-server.ts polls for response, returns to agent
```

### SkillOperationContext

```javascript
ctx = {
  groupFolder,                          // group identifier
  credentials,                          // { key: value } from DB for this skill
  setCredential(key, value),            // store a credential (use in setup)
}
```

### Notes
- No build step required — `handler.js` is lazy-loaded on first use
- Tool naming convention: `{skillName}__{operationName}` (double underscore)
- Credentials never leave host; container only sees operation results
- Per-group credential isolation via `(groupFolder, skillName)` composite key
- Param types in manifest: `"string"`, `"number"`, `"boolean"`

## Steps

### 1. Gather requirements

Ask the user:
- What service do they want to integrate?
- What credentials are required? (API key, OAuth token, etc.)

Then determine the integration mode:
- **Does the service host an MCP server?** (check their docs) → Mode 1 (remote)
- **Is there an MCP npm package?** (e.g., `@vercel/mcp`) → Mode 2 (local)
- **Neither?** → Mode 3 (custom handler.js)

Always prefer mode 1 > 2 > 3.

### 2. Create the skill directory

```bash
mkdir -p container/skills/{name}
```

### 3. Write the manifest

#### Mode 1: Remote MCP server

```json
{
  "name": "{name}",
  "description": "One-line description",
  "mcpServer": {
    "url": "https://mcp.example.com/sse",
    "auth": { "bearer": "token" }
  },
  "setup": {
    "credentials": {
      "token": { "description": "API access token", "instructions": "Get yours at https://example.com/settings/tokens" }
    }
  }
}
```

That's it. No handler.js. No operations list. Tools are discovered automatically from the remote MCP server.

#### Mode 2: Local MCP server

```json
{
  "name": "{name}",
  "description": "One-line description",
  "mcpServer": {
    "command": "npx",
    "args": ["-y", "@example/mcp-server"],
    "env": { "API_KEY": "api_key" }
  },
  "setup": {
    "credentials": {
      "api_key": { "description": "API key", "instructions": "Get yours at https://example.com/api-keys" }
    }
  }
}
```

Also no handler.js. The host spawns the process with credentials injected as env vars. `npx -y` handles downloading — no changes to host's `package.json`.

Env values (e.g., `"api_key"`) reference keys in the skill's credential store.

#### Mode 3: Custom handler (last resort)

Only when no MCP server exists. Declare operations manually:

```json
{
  "name": "{name}",
  "description": "One-line description",
  "operations": [
    {
      "name": "setup",
      "description": "Store credentials (one-time setup)",
      "params": {
        "api_key": { "type": "string", "description": "Your API key" }
      }
    },
    {
      "name": "operation_name",
      "description": "What this operation does",
      "params": {
        "param1": { "type": "string", "description": "What param1 is" },
        "param2": { "type": "number", "description": "What param2 is", "optional": true }
      }
    }
  ]
}
```

Param types: `"string"`, `"number"`, `"boolean"`. Mark optional params with `"optional": true`.

### 4. Write SKILL.md

Write `container/skills/{name}/SKILL.md` — what agents see when they call `load_skill("{name}")`. Include:
- When to use this skill
- What each operation does and when to use it
- Any important caveats (rate limits, formats, etc.)
- Example usage

For modes 1 and 2, tools are auto-discovered from the MCP server, so SKILL.md is mainly for guidance and tips.

### 5. Write handler.js (mode 3 only)

Create `container/skills/{name}/handler.js` — plain ESM, no build needed:

```javascript
/**
 * Host-side handler for the {name} skill.
 * Plain ESM — no build step. Credentials never exposed to containers.
 */

export default {

  async setup(params, ctx) {
    if (!params.api_key) throw new Error('api_key is required');
    ctx.setCredential('api_key', params.api_key);
    return 'Credentials stored.';
  },

  async operation_name(params, ctx) {
    const { api_key } = ctx.credentials;
    if (!api_key) throw new Error('Not configured. Run {name}__setup first.');

    const res = await fetch('https://api.example.com/endpoint', {
      headers: { Authorization: `Bearer ${api_key}` },
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    return res.json();
  },

};
```

The default export is an object keyed by operation name. Each value is an async function `(params, ctx) => result`. The registry auto-registers them on first invocation — no imports, no build.

#### SkillOperationContext (mode 3)

```javascript
ctx = {
  groupFolder,                          // group identifier
  credentials,                          // { key: value } from DB for this skill
  setCredential(key, value),            // store a credential (use in setup)
}
```

### 6. Activate and test

The skill appears in `list_skills` immediately. The agent activates it with:

```
load_skill("{name}")
```

Then calls `{name}__setup` to store credentials. For modes 1 and 2, tools are available immediately after setup. For mode 3, tool calls go through the handler.js.

## Example: Vercel Skill

See `container/skills/vercel/` for a complete example (currently mode 3, migrating to mode 1):
- `manifest.json` — declares operations
- `SKILL.md` — agent-facing docs
- `handler.js` — uses `fetch` against the Vercel REST API

Once migrated to mode 1, this becomes just a manifest with `"url": "https://mcp.vercel.com/sse"` and a SKILL.md — no handler.js.

## Tips

- **Always check for an existing MCP server first** — most major services have one
- **Remote > local > custom** — less code = fewer bugs = easier maintenance
- **Use the `setup` pattern** — agent walks user through credential collection interactively
- **Credential keys** — use descriptive names like `api_key`, `token`, `oauth_token`
- **For mode 3:** keep operations focused, return plain objects/arrays, use `ctx.setCredential`/`ctx.credentials`
