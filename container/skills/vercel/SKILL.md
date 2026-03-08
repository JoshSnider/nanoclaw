# Vercel Skill

Manage Vercel projects, deployments, and logs. Tools are available as `mcp__nanoclaw__vercel__*`.

Use `load_skill("vercel")` to activate and register all tools.

## Tips

- Project IDs start with `prj_`, team IDs start with `team_` — but slugs work too
- For build failures, get the deployment ID then fetch build logs
- Runtime logs default to the last 24 hours — narrow the range for faster results
