import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { nodeError } from "./errors.js";
import { readJobResult } from "./job-store.js";
import { basename } from "node:path";
import { checkPublishAllowed, commandEnv } from "./policy.js";
import { redactSecrets } from "./redact.js";
import { objectInput } from "./tool-input.js";
import { gitRaw, spawnGit } from "./tool-workspace.js";
import type { ToolContext } from "./tool-context.js";
import { managedWorktreeRoot } from "./worktrees.js";
import { trackPullRequest } from "./review-sync.js";

export async function publishWorkspace(input: unknown, context: ToolContext, deps: { fetch?: typeof fetch; git?: typeof spawnGit; gh?: typeof gh } = {}): Promise<unknown> {
  const git = deps.git ?? spawnGit;
  const runGh = deps.gh ?? gh;
  const value = objectInput(input);
  const permission = checkPublishAllowed(context.policy);
  if (!permission.allowed) throw nodeError("policy_denied", permission.reason ?? "Publishing denied", 403);
  if (managedWorktreeRoot(context.config, context.root) !== context.root) throw nodeError("policy_denied", "Publication requires an isolated worktree", 403);
  const saved = readJobResult(context.config.stateDir, `workspace-${basename(context.root)}`)?.result as { sourceRoot: string; branch: string; baseSha: string };
  const branch = gitRaw(context, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (branch !== saved.branch || value.branch !== branch) throw nodeError("policy_denied", "Publication branch does not match the run", 403);
  if (value.expectedSha !== undefined && gitRaw(context, ["rev-parse", "HEAD"]).stdout.trim() !== value.expectedSha) throw nodeError("policy_denied", "Publication commit is stale", 403);
  if (gitRaw(context, ["status", "--porcelain"]).stdout.trim()) throw nodeError("tool_failed", "Finalize all changes before publication", 409);
  const repoPath = relative(context.config.workspaceRoot, saved.sourceRoot).split("\\").join("/") || ".";
  const authorized = await authorizePublication(context, { ...objectInput(value.ownership), branch, repoPath, allowReconciliation: true }, deps.fetch ?? fetch);
  const diff = gitRaw(context, ["diff", "--quiet", `${saved.baseSha}..refs/heads/${branch}`, "--", "."]);
  if (diff.exitCode === 0) return { status: "no-change", branch, reason: "The finalized tree matches its base commit." };
  if (diff.exitCode !== 1) throw nodeError("tool_failed", "Could not verify the finalized diff", 500);
  const origin = git(context.root, ["remote", "get-url", "origin"], 30_000);
  if (origin.exitCode !== 0 || origin.stdout.trim() !== authorized.gitRemote) throw nodeError("policy_denied", "Origin no longer matches the authorized repository", 403);
  const remote = origin.stdout.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!remote || remote[1] === "." || remote[1] === ".." || remote[2] === "." || remote[2] === "..") throw nodeError("policy_denied", "Local publication currently requires a github.com origin", 403);
  const repo = `${remote[1]}/${remote[2]}`;
  const remoteBranchUrl = `https://github.com/${repo}/tree/${encodeURIComponent(branch)}`;
  const compareUrl = `https://github.com/${repo}/compare/${encodeURIComponent(authorized.baseBranch)}...${encodeURIComponent(branch)}`;
  const published = (pr: { prUrl: string; prNumber: number; draft: boolean }, existing: boolean) => {
    trackPullRequest(context.config, { workId: authorized.workId, root: context.root, repo, prUrl: pr.prUrl, prNumber: pr.prNumber, branch });
    return { status: "published", branch, remoteBranchUrl, compareUrl, ...pr, existing };
  };
  if (authorized.readOnly) {
    const existing = findPullRequest(context, repo, branch, runGh);
    if (existing) return published(existing, true);
    throw nodeError("policy_denied", "Publication attempt expired or cancelled; no existing PR found", 409);
  }
  // Use the customer's Git credential helper/SSH agent; no credentials cross the wire.
  const pushed = git(context.root, ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`], 120_000);
  if (pushed.exitCode !== 0) throw nodeError("tool_failed", "Could not push the run branch with local Git credentials", 500);
  if (!authorized.publishPr) return { status: "published", branch, remoteBranchUrl, compareUrl };
  const existing = findPullRequest(context, repo, branch, runGh);
  if (existing) return published(existing, true);
  // A push can outlive the lease or a cancellation. Recheck before creating a PR.
  const refreshed = await authorizePublication(context, { ...objectInput(value.ownership), branch, repoPath, allowReconciliation: true }, deps.fetch ?? fetch);
  if (refreshed.readOnly) return { status: "published", branch, remoteBranchUrl, compareUrl, reason: "Branch push completed; authorization ended before PR creation." };
  const title = bounded(value.title, 240, "title");
  const body = `${bounded(value.body, 60_000, "body")}\n\nImplemented by Crew using the repository owner's authorized worker.\nCrew work: ${context.config.dashboardUrl}/work/${encodeURIComponent(authorized.workId)}`;
  try {
    runGh(context, ["pr", "create", "--repo", repo, "--head", branch, "--base", authorized.baseBranch, "--title", title, "--body", body, ...(value.outcome === "complete" ? [] : ["--draft"])]);
  } catch (error) {
    // GitHub may have accepted the create before the connection failed.
    const raced = findPullRequest(context, repo, branch, runGh);
    if (raced) return published(raced, true);
    throw error;
  }
  const created = findPullRequest(context, repo, branch, runGh);
  if (!created) throw nodeError("tool_failed", "Pull request was created but its URL could not be recovered", 500);
  return published(created, false);
}

async function authorizePublication(context: ToolContext, input: Record<string, unknown>, fetchFn: typeof fetch): Promise<{ workId: string; gitRemote: string; baseBranch: string; publishPr: boolean; readOnly: boolean }> {
  const response = await fetchFn(`${context.config.dashboardUrl}/api/node/publication/authorize`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${context.config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw nodeError("policy_denied", `Publication authorization failed (${response.status})`, response.status === 409 ? 409 : 403);
  const result = objectInput(await response.json());
  if (typeof result.publishPr !== "boolean") throw nodeError("invalid_request", "Invalid publication authorization");
  if (result.readOnly !== undefined && typeof result.readOnly !== "boolean") throw nodeError("invalid_request", "Invalid publication recovery authorization");
  return { workId: bounded(result.workId, 128, "work id"), gitRemote: bounded(result.gitRemote, 2000, "remote"), baseBranch: bounded(result.baseBranch, 256, "base branch"), publishPr: result.publishPr, readOnly: result.readOnly === true };
}

function findPullRequest(context: ToolContext, repo: string, branch: string, runGh: typeof gh): { prUrl: string; prNumber: number; draft: boolean } | undefined {
  const rows: unknown = JSON.parse(runGh(context, ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "number,url,isDraft,state", "--limit", "100"]));
  if (!Array.isArray(rows)) throw nodeError("tool_failed", "Invalid GitHub pull request response", 500);
  const item = rows[0] as { number?: unknown; url?: unknown; isDraft?: unknown; state?: unknown } | undefined;
  if (!item) return undefined;
  if (!Number.isSafeInteger(item.number) || typeof item.url !== "string" || item.url !== `https://github.com/${repo}/pull/${item.number}`) throw nodeError("tool_failed", "Invalid GitHub pull request URL", 500);
  // A closed PR must never cause publication replay to create a second PR.
  return { prUrl: item.url, prNumber: item.number as number, draft: item.isDraft === true };
}

export function gh(context: Pick<ToolContext, "root">, argv: string[]): string {
  const env = commandEnv();
  // These credentials are scoped to this subprocess, never to model tools or output.
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR"]) if (process.env[name]) env[name] = process.env[name]!;
  env.GH_PROMPT_DISABLED = "1";
  const result = spawnSync("gh", argv, { cwd: context.root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000 });
  if (result.status !== 0) throw nodeError("tool_failed", "GitHub publication failed; verify local gh authentication and repository permissions", 500);
  return result.stdout;
}

function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw nodeError("invalid_request", `Invalid publication ${label}`);
  return redactSecrets(value);
}
