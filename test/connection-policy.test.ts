import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from './helpers.js';

test('setup forwards policy; reconnect requires consent, preserves identity and retries failed service installation', async () => {
  const home = tempDir(), root = tempDir(), bin = join(home, 'bin');
  mkdirSync(bin);
  expect(Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd: root }).exitCode).toBe(0);
  const git = Bun.which('git')!;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const executable = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  executable('git', `case "$1" in\nls-remote) echo 'abc HEAD';;\nremote) echo 'https://github.com/test/repo.git';;\n*) exec ${quote(git)} "$@";;\nesac`);
  executable('gh', `if [ "$1" = repo ]; then echo '{"viewerPermission":"WRITE","defaultBranchRef":{"name":"main"}}'; fi`);
  for (const name of ['systemctl', 'launchctl']) executable(name, `echo "$*" >> "$HOME/service-calls"\nif [ "$FAIL_SERVICE" = yes ]; then exit 1; fi`);
  const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path.endsWith('/session')) return Response.json({ organizationId: 'org', organizationName: 'Test' });
    if (path.endsWith('/connect')) return Response.json({ organizationId: 'org', key: 'test-worker-key', repositoryId: 'repo', installId: 'install' });
    return Response.json({ work: [], schedules: [], repositories: [{ id: 'repo', online: true, enabled: true, lastSeenAt: new Date(Date.now() + 1000).toISOString() }] });
  } });
  const dashboardUrl = `http://127.0.0.1:${server.port}`;
  const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const directory = join(home, '.crew/client');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${Buffer.from('session').toString('base64url')}.json`), JSON.stringify({ result: { dashboardUrl, organizationId: 'org', token: 'test-session' } }));
  const savedPath = join(home, '.crew/connections', id, `${Buffer.from('connection').toString('base64url')}.json`);
  const saved = () => JSON.parse(readFileSync(savedPath, 'utf8')).result;
  const execute = async (args: string[], fail = false) => {
    const child = Bun.spawn([process.env.CREW_CLI_ENTRYPOINT ? 'node' : process.execPath, process.env.CREW_CLI_ENTRYPOINT ?? join(import.meta.dir, '../src/cli.ts'), ...args, '--json'], { cwd: root, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAIL_SERVICE: fail ? 'yes' : 'no' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const code = await child.exited;
    return { code, result: JSON.parse(await new Response(child.stdout).text()), error: await new Response(child.stderr).text() };
  };
  try {
    expect((await execute(['setup', '--yes', '--commands', 'git,npm,node,pnpm', '--timeout-seconds', '300', '--no-publish'])).code).toBe(0);
    const initial = saved();
    expect(initial).toMatchObject({ commands: 'git,npm,node,pnpm', timeoutSeconds: 300, allowPublish: false });
    const refused = await execute(['connect', '--timeout-seconds', '600']);
    expect(refused.code).toBe(1);
    expect(refused.error + refused.result.message).toContain('--yes');
    expect(saved()).toEqual(initial);
    for (const args of [['--commands', 'git,,npm'], ['--timeout-seconds', '3601'], ['--timeout-seconds', 'NaN']]) {
      expect((await execute(['connect', '--yes', ...args])).result.code).toBe('invalid_execution_policy');
      expect(saved()).toEqual(initial);
    }
    expect((await execute(['setup', '--yes', '--commands', 'git,npm,node', '--timeout-seconds', '600'])).code).toBe(0);
    expect(saved()).toEqual({ ...initial, commands: 'git,npm,node', timeoutSeconds: 600 });
    expect((await execute(['status'])).result.execution).toEqual({ commands: 'git,npm,node', timeoutSeconds: 600, allowPublish: false });
    expect((await execute(['connect'])).code).toBe(0);
    expect(saved()).toEqual({ ...initial, commands: 'git,npm,node', timeoutSeconds: 600 });
    expect((await execute(['connect'], true)).code).toBe(1);
    expect((await execute(['connect'])).code).toBe(0);
    expect(requests.filter(path => path.endsWith('/connect'))).toHaveLength(1);
    const serviceCalls = readFileSync(join(home, 'service-calls'), 'utf8');
    expect(serviceCalls).toContain(process.platform === 'linux' ? `restart crew-${id}.service` : 'bootstrap');
  } finally { server.stop(true); await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});
