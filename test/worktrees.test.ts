import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execute, tempDir, testConfig } from "./helpers.js";
import { initializeEmptyRepository, repositoryRoot } from '../src/repository.js';

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test('explicit empty initialization is resumable and never stages developer files', () => {
  const root = tempDir(), remote = tempDir(), state = tempDir();
  git(root, 'init', '-b', 'main'); git(remote, 'init', '--bare'); git(root, 'remote', 'add', 'origin', remote);
  expect(repositoryRoot(root)).toBe(root);
  writeFileSync(join(root, 'private.txt'), 'developer work');
  expect(() => initializeEmptyRepository(root, state)).toThrow('no staged/untracked files');
  expect(spawnSync('git', ['show-ref'], { cwd: remote }).status).toBe(1);
});

test('empty base publication keeps one commit across setup retries', () => {
  const root = tempDir(), remote = tempDir(), state = tempDir();
  git(root, 'init', '-b', 'main'); git(remote, 'init', '--bare'); git(root, 'remote', 'add', 'origin', remote);
  expect(initializeEmptyRepository(root, state)).toBe('main');
  const sha = git(root, 'rev-parse', 'HEAD');
  expect(git(root, 'ls-tree', '-r', 'HEAD')).toBe('');
  expect(initializeEmptyRepository(root, state)).toBe('main');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(sha);
  expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(sha);
});

test("isolated worktrees survive replay without changing a dirty developer checkout", async () => {
  const root = tempDir();
  const stateDir = tempDir();
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Tester");
  git(root, "config", "user.email", "test@example.test");
  writeFileSync(join(root, "file.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  writeFileSync(join(root, "file.txt"), "staged developer work\n");
  git(root, "add", ".");
  writeFileSync(join(root, "file.txt"), "unstaged developer work\n");
  const before = git(root, "diff", "HEAD");
  const staged = git(root, "diff", "--cached");
  const config = testConfig({ workspaceRoot: root, stateDir, auditDir: tempDir(), allowedCommands: new Set(["git"]) });
  const policy = { allowWrites: true, allowedCommands: ["git"] };
  const request = { root, policy, tool: "prepare-workspace", input: { runId: "work-1", isolated: true, baseBranch: "main" } };
  const preparedResponse = await execute(config, request);
  expect(preparedResponse.status).toBe(200);
  const prepared = await preparedResponse.json();
  expect(prepared.workspace.root).not.toBe(root);
  expect(readFileSync(join(prepared.workspace.root, "file.txt"), "utf8")).toBe("original\n");
  expect(await (await execute(config, request)).json()).toEqual(prepared);
  // Recovery uses the saved base even if the developer renamed the base branch.
  git(root, "branch", "-m", "main", "renamed-main");
  expect(await (await execute(config, request)).json()).toEqual(prepared);
  git(root, "branch", "-m", "renamed-main", "main");
  const write = await execute(config, { root: prepared.workspace.root, policy, tool: "write-repo-file", input: { path: "file.txt", content: "agent change\n" } });
  expect(write.status).toBe(200);
  const finalize = { root: prepared.workspace.root, policy, tool: "finalize-workspace", input: { workspace: prepared.workspace, runId: "work-1", outcome: "complete", goal: "update" } };
  expect(await (await execute(config, finalize)).json()).toMatchObject({ committed: true });
  expect(await (await execute(config, finalize)).json()).toEqual({ committed: false });
  expect(git(root, "branch", "--show-current")).toBe("main");
  expect(git(root, "diff", "HEAD")).toBe(before);
  expect(git(root, "diff", "--cached")).toBe(staged);
  expect(git(root, "status", "--porcelain")).toBe("MM file.txt");
  expect((await execute(config, { ...finalize, root })).status).toBe(403);
  expect((await execute(config, { root: prepared.workspace.root, policy, tool: "write-repo-file", input: { path: ".git", content: "gitdir: /elsewhere" } })).status).toBe(403);
  expect((await execute(config, { root: stateDir, tool: "list-repo-files", input: {} })).status).toBe(403);
  expect((await execute(config, { root: tempDir(), tool: "list-repo-files", input: {} })).status).toBe(403);
});

test("publication replay pushes the run branch after a previous commit and failed push", async () => {
  const root = tempDir();
  const remote = tempDir();
  git(root, "init", "-b", "main");
  git(remote, "init", "--bare");
  git(root, "config", "user.name", "Tester");
  git(root, "config", "user.email", "test@example.test");
  writeFileSync(join(root, "file.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const config = testConfig({ workspaceRoot: root, stateDir: tempDir(), auditDir: tempDir(), allowedCommands: new Set(["git"]) });
  const policy = { allowWrites: true, allowedCommands: ["git"], allowPublish: true };
  const prepared = await (await execute(config, { root, policy, tool: "prepare-workspace", input: { runId: "retry", isolated: true } })).json();
  writeFileSync(join(prepared.workspace.root, "file.txt"), "agent\n");
  const finalize = { root: prepared.workspace.root, policy, tool: "finalize-workspace", input: { workspace: prepared.workspace, outcome: "complete", goal: "update", runId: "retry", publishRemote: true } };
  expect((await execute(config, finalize)).status).toBe(500);
  const sha = git(prepared.workspace.root, "rev-parse", "HEAD");
  git(root, "remote", "add", "origin", remote);
  expect((await execute(config, finalize)).status).toBe(200);
  expect(git(remote, "rev-parse", "refs/heads/crew/retry")).toBe(sha);
  expect(git(root, "branch", "--show-current")).toBe("main");
});
