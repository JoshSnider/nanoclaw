---
name: diagnose
description: Run a full diagnostic health check after container changes. Exercises core capabilities — bash, filesystem, network, memory, scheduler, skills — and reports pass/fail for each. Read-only by design; any writes are to /tmp and cleaned up immediately.
---

# NanoClaw Diagnostic Health Check

Run this after container rebuilds, dependency upgrades, or any change that could break agent capabilities. Run all checks silently and print *one* summary report at the end.

This skill runs in two modes depending on context:
- *Host mode* (running in Claude Code / developer session): checks host-side health — service, logs, config, env
- *Container mode* (running as a container agent): use `load_skill("diagnose")` instead, which loads the container-side checklist

---

## Check 1 — NanoClaw Service

```bash
# macOS
launchctl list | grep nanoclaw
# Linux
systemctl --user is-active nanoclaw 2>/dev/null || echo "systemd: not found"
```

```bash
# Check recent logs for errors
tail -20 logs/nanoclaw.log 2>/dev/null | grep -i error || echo "No recent errors in logs"
```

✅ Pass: service listed as running, no recent errors
⚠️  Warn: recent errors in logs (note them)
❌ Fail: service not running

---

## Check 2 — Environment Config

```bash
[ -f .env ] && echo ".env: present ($(wc -l < .env) lines)" || echo ".env: MISSING"
[ -f data/env/env ] && echo "data/env/env: present" || echo "data/env/env: not synced"
```

```bash
# Check key vars are set (do NOT print values)
for var in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ASSISTANT_NAME; do
  grep -q "^${var}=" .env 2>/dev/null && echo "$var: set in .env" || echo "$var: not in .env"
done
```

✅ Pass: `.env` present, at least one auth key set
❌ Fail: `.env` missing

---

## Check 3 — NanoClaw State

```bash
[ -f .nanoclaw/state.yaml ] && cat .nanoclaw/state.yaml || echo "state.yaml: not found (run setup first)"
```

Informational — lists applied skills. No pass/fail.

---

## Check 4 — Container Runtime

```bash
# Docker
docker info --format '{{.ServerVersion}}' 2>/dev/null && echo "docker: OK" || \
# Apple Container
container --version 2>/dev/null && echo "apple-container: OK" || \
echo "container-runtime: NOT FOUND"
```

```bash
# Check the container image exists
docker image ls nanoclaw-agent 2>/dev/null | tail -1 || echo "container-image: check manually"
```

✅ Pass: a container runtime is available
❌ Fail: no runtime found

---

## Check 5 — Build Artifacts

```bash
[ -d dist/ ] && echo "dist/: present ($(find dist -name '*.js' | wc -l) JS files)" || echo "dist/: MISSING — run npm run build"
[ -f dist/index.js ] && echo "dist/index.js: OK" || echo "dist/index.js: MISSING"
```

✅ Pass: `dist/` exists with JS files
❌ Fail: no `dist/` or empty

---

## Check 6 — Registered Groups

```bash
[ -f data/groups.json ] && python3 -c "
import json
d = json.load(open('data/groups.json'))
print(f'Registered groups: {len(d)}')
for k, v in d.items():
    print(f'  {k}: {v.get(\"name\", \"?\")} ({v.get(\"folder\", \"?\")})')
" 2>/dev/null || echo "groups.json: not found"
```

Informational — lists registered groups. No pass/fail.

---

## Check 7 — IPC Directories

```bash
ls data/ipc/ 2>/dev/null | while read folder; do
  pending=$(ls data/ipc/$folder/tasks/*.json 2>/dev/null | wc -l)
  echo "ipc/$folder: $pending pending tasks"
done || echo "data/ipc/: empty or not found"
```

⚠️  Warn: any folder with many stuck tasks (>10) may indicate a processing issue.

---

## Check 8 — Bash & Node Versions

```bash
node --version && npm --version && git --version
```

✅ Pass: all installed
❌ Fail: any missing

---

## Check 9 — Container Smoke Test (optional)

If the service is running, send a test ping via the container CLI tool (dry-run — no message sent):

```bash
node dist/index.js --health-check 2>/dev/null && echo "health-check: OK" || echo "health-check: not supported or failed"
```

Informational only.

---

## Summary Report

Use *single asterisks* for bold (WhatsApp/Telegram style — no markdown headings, no **double stars**).

```
*NanoClaw Host Diagnostic Report*
──────────────────────────────────
✅ Service            running
✅ Environment        .env present, API key set
ℹ️  Nanoclaw state    N skills applied
✅ Container runtime  Docker vX.Y / Apple Container vX
✅ Build artifacts    dist/ present (N JS files)
ℹ️  Registered groups N groups
ℹ️  IPC dirs          N groups, no stuck tasks
✅ Node & tools       node vX / npm vX / git vX
ℹ️  Smoke test        not supported
──────────────────────────────────
*Result: N/8 checks passed*
```

All passed:
```
✅ Host is healthy. To check the container itself, trigger a container agent and use load_skill("diagnose").
```

Any failures:
```
⚠️ One or more checks failed — see above before deploying.
```
