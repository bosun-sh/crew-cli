import { existsSync, mkdirSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { readJobResult, removeJobResult, writeJobResult } from "./job-store.js";
import { gh } from "./publication.js";
import { managedWorktreeRoot } from "./worktrees.js";
import { authorizedRevisions } from "./review-commands.js";

type TrackedPullRequest = { workId: string; root: string; repo: string; prUrl: string; prNumber: number; branch?: string };

export function trackPullRequest(config: Config, input: TrackedPullRequest): void {
  const directory = join(config.stateDir, "reviews");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeJobResult(directory, input.workId, { result: input });
}

export async function syncNextPullRequest(config: Config, signal: AbortSignal, fetchFn: typeof fetch = fetch, runGh = gh): Promise<void> {
  const directory = join(config.stateDir, "reviews");
  if (!existsSync(directory)) return;
  // ponytail: one PR per heartbeat keeps polling bounded; batch if review freshness needs it.
  const name = readdirSync(directory).filter((file) => file.endsWith(".json")).sort((a, b) => statSync(join(directory, a)).mtimeMs - statSync(join(directory, b)).mtimeMs)[0];
  if (!name) return;
  const workId = Buffer.from(name.slice(0, -5), "base64url").toString("utf8");
  const tracked = readJobResult(directory, workId)?.result as TrackedPullRequest | undefined;
  if (!tracked || managedWorktreeRoot(config, tracked.root) !== tracked.root) return;
  // Rotate failures too so one inaccessible PR cannot starve the other repositories.
  const now = new Date();
  utimesSync(join(directory, name), now, now);
  const outcome: unknown = JSON.parse(runGh({ root: tracked.root }, ["pr", "view", String(tracked.prNumber), "--repo", tracked.repo, "--json", "state,mergedAt,closedAt,reviewDecision"]));
  if (!outcome || typeof outcome !== "object") throw new Error("Invalid GitHub outcome");
  const revisions = "state" in outcome && outcome.state === "OPEN" ? authorizedRevisions(tracked.root, tracked.repo, tracked.prNumber, runGh) : [];
  const response = await fetchFn(`${config.dashboardUrl}/api/node/review`, {
    method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ ...outcome, workId: tracked.workId, prUrl: tracked.prUrl, branch: tracked.branch, revisions }),
  });
  if (!response.ok) throw new Error(`Review synchronization failed (${response.status})`);
  if ("state" in outcome && (outcome.state === "MERGED" || outcome.state === "CLOSED")) removeJobResult(directory, workId);
}
