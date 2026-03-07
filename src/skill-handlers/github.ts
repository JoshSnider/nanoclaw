/**
 * Host-side handler for the GitHub skill.
 * Uses @octokit/rest — credentials never exposed to containers.
 */
import { registerSkillHandler } from '../mcp-registry.js';
import { Octokit } from '@octokit/rest';

function getOctokit(credentials: Record<string, string>): Octokit {
  if (!credentials.token) {
    throw new Error(
      'GitHub token not configured. Ask the user to run github__setup with their token.',
    );
  }
  return new Octokit({ auth: credentials.token });
}

// --- Setup ---

registerSkillHandler('github', 'setup', async (params, ctx) => {
  const { setSkillCredential } = await import('../db.js');
  const token = params.token as string;
  if (!token) throw new Error('token is required');
  // Verify the token works
  const octokit = new Octokit({ auth: token });
  const { data: user } = await octokit.users.getAuthenticated();
  setSkillCredential(ctx.groupFolder, 'github', 'token', token);
  return `Authenticated as ${user.login}. Token stored.`;
});

// --- Repos & Files ---

registerSkillHandler('github', 'get_repo', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.repos.get({
    owner: params.owner as string,
    repo: params.repo as string,
  });
  return {
    full_name: data.full_name,
    description: data.description,
    default_branch: data.default_branch,
    language: data.language,
    stargazers_count: data.stargazers_count,
    open_issues_count: data.open_issues_count,
    private: data.private,
    html_url: data.html_url,
  };
});

registerSkillHandler('github', 'list_branches', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.repos.listBranches({
    owner: params.owner as string,
    repo: params.repo as string,
    per_page: (params.per_page as number) || 30,
  });
  return data.map((b) => ({ name: b.name, sha: b.commit.sha }));
});

