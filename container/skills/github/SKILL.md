# GitHub Skill

Interact with GitHub repos, issues, pull requests, and code search.

## Setup

Call `github__setup` with your personal access token:
```
github__setup({ token: "ghp_..." })
```
You can generate a token at https://github.com/settings/tokens. Required scopes: `repo`, `read:org`.

If `gh` CLI is authenticated on the host, you can also run `gh auth token` to get the token.

## Operations

### Repos & Files
- `github__get_repo` — repo metadata (description, stars, default branch, etc.)
- `github__list_files` — list directory contents in a repo
- `github__get_file` — read a file's contents from a repo
- `github__list_branches` — list branches
- `github__create_branch` — create a new branch from an existing ref

### Issues
- `github__list_issues` — list issues (filter by state, labels)
- `github__get_issue` — get issue details + comments
- `github__create_issue` — create a new issue
- `github__comment_on_issue` — add a comment (works for PRs too)
- `github__search_issues` — search issues/PRs with GitHub query syntax

### Pull Requests
- `github__list_prs` — list PRs (filter by state)
- `github__get_pr` — get PR details (diff stats, mergeable, checks)
- `github__create_pr` — open a new PR
- `github__merge_pr` — merge a PR (merge, squash, or rebase)
- `github__list_pr_files` — list changed files in a PR
- `github__list_pr_comments` — list review comments
- `github__create_pr_review` — submit a review (approve, request changes, comment)

### Search
- `github__search_code` — search code across repos (GitHub code search syntax)
- `github__search_issues` — search issues and PRs

## Tips
- Use `owner/repo` format from the repo URL: `github.com/{owner}/{repo}`
- Search queries use GitHub syntax, e.g. `"useState repo:facebook/react language:typescript"`
- PR reviews use events: `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`
- `comment_on_issue` works for both issues and PRs (they share the same comment API)
