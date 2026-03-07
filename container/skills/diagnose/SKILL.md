---
name: diagnose
description: Run a full diagnostic health check of this container session. Exercises bash, filesystem mounts, network, memory search, task scheduler, and the skills system. Read-only — any writes are to /tmp and cleaned up immediately. Use after container rebuilds or dependency changes to verify everything works.
---

# NanoClaw Container Diagnostic

Run all checks below. Collect results silently, then print *one* formatted summary report at the end.

---

## Check 1 — Bash & Core Tools

```bash
node --version && npm --version && git --version && curl --version | head -1
```

✅ Pass: all four tools return version strings
❌ Fail: any tool missing or exits non-zero

---

## Check 2 — Filesystem Mounts

### 2a. Read mounts

```bash
echo "group: $(ls /workspace/group/ | wc -l) items"
ls /workspace/shared/ 2>/dev/null && echo "shared: OK" || echo "shared: NOT MOUNTED"
ls /workspace/ipc/ 2>/dev/null && echo "ipc: OK" || echo "ipc: NOT MOUNTED"
ls /workspace/env-dir/ 2>/dev/null && echo "env-dir: OK" || echo "env-dir: NOT MOUNTED"
ls /workspace/project/ 2>/dev/null && echo "project: OK" || echo "project: NOT MOUNTED"
```

✅ Pass: `/workspace/group/` readable
⚠️  Warn: note any mounts that are absent

### 2b. Write test (ephemeral — cleaned up)

```bash
TESTFILE=/tmp/nanoclaw-diag-$$.txt
echo "diag-$(date -u +%s)" > "$TESTFILE" && cat "$TESTFILE" && rm "$TESTFILE" && echo "tmp-write: OK"
```

```bash
TESTFILE=/workspace/group/diag-test-$$.tmp
echo "diag-$(date -u +%s)" > "$TESTFILE" && cat "$TESTFILE" && rm "$TESTFILE" && echo "group-write: OK"
```

✅ Pass: both "OK" lines appear and files are removed
❌ Fail: write or delete fails

---

## Check 3 — Network

```bash
curl -s --max-time 10 https://httpbin.org/get | grep '"url"' || \
  curl -s --max-time 10 https://example.com | grep -c "Example Domain" | xargs echo "example.com lines:"
```

✅ Pass: valid HTTP response received
❌ Fail: timeout or empty response

---

## Check 4 — Memory Search

Call the `search_memory` tool with the query `"nanoclaw"`. Verify it returns without error. Record result count (0 is fine).

✅ Pass: tool responds (any result count)
❌ Fail: tool errors or is unavailable

---

## Check 5 — Task Scheduler

Call the `list_tasks` tool. Verify it responds without error. Record count of active tasks.

✅ Pass: tool responds
❌ Fail: tool errors or is unavailable

---

## Check 6 — Environment Variables

```bash
for var in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ASSISTANT_NAME; do
  [ -n "${!var}" ] && echo "$var: SET" || echo "$var: MISSING"
done
[ -f /workspace/env-dir/env ] && echo "env-file: present ($(wc -l < /workspace/env-dir/env) lines)" || echo "env-file: not found"
```

✅ Pass: at least one of `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is SET
❌ Fail: neither auth key is present

---

## Check 7 — Git

```bash
git -C /workspace/project log --oneline -1 2>/dev/null && echo "git-repo: accessible" || echo "git-repo: not mounted or no commits"
git config --global user.name 2>/dev/null && echo "git-identity: configured" || echo "git-identity: NOT configured (commits would fail)"
```

✅ Pass: git installed; identity warning is OK
❌ Fail: git not installed

---

## Check 8 — Skills System

Call `list_skills`. Record the number of available skills. Verify the tool responds without error.

Also check:

```bash
[ -f /workspace/group/.skill-index.json ] && echo "skill-index: present" || echo "skill-index: absent"
```

✅ Pass: `list_skills` responds
⚠️  Warn: skill index absent (no host-side MCP skills active)
❌ Fail: `list_skills` tool unavailable

---

## Check 9 — NanoClaw State (if project mounted)

```bash
[ -f /workspace/project/.nanoclaw/state.yaml ] && \
  grep "applied_skills" /workspace/project/.nanoclaw/state.yaml && \
  echo "state: readable" || \
  echo "state: not accessible"
```

Informational — list applied skills. No pass/fail.

---

## Summary Report

Format using *single asterisks* for bold (WhatsApp/Telegram style). Do NOT use markdown headings or double stars.

```
*NanoClaw Diagnostic Report*
────────────────────────────
✅ Bash & tools       node vX / npm vX / git vX / curl vX
✅ Filesystem read    group ✓  shared ✓  ipc ✓  env-dir ✓
✅ Filesystem write   tmp ✓  group ✓
✅ Network            httpbin.org OK
✅ Memory search      OK (N results)
✅ Task scheduler     OK (N tasks scheduled)
✅ Environment        API key set
⚠️  Git identity      not configured
✅ Skills system      OK (N skills available)
ℹ️  Nanoclaw state    N skills applied
────────────────────────────
*Result: N/9 checks passed*
```

If any check *failed*:
```
⚠️ One or more checks failed — review above before using this container.
```

If all passed (warnings OK):
```
✅ All checks passed. Container is healthy.
```
