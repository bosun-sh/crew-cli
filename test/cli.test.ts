import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './helpers.js';

test('CLI requires paid-work approval and submits the displayed lifecycle cap', async () => {
  const home = tempDir();
  const root = tempDir();
  const submissions: Record<string, unknown>[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    expect(request.headers.get('x-crew-organization')).toBe('org');
    if (new URL(request.url).pathname.endsWith('/session')) return Response.json({ organizationId: 'org', organizationName: 'Test' });
    if (request.method === 'POST') { submissions.push(await request.json() as Record<string, unknown>); return Response.json({ work: { id: 'work' } }); }
    return Response.json({ budget: { taskUsd: 2 } });
  } });
  const dashboardUrl = `http://127.0.0.1:${server.port}`;
  const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const save = (directory: string, name: string, result: unknown) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${Buffer.from(name).toString('base64url')}.json`), JSON.stringify({ result }), { mode: 0o600 });
  };
  save(join(home, '.crew/client'), 'session', { dashboardUrl, organizationId: 'org', token: 'test-session' });
  save(join(home, '.crew/connections', id), 'connection', { id, root, dashboardUrl, organizationId: 'org', repositoryId: 'repo' });
  const execute = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'task', 'add', 'Fix one bug', '--verify', 'npm test', ...args], { cwd: root, env: { ...process.env, HOME: home }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
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
  } finally { server.stop(true); await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
