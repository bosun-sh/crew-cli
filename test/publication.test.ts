import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testConfig, tempDir } from './helpers.js';
import { effectivePolicy } from '../src/policy.js';
import { finalizeWorkspace, prepareWorkspace, spawnGit } from '../src/tool-workspace.js';
import { publishWorkspace } from '../src/publication.js';
import { syncNextPullRequest } from '../src/review-sync.js';
import { revisionCommand, authorizedRevisions } from '../src/review-commands.js';
import { serviceDefinition } from '../src/worker-service.js';

test('publication validates authorization, reuses a PR after an ambiguous create, and synchronizes merge', async () => {
  const root = tempDir();
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Tester'], ['config', 'user.email', 'test@example.test']]) expect(spawnSync('git', args, { cwd: root }).status).toBe(0);
  writeFileSync(join(root, 'file'), 'base');
  for (const args of [['add', '.'], ['commit', '-m', 'base'], ['remote', 'add', 'origin', 'git@github.com:example/app.git']]) expect(spawnSync('git', args, { cwd: root }).status).toBe(0);
  const config = testConfig({ workspaceRoot: root, stateDir: tempDir(), auditDir: tempDir(), allowedCommands: new Set(['git']) });
  const context = { config, root, policy: effectivePolicy(config, { allowWrites: true, allowPublish: true }) };
  const { workspace } = prepareWorkspace({ runId: 'work', isolated: true }, context);
  const isolated = { ...context, root: workspace.root };
  writeFileSync(join(workspace.root, 'file'), 'changed');
  const committed = finalizeWorkspace({ workspace, runId: 'work', outcome: 'complete', goal: 'change' }, isolated);
  const input = { branch: workspace.branch, expectedSha: committed.sha, ownership: { workId: 'work', runId: 'run', attemptId: 'attempt', claimToken: 'claim' }, title: 'Task', body: 'Tests passed', outcome: 'complete' };
  let pushes = 0, creates = 0, exists = false;
  const git: typeof spawnGit = (path, args, timeout) => args[0] === 'push' ? (pushes++, { exitCode: 0, stdout: '', stderr: '' }) : spawnGit(path, args, timeout);
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    expect(init?.redirect).toBe('error');
    return Response.json({ workId: 'work', gitRemote: 'git@github.com:example/app.git', baseBranch: 'main', publishPr: true });
  }) as typeof fetch;
  const gh = (_context: { root: string }, args: string[]) => {
    if (args[1] === 'create') { creates++; exists = true; throw new Error('connection lost after acceptance'); }
    return JSON.stringify(exists ? [{ number: 1, url: 'https://github.com/example/app/pull/1', state: 'OPEN', isDraft: false }] : []);
  };
  await expect(publishWorkspace(input, isolated, { git, gh, fetch: (async (_url: unknown) => Response.json({}, { status: 409 })) as typeof fetch })).rejects.toThrow('authorization failed');
  expect(pushes).toBe(0);
  expect(await publishWorkspace(input, isolated, { git, gh, fetch: fetchFn })).toMatchObject({ status: 'published', prNumber: 1, existing: true });
  expect(await publishWorkspace(input, isolated, { git, gh, fetch: fetchFn })).toMatchObject({ status: 'published', prNumber: 1 });
  expect(creates).toBe(1);
  exists = false;
  let authorizations = 0;
  const cancelledAfterPush = (async (_url: unknown) => Response.json({ workId: 'work', gitRemote: 'git@github.com:example/app.git', baseBranch: 'main', publishPr: true, readOnly: ++authorizations > 1 })) as typeof fetch;
  expect(await publishWorkspace(input, isolated, { git, gh, fetch: cancelledAfterPush })).toMatchObject({ status: 'published', remoteBranchUrl: expect.any(String), reason: expect.stringContaining('before PR creation') });
  expect(creates).toBe(1);
  exists = true;
  const pushesBeforeRecovery = pushes;
  const recoveryFetch = (async (_url: unknown) => Response.json({ workId: 'work', gitRemote: 'git@github.com:example/app.git', baseBranch: 'main', publishPr: true, readOnly: true })) as typeof fetch;
  expect(await publishWorkspace(input, isolated, { git, gh, fetch: recoveryFetch })).toMatchObject({ status: 'published', existing: true });
  expect(pushes).toBe(pushesBeforeRecovery);
  expect(creates).toBe(1);
  let reports = 0;
  const report = (async (_url: unknown, init?: RequestInit) => { reports++; expect(JSON.parse(String(init?.body)).state).toBe('MERGED'); return Response.json({ ok: true }); }) as typeof fetch;
  await syncNextPullRequest(config, new AbortController().signal, report, () => JSON.stringify({ state: 'MERGED', mergedAt: new Date().toISOString(), closedAt: new Date().toISOString(), reviewDecision: 'APPROVED' }));
  await syncNextPullRequest(config, new AbortController().signal, report, () => { throw new Error('already terminal'); });
  expect(reports).toBe(1);
});

test('only explicit revision commands by write collaborators can launch revision requests', () => {
  expect(revisionCommand({ id: 1, user: { login: 'reviewer' }, body: 'Please revise this' })).toBeUndefined();
  expect(revisionCommand({ id: 1, user: { login: 'reviewer' }, body: '/crew revise' })).toBeUndefined();
  const requests = authorizedRevisions('/repo', 'example/app', 1, (_context, args) => {
    if (args.includes('--slurp')) return JSON.stringify([[{ id: 1, user: { login: 'reader' }, body: '/crew revise Please change it' }, { id: 2, user: { login: 'writer' }, body: '/crew revise Fix the test' }]]);
    return args[1]?.includes('/writer/') ? 'write' : 'read';
  });
  expect(requests).toEqual([{ id: 2, author: 'writer', feedback: 'Fix the test' }]);
});

test('service files escape paths without embedding credentials', () => {
  const id = 'a'.repeat(24);
  expect(serviceDefinition(id, 'darwin', '/path & space/node', '/app/cli.js', '/logs')).toContain('/path &amp; space/node');
  expect(serviceDefinition(id, 'linux', '/path %/node', '/app/cli.js', '/logs')).toContain('"/path %%/node"');
  expect(serviceDefinition(id, 'linux', '/node', '/cli.js', '/logs')).not.toContain('CREW_NODE_API_KEY');
});
