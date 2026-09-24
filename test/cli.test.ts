import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './helpers.js';

test('CLI requires paid-work approval and submits the displayed lifecycle cap', async () => {
  const home = tempDir();
  const root = tempDir();
  expect(Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd: root }).exitCode).toBe(0);
  mkdirSync(join(root, 'nested'));
  const submissions: Record<string, unknown>[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    expect(request.headers.get('x-crew-organization')).toBe('org');
    if (new URL(request.url).pathname.endsWith('/session')) return Response.json({ organizationId: 'org', organizationName: 'Test' });
    if (request.method === 'POST') { submissions.push(await request.json() as Record<string, unknown>); return Response.json({ work: { id: 'work' } }); }
    return Response.json({ budget: { taskUsd: 2, goalUsd: 8 }, work: [], schedules: [], repositories: [] });
  } });
  const dashboardUrl = `http://127.0.0.1:${server.port}`;
  const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const save = (directory: string, name: string, result: unknown) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${Buffer.from(name).toString('base64url')}.json`), JSON.stringify({ result }), { mode: 0o600 });
  };
  save(join(home, '.crew/client'), 'session', { dashboardUrl, organizationId: 'org', token: 'test-session' });
  save(join(home, '.crew/connections', id), 'connection', { id, root, dashboardUrl, organizationId: 'org', repositoryId: 'repo' });
  const execute = async (args: string[], kind = 'task') => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), kind, 'add', 'Fix one bug', '--verify', 'npm test', ...args], { cwd: join(root, 'nested'), env: { ...process.env, HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    return { code: await child.exited, output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() };
  };
  try {
    const refused = await execute([]);
    expect(refused.code).toBe(1);
    expect(refused.error).toContain('--yes');
    expect(submissions).toHaveLength(0);
    const approved = await execute(['--yes', '--max-cost', '1']);
    expect(approved.code).toBe(0);
    expect(approved.output).toContain('Lifecycle cap: $1.00');
    expect(submissions).toEqual([expect.objectContaining({ maxCostUsd: 1, body: 'Fix one bug\n\nVerification: npm test', repositoryId: 'repo' })]);
    expect((await execute(['--yes'], 'goal')).code).toBe(0);
    expect(submissions.at(-1)).toMatchObject({ kind: 'goal', maxCostUsd: 8, reviewMode: 'automatic' });
    const automatic = await execute(['--yes', '--auto-review'], 'goal');
    expect(automatic.code).toBe(0);
    expect(automatic.output).toContain('TypeSafe');
    expect(submissions.at(-1)).toMatchObject({ kind: 'goal', reviewMode: 'automatic' });
    expect((await execute(['--yes', '--manual-review'], 'goal')).code).toBe(0);
    expect(submissions.at(-1)).toMatchObject({ kind: 'goal', reviewMode: 'manual' });
    expect((await execute(['--yes', '--auto-review'])).code).toBe(1);
    const json = await execute(['--yes', '--json'], 'goal');
    expect(JSON.parse(json.output)).toMatchObject({ work: { id: 'work' } });
    for (const command of ['tasks', 'goals']) {
      const board = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), command, '--no-browser'], { cwd: join(root, 'nested'), env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe' });
      expect(await board.exited).toBe(0);
      const url = new URL((await new Response(board.stdout).text()).trim());
      expect(url.searchParams.get('repositoryId')).toBe('repo');
      expect(url.searchParams.get('kind')).toBe(command === 'goals' ? 'goal' : 'task');
      expect(url.href).not.toContain('test-session');
    }
  } finally { server.stop(true); await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
