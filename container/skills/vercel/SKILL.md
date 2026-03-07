# Vercel Skill

Manage Vercel projects and deployments, fetch build logs, and tail runtime logs.

## Setup

Call `vercel__setup` with your personal access token:
```
vercel__setup({ token: "..." })
```
Generate a token at https://vercel.com/account/tokens. Optionally pass `default_team_id` to avoid specifying the team on every call.

If you already know your team ID, pass it during setup:
```
vercel__setup({ token: "...", default_team_id: "team_abc123" })
```

## Operations

### Teams & Projects
- `vercel__list_teams` — list all teams you belong to (use this to find team IDs)
- `vercel__list_projects` — list projects for a team or personal account
- `vercel__get_project` — get project details: framework, domains, env vars, latest deployment

### Deployments
- `vercel__list_deployments` — list deployments for a project (filter by target: production/preview)
- `vercel__get_deployment` — get full deployment details: status, regions, build duration, URL

### Logs
- `vercel__get_build_logs` — fetch build output for a deployment (great for diagnosing failed builds)
- `vercel__get_runtime_logs` — fetch runtime/function logs for a project. Supports filtering by:
  - `level`: error, warning, info, fatal
  - `environment`: production or preview
  - `since`/`until`: time range (e.g. "1h", "30m", "2026-03-01T00:00:00Z")
  - `query`: full-text search
  - `status_code`: e.g. "500", "4xx"

## Tips
- Use `vercel__list_teams` first to find your team ID if you don't know it
- Project IDs start with `prj_`, team IDs start with `team_` — but slugs work too
- For build failures, get the deployment ID from `list_deployments` then call `get_build_logs`
- Runtime logs default to the last 24 hours — narrow the range with `since`/`until` for faster results
