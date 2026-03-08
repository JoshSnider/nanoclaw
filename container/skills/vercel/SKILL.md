# Vercel Skill

Manage Vercel projects, deployments, and logs via Vercel's remote MCP server.

## Setup

Call `vercel__setup` with a personal access token:
```
vercel__setup({ token: "..." })
```
Generate a token at https://vercel.com/account/tokens.

After setup, Vercel's tools are auto-discovered and immediately available. No restart needed.

## Available Tools

Tools are discovered dynamically from the remote MCP server. Common ones include project management, deployment listing, build/runtime log fetching, and domain configuration.

## Tips

- Project IDs start with `prj_`, team IDs start with `team_` — but slugs work too
- For build failures, get the deployment ID then fetch build logs
- Runtime logs default to the last 24 hours — narrow the range for faster results