registerSkillHandler('github', 'create_branch', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const owner = params.owner as string;
  const repo = params.repo as string;
  // Get the SHA to branch from
  let sha: string;
  if (params.from_branch) {
    const { data: ref } = await ok.git.getRef({
      owner,
      repo,
      ref: `heads/${params.from_branch as string}`,
    });
    sha = ref.object.sha;
  } else {
    const { data: repoData } = await ok.repos.get({ owner, repo });
    const { data: ref } = await ok.git.getRef({
      owner,
      repo,
      ref: `heads/${repoData.default_branch}`,
    });
    sha = ref.object.sha;
  }
  const { data } = await ok.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${params.branch as string}`,
    sha,
  });
  return { ref: data.ref, sha: data.object.sha };
});

registerSkillHandler('github', 'get_file', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.repos.getContent({
    owner: params.owner as string,
    repo: params.repo as string,
    path: params.path as string,
    ref: params.ref as string | undefined,
  });
  if (Array.isArray(data))
    throw new Error('Path is a directory, use list_files instead');
  if (!('content' in data)) throw new Error('Not a file');
  return {
    path: data.path,
    size: data.size,
    sha: data.sha,
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
  };
});

registerSkillHandler('github', 'list_files', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.repos.getContent({
    owner: params.owner as string,
    repo: params.repo as string,
    path: (params.path as string) || '',
    ref: params.ref as string | undefined,
  });
  if (!Array.isArray(data))
    throw new Error('Path is a file, use get_file instead');
  return data.map((f) => ({
    name: f.name,
    path: f.path,
    type: f.type,
    size: f.size,
  }));
});

// --- Issues ---

registerSkillHandler('github', 'list_issues', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.issues.listForRepo({
    owner: params.owner as string,
    repo: params.repo as string,
    state: (params.state as 'open' | 'closed' | 'all') || 'open',
    labels: params.labels as string | undefined,
    per_page: (params.per_page as number) || 30,
  });
  return data
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
      user: i.user?.login,
      created_at: i.created_at,
      comments: i.comments,
    }));
});

registerSkillHandler('github', 'get_issue', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const owner = params.owner as string;
  const repo = params.repo as string;
  const issue_number = params.issue_number as number;
  const [{ data: issue }, { data: comments }] = await Promise.all([
    ok.issues.get({ owner, repo, issue_number }),
    ok.issues.listComments({ owner, repo, issue_number, per_page: 100 }),
  ]);
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body,
    user: issue.user?.login,
    labels: issue.labels.map((l) => (typeof l === 'string' ? l : l.name)),
    created_at: issue.created_at,
    comments: comments.map((c) => ({
      user: c.user?.login,
      body: c.body,
      created_at: c.created_at,
    })),
  };
});

registerSkillHandler('github', 'create_issue', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const labels = params.labels
    ? (params.labels as string).split(',').map((l) => l.trim())
    : undefined;
  const { data } = await ok.issues.create({
    owner: params.owner as string,
    repo: params.repo as string,
    title: params.title as string,
    body: params.body as string | undefined,
    labels,
  });
  return { number: data.number, html_url: data.html_url };
});

registerSkillHandler('github', 'comment_on_issue', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.issues.createComment({
    owner: params.owner as string,
    repo: params.repo as string,
    issue_number: params.issue_number as number,
    body: params.body as string,
  });
  return { id: data.id, html_url: data.html_url };
});

registerSkillHandler('github', 'search_issues', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.search.issuesAndPullRequests({
    q: params.query as string,
    per_page: (params.per_page as number) || 30,
  });
  return {
    total_count: data.total_count,
    items: data.items.map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      repository: i.repository_url.replace('https://api.github.com/repos/', ''),
      user: i.user?.login,
      html_url: i.html_url,
      is_pr: !!i.pull_request,
    })),
  };
});

// --- Pull Requests ---

registerSkillHandler('github', 'list_prs', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.pulls.list({
    owner: params.owner as string,
    repo: params.repo as string,
    state: (params.state as 'open' | 'closed' | 'all') || 'open',
    per_page: (params.per_page as number) || 30,
  });
  return data.map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    user: p.user?.login,
    head: p.head.ref,
    base: p.base.ref,
    created_at: p.created_at,
    draft: p.draft,
  }));
});

registerSkillHandler('github', 'get_pr', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.pulls.get({
    owner: params.owner as string,
    repo: params.repo as string,
    pull_number: params.pull_number as number,
  });
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    body: data.body,
    user: data.user?.login,
    head: data.head.ref,
    base: data.base.ref,
    mergeable: data.mergeable,
    merged: data.merged,
    draft: data.draft,
    additions: data.additions,
    deletions: data.deletions,
    changed_files: data.changed_files,
    html_url: data.html_url,
  };
});

registerSkillHandler('github', 'create_pr', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.pulls.create({
    owner: params.owner as string,
    repo: params.repo as string,
    title: params.title as string,
    body: params.body as string | undefined,
    head: params.head as string,
    base: params.base as string,
  });
  return { number: data.number, html_url: data.html_url };
});

registerSkillHandler('github', 'merge_pr', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.pulls.merge({
    owner: params.owner as string,
    repo: params.repo as string,
    pull_number: params.pull_number as number,
    merge_method:
      (params.merge_method as 'merge' | 'squash' | 'rebase') || 'merge',
  });
  return { merged: data.merged, message: data.message, sha: data.sha };
});

registerSkillHandler('github', 'list_pr_files', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.pulls.listFiles({
    owner: params.owner as string,
    repo: params.repo as string,
    pull_number: params.pull_number as number,
    per_page: 100,
  });
  return data.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));
});

registerSkillHandler('github', 'list_pr_comments', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.pulls.listReviewComments({
    owner: params.owner as string,
    repo: params.repo as string,
    pull_number: params.pull_number as number,
    per_page: 100,
  });
  return data.map((c) => ({
    id: c.id,
    user: c.user?.login,
    body: c.body,
    path: c.path,
    line: c.line,
    created_at: c.created_at,
  }));
});

registerSkillHandler('github', 'create_pr_review', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.pulls.createReview({
    owner: params.owner as string,
    repo: params.repo as string,
    pull_number: params.pull_number as number,
    body: params.body as string,
    event: params.event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  });
  return { id: data.id, state: data.state, html_url: data.html_url };
});

// --- Code Search ---

registerSkillHandler('github', 'search_code', async (params, ctx) => {
  const ok = getOctokit(ctx.credentials);
  const { data } = await ok.search.code({
    q: params.query as string,
    per_page: (params.per_page as number) || 30,
  });
  return {
    total_count: data.total_count,
    items: data.items.map((i) => ({
      name: i.name,
      path: i.path,
      repository: i.repository.full_name,
      html_url: i.html_url,
    })),
  };
});
