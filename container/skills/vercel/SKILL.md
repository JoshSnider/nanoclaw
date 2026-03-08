# Vercel Skill

Manage Vercel projects, deployments, and logs via Vercel's remote MCP server.

## Setup

Store the Vercel token using `set_credential`:
```
set_credential({ skill: "vercel", key: "token", value: "..." })
```
Generate a token at https://vercel.com/account/tokens.

After the credential is stored, the host connects to Vercel's MCP server and tools are immediately available. No restart needed.

## Available Tools

Tools are discovered dynamically from the remote MCP server. Common ones include project management, deployment listing, build/runtime log fetching, and domain configuration.

## Tips

- Project IDs start with `prj_`, team IDs start with `team_` — but slugs work too
- For build failures, get the deployment ID then fetch build logs
- Runtime logs default to the last 24 hours — narrow the range for faster results
