# /create-skill

Create a new MCP-backed skill that gives agents access to any third-party service — without exposing credentials to the container.

## Architecture Recap

Each skill has two parts:
1. **Container side** — `manifest.json` + `SKILL.md` in `container/skills/{name}/`. The skills proxy MCP server reads these at startup and exposes tools like `mcp__skills__{name}__{operation}`.
2. **Host side** — a handler module in `src/skill-handlers/{name}.ts`. It's called by `src/mcp-registry.ts` when the agent invokes a skill tool. Credentials are read from the DB; the container never sees them.

### Key Files

| File | Purpose |
|------|---------|
| `container/skills/{name}/manifest.json` | Declares operations + param schemas |
| `container/skills/{name}/SKILL.md` | Agent-facing docs (shown on `load_skill`) |
| `src/skill-handlers/{name}.ts` | Host-side handler (auto-loaded at startup from `dist/skill-handlers/`) |
| `src/mcp-registry.ts` | `registerSkillHandler()`, `loadSkillHandlers()`, `processSkillRequest()` |
| `src/db.ts` | `getSkillCredentials()`, `setSkillCredential()`, `activateSkill()`, `getActiveSkills()` |
| `src/ipc.ts` | Processes `skill_request` IPC messages, routes to handlers |
| `src/container-runner.ts` | `writeSkillIndexSnapshot()`, `SkillManifest` interface |
| `container/agent-runner/src/skills-mcp-server.ts` | Container-side MCP server (registers tools from manifests) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Provides `list_skills` and `load_skill` tools to agent |

### Data Flow

```
Agent calls load_skill("name")
  -> IPC activate_skill -> host activates in DB -> skill_index.json updated

Agent calls name__operation(params)
  -> skills-mcp-server.ts writes IPC skill_request
  -> host ipc.ts reads task -> mcp-registry.ts processSkillRequest()
  -> looks up handler, reads credentials from DB, executes handler
  -> writes response to ipc/{group}/responses/{requestId}.json
  -> skills-mcp-server.ts polls for response, returns to agent
```

### Key Interfaces (from mcp-registry.ts)

```typescript
interface SkillOperationContext {
  groupFolder: string;
  credentials: Record<string, string>;  // from mcp_credentials table
}
type SkillHandler = (params: Record<string, unknown>, ctx: SkillOperationContext) => Promise<unknown>;
```

### Notes
- `src/skill-handlers/` is created on-demand (may not exist yet)
- Handler files are auto-loaded: `loadSkillHandlers()` imports all `.js` from `dist/skill-handlers/`
- Tool naming convention: `{skillName}__{operationName}` (double underscore)
- Credentials never leave host; container only sees operation results
- Per-group credential isolation via `(groupFolder, skillName)` composite key
- Param types: `"string"`, `"number"`, `"boolean"`

## Steps

### 1. Gather requirements

Ask the user:
- What service do they want to integrate? (email, GitHub, Linear, Jira, Slack, etc.)
- What operations do they need? (e.g., read email, send email, search)
- What credentials are required? (API key, username+password, OAuth token, etc.)

### 2. Create the skill directory in container/skills/

```bash
mkdir -p container/skills/{name}
```

#### Write `container/skills/{name}/manifest.json`

```json
{
  "name": "{name}",
  "description": "One-line description for the skill index",
  "operations": [
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

#### Write `container/skills/{name}/SKILL.md`

This is what agents see when they call `load_skill("{name}")`. Include:
- When to use this skill
- What each operation does and when to use it
- Any important caveats (rate limits, formats, etc.)
- Example usage

### 3. Create the host-side handler in src/skill-handlers/

```bash
mkdir -p src/skill-handlers
```

Write `src/skill-handlers/{name}.ts`:

```typescript
/**
 * Host-side handler for the {name} skill.
 * Credentials are read from the DB — never exposed to containers.
 */
import { registerSkillHandler } from '../mcp-registry.js';

registerSkillHandler('{name}', 'operation_name', async (params, ctx) => {
  const { credentials, groupFolder } = ctx;
  // credentials = { key: value } from mcp_credentials table for this group+skill

  // Install any needed npm packages: npm install {package}
  // const client = new SomeClient({ apiKey: credentials.api_key });
  // const result = await client.doSomething(params.param1 as string);
  // return result;

  throw new Error('Handler not yet implemented');
});
```

### 4. Install required npm packages (if any)

```bash
npm install {package-name}
```

### 5. Store credentials for the group

Use the `mcp_credentials` table via the DB functions. The agent can collect credentials from the user and store them via an IPC message.

Add a `setup` operation to the manifest that the agent can call to store credentials:

```typescript
registerSkillHandler('{name}', 'setup', async (params, ctx) => {
  const { groupFolder } = ctx;
  // Import and call setSkillCredential directly
  const { setSkillCredential } = await import('../db.js');
  const credentials = params as Record<string, string>;
  for (const [key, value] of Object.entries(credentials)) {
    setSkillCredential(groupFolder, '{name}', key, value as string);
  }
  return 'Credentials stored successfully.';
});
```

Add a corresponding `setup` operation to `manifest.json`:
```json
{
  "name": "setup",
  "description": "Store credentials for this skill (one-time setup)",
  "params": {
    "api_key": { "type": "string", "description": "Your API key" }
  }
}
```

### 6. Rebuild the host service

```bash
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# OR
npm run build && systemctl --user restart nanoclaw                  # Linux
```

The new skill handler is now loaded automatically on startup via `loadSkillHandlers()`.

### 7. Activate the skill for the group

The skill will appear in `list_skills` output immediately (it reads `container/skills/` at container startup). The agent (or user) can activate it with `load_skill("{name}")`.

### 8. Test it

Ask the agent to call `list_skills`, then `load_skill("{name}")`, then test an operation. If the handler throws, the error is returned to the agent as a tool error — useful for debugging.

## Example: Email Skill

For a complete example, see how the email skill is structured:
- `container/skills/email/manifest.json` — declares `read`, `send`, `search`, `setup` operations
- `container/skills/email/SKILL.md` — agent-facing docs
- `src/skill-handlers/email.ts` — uses `imap` + `nodemailer` packages, reads IMAP/SMTP creds from DB

## Tips

- **Keep operations focused** — one thing per operation, clear param names
- **Return structured data** as JSON strings so agents can parse results
- **Use the `setup` pattern** for credential collection — agent walks user through it interactively
- **Test locally first** — `node dist/skill-handlers/{name}.js` won't work standalone, but you can test via the agent
- **Credential keys** — use descriptive names like `imap_host`, `imap_port`, `imap_user`, `imap_password`
