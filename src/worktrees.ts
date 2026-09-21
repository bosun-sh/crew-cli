import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Config } from "./config.js";
import { nodeError } from "./errors.js";
import { readJobResult, writeJobResult } from "./job-store.js";
import { checkCommandAllowed, requireInsideWorkspace } from "./policy.js";
import type { ToolContext } from "./tool-context.js";
import { gitRaw, spawnGit } from "./tool-workspace.js";
import type { WorkspaceHandle } from "./types.js";

// Metadata stays outside the worktree, so repository file tools cannot forge it.
export function managedWorktreeRoot(config: Config, candidate: string): string | undefined {
  const parent = resolve(config.stateDir, "worktrees");
  if (dirname(candidate) !== parent || !/^[a-f0-9]{64}$/.test(basename(candidate))) return undefined;
  const saved = readJobResult(config.stateDir, `workspace-${basename(candidate)}`)?.result as (WorkspaceHandle & { sourceRoot: string }) | undefined;
  if (!saved || saved.root !== candidate || typeof saved.sourceRoot !== "string") return undefined;
  requireInsideWorkspace(config.workspaceRoot, saved.sourceRoot, "repository");
  const actual = realpathSync(candidate);
  if (actual !== candidate) throw nodeError("policy_denied", "Worktree path was replaced by a symlink", 403);
  return actual;
}

export function prepareIsolatedWorkspace(context: ToolContext, runId: string, baseBranch?: string): WorkspaceHandle {
  const key = createHash("sha256").update(`${context.root}\0${runId}`).digest("hex");
  const root = join(resolve(context.config.stateDir), "worktrees", key);
  const branch = `crew/${runId}`;
  const stored = readJobResult(context.config.stateDir, `workspace-${key}`)?.result as (WorkspaceHandle & { sourceRoot: string }) | undefined;
  if (stored && (stored.sourceRoot !== context.root || stored.root !== root || stored.branch !== branch)) {
    throw nodeError("policy_denied", "Worktree metadata does not match this repository and run", 403);
  }
  if (existsSync(root)) {
    if (!stored || managedWorktreeRoot(context.config, root) !== root || gitRaw({ ...context, root }, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim() !== branch) {
      throw nodeError("tool_failed", "Existing worktree does not match this run", 409);
    }
    return stored;
  }
  const current = gitRaw(context, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  const base = baseBranch ?? (current === "HEAD" ? "" : current);
  const head = stored ? undefined : gitRaw(context, ["rev-parse", "--verify", base ? `refs/heads/${base}` : "HEAD"]);
  if (head && head.exitCode !== 0) throw nodeError("tool_failed", "Workspace requires an existing base commit", 409);
  const workspace = stored ?? { root, branch, baseSha: head!.stdout.trim(), baseBranch: base, createdAt: new Date().toISOString(), sourceRoot: context.root };
  // Persist the intent before Git: a restart reuses the same branch and path.
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  if (realpathSync(dirname(root)) !== dirname(root)) throw nodeError("policy_denied", "Worktree directory must not be a symlink", 403);
  const permission = checkCommandAllowed(context.policy, ["git", "branch"]);
  if (!permission.allowed || context.policy.deniedCommands.includes("git worktree")) throw nodeError("policy_denied", permission.reason ?? "git worktree is denied", 403);
  const existingBranch = gitRaw(context, ["rev-parse", "--verify", `refs/heads/${branch}`]).exitCode === 0;
  if (existingBranch && !stored) throw nodeError("tool_failed", "Run branch already exists without a worktree intent", 409);
  writeJobResult(context.config.stateDir, `workspace-${key}`, { result: workspace });
  // Worktree is deliberately unavailable to run-command: only this fixed destination is allowed.
  const result = spawnGit(context.root, ["worktree", "add", ...(existingBranch ? [root, branch] : ["-b", branch, root, workspace.baseSha])], 30_000);
  if (result.exitCode !== 0) throw nodeError("tool_failed", `Could not create isolated worktree: ${result.stderr.trim()}`, 500);
  return workspace;
}
