/**
 * Host-side handler for the Vercel skill.
 * Plain ESM — no build step needed. Drop this file and it works immediately.
 * Credentials are stored in the NanoClaw DB and never exposed to containers.
 */

const VERCEL_API = 'https://api.vercel.com';

function getClient(credentials) {
  if (!credentials.token) {
    throw new Error(
      'Vercel token not configured. Ask the user to run vercel__setup with their token.',
    );
  }
  return { token: credentials.token, defaultTeamId: credentials.default_team_id };
}

async function vercelFetch(client, path, options = {}) {
  const url = `${VERCEL_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${client.token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vercel API error ${res.status}: ${body}`);
  }
  return res.json();
}

function teamQs(teamId, defaultTeamId) {
  const id = teamId || defaultTeamId;
  return id ? `?teamId=${encodeURIComponent(id)}` : '';
}

export default {

  // --- Setup ---

  async setup(params, ctx) {
    const token = params.token;
    if (!token) throw new Error('token is required');

    // Verify the token works
    const res = await fetch(`${VERCEL_API}/v2/user`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Invalid token or Vercel API error ${res.status}: ${body}`);
    }
    const data = await res.json();
    const user = data.user;

    ctx.setCredential('token', token);
    if (params.default_team_id) {
      ctx.setCredential('default_team_id', String(params.default_team_id));
    }

    const identity = user?.username || user?.email || 'unknown';
    const teamNote = params.default_team_id ? ` Default team: ${params.default_team_id}.` : '';
    return `Authenticated as ${identity}. Token stored.${teamNote}`;
  },

  // --- Teams ---

  async list_teams(params, ctx) {
    const client = getClient(ctx.credentials);
    const data = await vercelFetch(client, '/v2/teams');
    return (data.teams ?? []).map((t) => ({ id: t.id, slug: t.slug, name: t.name }));
  },

  // --- Projects ---

  async list_projects(params, ctx) {
    const client = getClient(ctx.credentials);
    const teamId = params.team_id || client.defaultTeamId;
    const qs = new URLSearchParams({ limit: String(params.limit ?? 20) });
    if (teamId) qs.set('teamId', teamId);
    const data = await vercelFetch(client, `/v9/projects?${qs}`);
    return (data.projects ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      framework: p.framework,
      latest_deployment: p.latestDeployments?.[0]
        ? {
            url: p.latestDeployments[0].url,
            state: p.latestDeployments[0].readyState,
            target: p.latestDeployments[0].target,
          }
        : null,
    }));
  },

  async get_project(params, ctx) {
    const client = getClient(ctx.credentials);
    const qs = teamQs(params.team_id, client.defaultTeamId);
    const data = await vercelFetch(
      client,
      `/v9/projects/${encodeURIComponent(params.project_id)}${qs}`,
    );
    return {
      id: data.id,
      name: data.name,
      framework: data.framework,
      repo: data.link?.repo,
      domains: (data.alias ?? []).map((a) => a.domain),
      latest_deployment: data.latestDeployments?.[0]
        ? {
            id: data.latestDeployments[0].id,
            url: data.latestDeployments[0].url,
            state: data.latestDeployments[0].readyState,
            target: data.latestDeployments[0].target,
            created_at: data.latestDeployments[0].createdAt
              ? new Date(data.latestDeployments[0].createdAt).toISOString()
              : null,
          }
        : null,
      env_vars: (data.env ?? []).map((e) => ({ key: e.key, targets: e.target })),
    };
  },

  // --- Deployments ---

  async list_deployments(params, ctx) {
    const client = getClient(ctx.credentials);
    const qs = new URLSearchParams({
      projectId: params.project_id,
      limit: String(params.limit ?? 10),
    });
    const teamId = params.team_id || client.defaultTeamId;
    if (teamId) qs.set('teamId', teamId);
    if (params.target) qs.set('target', params.target);
    const data = await vercelFetch(client, `/v6/deployments?${qs}`);
    return (data.deployments ?? []).map((d) => ({
      id: d.uid,
      url: d.url,
      state: d.readyState ?? d.state,
      target: d.target,
      created_at: d.createdAt ? new Date(d.createdAt).toISOString() : null,
      branch: d.meta?.githubCommitRef,
      commit_message: d.meta?.githubCommitMessage,
    }));
  },

  async get_deployment(params, ctx) {
    const client = getClient(ctx.credentials);
    const qs = teamQs(params.team_id, client.defaultTeamId);
    const data = await vercelFetch(
      client,
      `/v13/deployments/${encodeURIComponent(params.deployment_id)}${qs}`,
    );
    const buildDuration =
      data.ready && data.buildingAt
        ? Math.round((data.ready - data.buildingAt) / 1000)
        : null;
    return {
      id: data.id,
      url: data.url,
      project: data.name,
      state: data.readyState,
      target: data.target,
      regions: data.regions,
      created_at: data.createdAt ? new Date(data.createdAt).toISOString() : null,
      build_duration_seconds: buildDuration,
      branch: data.meta?.githubCommitRef,
      commit: data.meta?.githubCommitSha?.slice(0, 8),
      commit_message: data.meta?.githubCommitMessage,
      repo: data.meta?.githubRepo,
      error: data.errorMessage,
    };
  },

  // --- Logs ---

  async get_build_logs(params, ctx) {
    const client = getClient(ctx.credentials);
    const qs = new URLSearchParams({ direction: 'forward', follow: '0' });
    const teamId = params.team_id || client.defaultTeamId;
    if (teamId) qs.set('teamId', teamId);
    const data = await vercelFetch(
      client,
      `/v2/deployments/${encodeURIComponent(params.deployment_id)}/events?${qs}`,
    );
    const lines = Array.isArray(data) ? data : [];
    return lines
      .slice(0, params.limit ?? 100)
      .filter((e) => e.payload?.text)
      .map((e) => ({
        timestamp: e.payload?.date ? new Date(e.payload.date).toISOString() : null,
        level: e.payload?.level,
        text: e.payload?.text,
      }));
  },

  async get_runtime_logs(params, ctx) {
    const client = getClient(ctx.credentials);
    const qs = new URLSearchParams({
      projectId: params.project_id,
      limit: String(params.limit ?? 50),
    });
    const teamId = params.team_id || client.defaultTeamId;
    if (teamId) qs.set('teamId', teamId);
    if (params.deployment_id) qs.set('deploymentId', params.deployment_id);
    if (params.environment) qs.set('environment', params.environment);
    if (params.status_code) qs.set('statusCode', params.status_code);
    if (params.query) qs.set('query', params.query);
    if (params.since) qs.set('since', params.since);
    if (params.until) qs.set('until', params.until);
    if (params.level) {
      for (const lvl of String(params.level).split(',')) qs.append('level', lvl.trim());
    }
    const data = await vercelFetch(client, `/v1/logs?${qs}`);
    return (data.logs ?? []).map((l) => ({
      timestamp: l.timestamp,
      level: l.level,
      message: l.message,
      status_code: l.statusCode,
      source: l.source,
      environment: l.environment,
      deployment_id: l.deploymentId,
      request_id: l.requestId,
    }));
  },
};
