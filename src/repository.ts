import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJobResult, writeJobResult } from './job-store.js';
import { GIT_HARDENING_ARGS } from './git-policy.js';

export function repositoryRoot(path = '.'): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: resolve(path), encoding: 'utf8' });
  if (result.status !== 0) throw Object.assign(new Error('Run crew setup inside a Git repository.'), { code: 'not_a_repository' });
  return realpathSync(result.stdout.trim());
}

export function projectCommands(root: string): string {
  const commands = ['git', 'npm', 'node', 'sed', 'cat', 'ls', 'find', 'patch'];
  for (const [file, command] of [['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['pyproject.toml', 'python3'], ['uv.lock', 'uv'], ['go.mod', 'go'], ['Cargo.toml', 'cargo']]) {
    if (existsSync(join(root, file!))) commands.push(command!);
  }
  if (existsSync(join(root, 'package.json'))) {
    const path = join(root, 'package.json');
    if (!realpathSync(path).startsWith(root + '/') || !statSync(path).isFile() || statSync(path).size > 1_000_000) throw Object.assign(new Error('Package metadata must be a bounded file inside this repository.'), { code: 'invalid_project_metadata' });
    let manifest: { packageManager?: unknown };
    try { manifest = JSON.parse(readFileSync(path, 'utf8')) as { packageManager?: unknown }; } catch { throw Object.assign(new Error('Fix invalid package.json before automatic command detection.'), { code: 'invalid_project_metadata' }); }
    if (typeof manifest.packageManager === 'string') {
      const manager = manifest.packageManager.split('@')[0]!;
      if (['npm', 'pnpm', 'yarn', 'bun'].includes(manager)) commands.push(manager);
    }
  }
  return [...new Set(commands)].join(',');
}

/** Explicit setup authorization only; never stages or publishes developer files. */
export function initializeEmptyRepository(root: string, stateDir: string): string {
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'USER', 'TMPDIR'].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  const git = (...args: string[]) => spawnSync('git', [...GIT_HARDENING_ARGS, '-c', 'commit.gpgsign=false', ...args], { cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, input: '', encoding: 'utf8', timeout: 30_000 });
  const checked = (...args: string[]) => { const result = git(...args); if (result.status !== 0) throw Object.assign(new Error(`Empty-repository initialization stopped at git ${args[0]}. Rerun the same command to recover.`), { code: 'initialization_incomplete' }); return result.stdout.trim(); };
  const saved = readJobResult(stateDir, 'empty-base');
  if (saved?.error) throw Object.assign(new Error('Initialization state is unreadable; restore it before retrying.'), { code: 'initialization_incomplete' });
  let intent = saved?.result as { branch: string; sha: string } | undefined;
  if (!intent) {
    if (git('rev-parse', '--verify', 'HEAD').status === 0 || checked('status', '--porcelain', '--untracked-files=all') || checked('ls-remote', '--heads', 'origin')) throw Object.assign(new Error('--initialize-empty requires an unborn checkout with no staged/untracked files and an empty remote.'), { code: 'repository_not_empty' });
    const branch = checked('symbolic-ref', '--short', 'HEAD');
    checked('check-ref-format', '--branch', branch);
    const tree = checked('hash-object', '-t', 'tree', '-w', '--stdin');
    const sha = checked('-c', 'user.name=Crew', '-c', 'user.email=crew@users.noreply.github.com', 'commit-tree', tree, '-m', 'Initialize empty repository for Crew');
    intent = { branch, sha };
    writeJobResult(stateDir, 'empty-base', { result: intent });
  }
  if (typeof intent.branch !== 'string' || !/^[a-f0-9]{40,64}$/.test(intent.sha)) throw Object.assign(new Error('Invalid initialization intent.'), { code: 'initialization_conflict' });
  checked('check-ref-format', '--branch', intent.branch);
  if (checked('ls-tree', '-r', intent.sha) || checked('rev-list', '--parents', '-n', '1', intent.sha) !== intent.sha) throw Object.assign(new Error('Initialization must reference an empty root commit.'), { code: 'initialization_conflict' });
  const ref = `refs/heads/${intent.branch}`;
  const remote = checked('ls-remote', 'origin', ref).split(/\s/)[0];
  if (remote && remote !== intent.sha) throw Object.assign(new Error('Remote changed during initialization; inspect it before continuing.'), { code: 'initialization_conflict' });
  if (!remote) checked('push', `--force-with-lease=${ref}:`, 'origin', `${intent.sha}:${ref}`);
  const local = git('rev-parse', '--verify', ref);
  if (local.status === 0 && local.stdout.trim() !== intent.sha) throw Object.assign(new Error('Local branch changed during initialization.'), { code: 'initialization_conflict' });
  if (local.status !== 0) checked('update-ref', ref, intent.sha, '0'.repeat(intent.sha.length));
  return intent.branch;
}
