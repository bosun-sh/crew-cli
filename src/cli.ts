#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, secureUrl } from "./config.js";
import { startControlPlane } from "./control-plane.js";
import { clientDirectory, cloudJson, cloudRequest, connectionDirectory, connectionId, connections, pendingConnections, loadConnection, loadSession, saveConnection, saveSession, type CliSession, type Connection } from "./cli-state.js";
import { checkWorkerService, installWorker, stopWorker } from "./worker-service.js";
import { readJobResult, removeJobResult, writeJobResult } from "./job-store.js";
import { repositoryRoot, projectCommands, initializeEmptyRepository } from './repository.js';
import { showDestination, type BrowserOptions } from './browser.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    verify: { type: "string" }, dashboard: { type: "string" }, connection: { type: "string" }, repo: { type: "string" },
    weekly: { type: "string" }, daily: { type: "boolean" }, time: { type: "string" }, timezone: { type: "string" },
    at: { type: "string" }, "max-cost": { type: "string" }, "monthly-cap": { type: "string" },
    commands: { type: "string" }, "timeout-seconds": { type: "string" }, "no-publish": { type: "boolean" },
    help: { type: "boolean", short: "h" },
    yes: { type: "boolean", short: "y" },
    "auto-review": { type: "boolean" }, 'manual-review': { type: 'boolean' },
    json: { type: 'boolean' }, 'initialize-empty': { type: 'boolean' },
    browser: { type: 'boolean' }, 'no-browser': { type: 'boolean' }, list: { type: 'boolean' },
    version: { type: "boolean", short: "v" },
  } });
  const command = positionals[0];
  if (values.browser && values['no-browser']) throw new Error('Choose --browser or --no-browser, not both.');
  if (values.version) { console.log((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version); return; }
  if (values.help || !command) {
    console.log('crew goal add "Desired outcome" --verify "Acceptance checks" [--max-cost USD] [--manual-review] [--yes]');
    console.log('crew setup [.] [--dashboard URL] [--commands git,npm,node] [--timeout-seconds 30] [--yes]\ncrew doctor [.]\ncrew login [--dashboard URL]\ncrew connect [.] [--commands git,npm,node] [--timeout-seconds 30]\ncrew task add "Description" [--verify "npm test"] [--max-cost USD] [--yes] [--at ISO_TIME | --weekly mon,wed --time 09:00 --timezone IANA --monthly-cap USD]\ncrew tasks [--list | --json | --no-browser | --browser]\ncrew goals [--list | --json | --no-browser | --browser]\ncrew status\ncrew logout');
    return;
  }
  if (command === "setup") {
    const root = repositoryRoot(positionals[1]);
    await main(["doctor", root, ...(values['initialize-empty'] ? ['--initialize-empty'] : [])]);
    if (!loadSession() || (values.dashboard && values.dashboard !== loadSession()?.dashboardUrl)) await main(["login", ...(values.dashboard ? ["--dashboard", values.dashboard] : []), ...(values.browser ? ['--browser'] : []), ...(values['no-browser'] ? ['--no-browser'] : [])]);
    await main(["connect", root, ...(values.yes ? ["--yes"] : []), ...(values.json ? ['--json'] : []), ...(values['initialize-empty'] ? ['--initialize-empty'] : []), ...(values.commands !== undefined ? ['--commands', values.commands] : []), ...(values['timeout-seconds'] !== undefined ? ['--timeout-seconds', values['timeout-seconds']] : []), ...(values['no-publish'] ? ['--no-publish'] : [])]);
    return;
  }
  if (command === "doctor") {
    const root = repositoryRoot(positionals[1]);
    checkWorkerService();
    run("git", ["rev-parse", "--show-toplevel"], root);
    run("gh", ["auth", "status", "--hostname", "github.com"], root);
    run("git", ['ls-remote', ...(values['initialize-empty'] ? [] : ['--exit-code']), "origin", "HEAD"], root);
    if (values.json) { process.stdout.write(JSON.stringify({ ok: true, repository: root, commands: projectCommands(root) }) + '\n'); return; }
    console.log("Ready: Git repository, persistent GitHub authentication, and user services. No credits spent.");
    return;
  }
  if (command === "worker") {
    const connection = values.connection ? loadConnection(values.connection) : undefined;
    if (!connection) throw new Error("Worker connection is missing.");
    const directory = connectionDirectory(connection.id);
    const config = loadConfig({ ...process.env, CREW_NODE_API_KEY: connection.key, CREW_WORKSPACE_ROOT: connection.root, CREW_STATE_DIR: join(directory, "state"), CREW_AUDIT_DIR: join(directory, "audit"), CREW_ALLOWED_COMMANDS: connection.commands, CREW_COMMAND_TIMEOUT_SECONDS: String(connection.timeoutSeconds), CREW_ALLOW_PUBLISH: String(connection.allowPublish) });
    const worker = startControlPlane(config, { onError: (message) => console.error(message) });
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void worker.stop());
    return;
  }
  if (command === "login") {
    let dashboardUrl = values.dashboard ?? process.env.CREW_DASHBOARD_URL ?? loadSession()?.dashboardUrl ?? 'https://crew.bosun.sh';
    if (!dashboardUrl) {
      if (!process.stdin.isTTY) throw new Error("Set CREW_DASHBOARD_URL or pass --dashboard URL.");
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { dashboardUrl = await prompt.question("Crew Cloud URL: "); } finally { prompt.close(); }
    }
    await login(secureUrl(dashboardUrl), values);
    return;
  }
  if (command === "logout") {
    const connected = connections();
    const failures: string[] = [];
    const stopped = new Set<string>();
    for (const connection of connected) {
      try { stopWorker(connection.id); stopped.add(connection.id); }
      catch { failures.push(`Could not stop worker ${connection.id}.`); }
    }
    for (const connection of connected) {
      try {
        const response = await cloudRequest({ dashboardUrl: connection.dashboardUrl, token: connection.key }, "/api/node/revoke", {});
        if (!response.ok && response.status !== 401) throw new Error('revocation failed');
        if (stopped.has(connection.id)) removeJobResult(connectionDirectory(connection.id), "connection");
      } catch { failures.push(`Cloud revocation is pending for ${connection.id}.`); }
    }
    const session = loadSession();
    for (const intent of pendingConnections()) {
      try {
        if (!session || session.dashboardUrl !== intent.dashboardUrl) throw new Error('Log in to the connection Cloud first.');
        await cloudJson({ ...session, organizationId: intent.organizationId }, '/api/cli/connect/revoke', { connectionId: intent.connectionId });
        removeJobResult(connectionDirectory(intent.id), 'connect-intent');
      } catch { failures.push(`Unfinished connection ${intent.id} needs revocation; log in to its organization and retry.`); }
    }
    if (failures.length) throw new Error(`${failures.join(' ')} Run crew logout again to retry.`);
    if (session) await cloudRequest(session, "/api/auth/sign-out", {}).catch(() => undefined);
    removeJobResult(clientDirectory, "session");
    console.log("Local workers stopped and revoked; logged out.");
    return;
  }
  const session = loadSession();
  if (!session) throw new Error("Run crew login first.");
  const identity = await cloudJson(session, "/api/cli/session") as { organizationId: string; organizationName: string };
  session.organizationId = identity.organizationId;
  saveSession(session);
  if (command === "connect") {
    const root = repositoryRoot(positionals[1]);
    const id = connectionId(root);
    const existing = loadConnection(id);
    if (existing && (existing.dashboardUrl !== session.dashboardUrl || existing.organizationId !== session.organizationId)) throw new Error("This repository is connected to another or an unidentified organization. Run crew logout before reconnecting.");
    checkWorkerService();
    run("gh", ["auth", "status", "--hostname", "github.com"], root);
    const metadata = JSON.parse(run("gh", ["repo", "view", "--json", "viewerPermission,defaultBranchRef"], root)) as { viewerPermission: string; defaultBranchRef: { name: string } | null };
    if (!["ADMIN", "MAINTAIN", "WRITE"].includes(metadata.viewerPermission)) throw new Error("GitHub repository write access is required.");
    if (!values['initialize-empty']) run("git", ["ls-remote", "--exit-code", "origin", "HEAD"], root);
    const timeoutSeconds = Number(values["timeout-seconds"] ?? existing?.timeoutSeconds ?? 30);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw Object.assign(new Error("Timeout must be 1–3600 seconds."), { code: 'invalid_execution_policy' });
    const commands = values.commands ?? existing?.commands ?? projectCommands(root);
    if (commands.split(",").some((name) => !/^[A-Za-z0-9._+-]+$/.test(name))) throw Object.assign(new Error("Commands must be comma-separated binary names."), { code: 'invalid_execution_policy' });
    const allowPublish = values['no-publish'] ? false : existing?.allowPublish ?? true;
    const changed = existing && (commands !== existing.commands || timeoutSeconds !== existing.timeoutSeconds || allowPublish !== existing.allowPublish);
    if (existing && !changed) { installWorker(id); await waitForWorker(session, existing); if (values.json) process.stdout.write(JSON.stringify({ ok: true, repository: root, repositoryId: existing.repositoryId, organizationId: existing.organizationId, worker: 'online' }) + '\n'); return; }
    console.log(`Crew will run commands as your OS user in isolated worktrees for ${root}. Worktrees are not a security sandbox. Requested source context goes to Crew Cloud and its model provider; GitHub credentials stay on this machine.`);
    console.log(`Execution policy: commands=${commands}; timeout=${timeoutSeconds}s; publication=${allowPublish ? 'allowed' : 'disabled'}.`);
    if (changed) console.log('This restarts the worker. Finish or cancel active work before changing execution policy; interrupted operations may need recovery.');
    if (!values.yes) {
      if (!process.stdin.isTTY) throw new Error("Review the execution access above and pass --yes to enable this repository.");
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { if ((await prompt.question("Enable repository execution? [y/N] ")).trim().toLowerCase() !== "y") return; }
      finally { prompt.close(); }
    }
    if (existing) {
      const updated = { ...existing, commands, timeoutSeconds, allowPublish };
      stopWorker(id);
      saveConnection(updated);
      installWorker(id);
      await waitForWorker(session, updated);
      if (values.json) process.stdout.write(JSON.stringify({ ok: true, repository: root, repositoryId: updated.repositoryId, organizationId: updated.organizationId, worker: 'online', commands, timeoutSeconds, allowPublish }) + '\n');
      return;
    }
    const remote = run("git", ["remote", "get-url", "origin"], root).trim();
    if (!/^(https:\/\/github\.com\/|git@github\.com:)/.test(remote)) throw new Error("Connect requires a github.com origin without embedded credentials.");
    const directory = connectionDirectory(id);
    const defaultBranch = values['initialize-empty'] ? initializeEmptyRepository(root, directory) : metadata.defaultBranchRef?.name;
    if (!defaultBranch) throw Object.assign(new Error('Empty remote: rerun setup with --initialize-empty to authorize an empty base commit.'), { code: 'initialization_required' });
    const saved = readJobResult(directory, "connect-intent");
    if (saved?.error) throw new Error("Connection intent is unreadable; restore local state before reconnecting.");
    const intent = saved?.result as { connectionId: string; organizationId: string; dashboardUrl: string } | undefined;
    if (intent && (intent.organizationId !== session.organizationId || intent.dashboardUrl !== session.dashboardUrl)) throw new Error("An unfinished connection belongs to another organization. Log in to that organization to finish it.");
    const provisioningId = intent?.connectionId ?? randomUUID();
    writeJobResult(directory, "connect-intent", { result: { connectionId: provisioningId, organizationId: session.organizationId, dashboardUrl: session.dashboardUrl } });
    const result = await cloudJson(session, "/api/cli/connect", { connectionId: provisioningId, name: basename(root), gitRemote: remote, defaultBranch }) as { organizationId: string; key: string; repositoryId: string; installId: string; budget: unknown };
    if (result.organizationId !== session.organizationId) throw new Error("Cloud returned a connection for the wrong organization.");
    saveConnection({ id, root, dashboardUrl: session.dashboardUrl, organizationId: result.organizationId, key: result.key, repositoryId: result.repositoryId, installId: result.installId, commands, timeoutSeconds, allowPublish });
    removeJobResult(directory, "connect-intent");
    installWorker(id);
    await waitForWorker(session, loadConnection(id)!);
    if (values.json) process.stdout.write(JSON.stringify({ ok: true, repository: root, repositoryId: result.repositoryId, organizationId: result.organizationId, worker: 'online', commands }) + '\n');
    if (process.platform === "linux") console.log('For operation after SSH disconnect and reboot: sudo loginctl enable-linger "$USER". Logs: journalctl --user -u crew-' + id + '.service -f');
    return;
  }
  if (command === "tasks" || command === 'goals' || command === "status") {
    const connection = findConnection(values.repo);
    if (connection.organizationId !== identity.organizationId || connection.dashboardUrl !== session.dashboardUrl) throw Object.assign(new Error('Log in to this repository’s connected organization.'), { code: 'organization_mismatch' });
    if (command !== 'status' && !values.list && !values.json) {
      const url = new URL('/work', session.dashboardUrl); url.searchParams.set('kind', command === 'goals' ? 'goal' : 'task'); url.searchParams.set('repositoryId', connection.repositoryId);
      await showDestination(url.href, values); return;
    }
    const data = await cloudJson(session, "/api/work") as { work: { id: string; kind: string; repositoryId: string; title: string; status: string; mergedAt: string | null; closedAt: string | null; verifiedNoChange: boolean; maxCostUsd: number | null; costUsd: number | null; prUrl: string | null; scheduledAt: string | null; blockedReason: string | null }[]; schedules: { id: string; repositoryId: string; title: string; nextAt: string; paused: boolean; blockedReason: string | null }[]; repositories: { id: string; name: string; nodeName: string; online: boolean; enabled: boolean }[] };
    data.work = data.work.filter(work => work.repositoryId === connection.repositoryId && (command === 'status' || work.kind === (command === 'goals' ? 'goal' : 'task')));
    data.schedules = data.schedules.filter(schedule => schedule.repositoryId === connection.repositoryId);
    data.repositories = data.repositories.filter(repository => repository.id === connection.repositoryId);
    if (values.json) { process.stdout.write(JSON.stringify({ ok: true, repository: connection.root, repositoryId: connection.repositoryId, organization: identity, execution: { commands: connection.commands, timeoutSeconds: connection.timeoutSeconds, allowPublish: connection.allowPublish }, ...data }) + '\n'); return; }
    console.log(`Repository: ${connection.root}\nOrganization: ${identity.organizationName} (${identity.organizationId})`);
    if (command === "status") console.log(`Execution: ${connection.commands}; timeout=${connection.timeoutSeconds}s; publication=${connection.allowPublish ? 'allowed' : 'disabled'}`);
    console.table(command === "status" ? data.repositories.map((repo) => ({ repository: repo.name, worker: repo.nodeName, availability: repo.online ? 'online' : 'offline; queued work waits', enabled: repo.enabled })) : data.work.map((work) => ({ title: work.title, status: work.mergedAt ? "Done (merged)" : work.closedAt ? "Closed without merge" : work.verifiedNoChange ? "Verified no-change" : work.status, spendUsd: work.costUsd ?? 0, capUsd: work.maxCostUsd ?? 0, starts: work.scheduledAt ?? 'immediate', task: `${session.dashboardUrl}/work/${work.id}`, pr: work.prUrl ?? '', blocker: work.blockedReason ?? '' })));
    if (data.schedules.length) console.table(data.schedules.map((schedule) => ({ title: schedule.title, next: schedule.nextAt, paused: schedule.paused, blocker: schedule.blockedReason ?? '' })));
    return;
  }
  if ((command === "task" || command === "goal") && positionals[1] === "add") {
    const kind = command;
    if (kind !== 'goal' && (values['auto-review'] || values['manual-review'])) throw new Error('Review options require crew goal add.');
    if (values['auto-review'] && values['manual-review']) throw new Error('Choose automatic or manual internal review.');
    let body = positionals.slice(2).join(" ").trim();
    if (!body) throw new Error("Task description is required.");
    const connection = findConnection(values.repo);
    if (connection.dashboardUrl !== session.dashboardUrl || connection.organizationId !== session.organizationId) throw new Error("Log in to the connected worker's Dashboard and organization first.");
    const repeated = values.daily || values.weekly;
    if (kind === "goal" && repeated) throw new Error("Recurring work currently supports tasks only.");
    if (repeated && values.at) throw new Error("Use either --at or recurrence.");
    const weekdays = values.daily ? [0, 1, 2, 3, 4, 5, 6] : (values.weekly ?? "").split(",").map((day) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(day.toLowerCase()));
    if (repeated && (!values.time || !values.timezone || !values["monthly-cap"] || weekdays.includes(-1))) throw new Error("Recurrence requires valid weekdays, --time, --timezone and --monthly-cap USD.");
    let verification = values.verify?.trim();
    if (!verification) {
      if (!process.stdin.isTTY) throw new Error('Pass --verify with an existing test command or concrete acceptance check.');
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { verification = (await prompt.question("Verification command or acceptance check: ")).trim(); }
      finally { prompt.close(); }
      if (!verification) throw new Error("A verification plan is required.");
    }
    const settings = await cloudJson(session, "/api/work") as { budget: { taskUsd: number; goalUsd: number } };
    const cap = values["max-cost"] ? positive(values["max-cost"]) : kind === "goal" ? settings.budget.goalUsd : settings.budget.taskUsd;
    body += `\n\nVerification: ${verification}`;
    console.log(`Scope: ${body}\nLifecycle cap: $${cap.toFixed(2)} (${cap * 100} credits). Failed attempts and revisions consume credits. A cap is not a guarantee of a fix.`);
    if (kind === 'goal') console.log(`Confirm understanding once in the Cloud board. Internal review: ${values['manual-review'] ? 'manual checkpoints' : 'automatic; independent reviewer with Jev when qualified'}. Review uses credits and automatic review may send repository evidence to TypeSafe. You retain merge and persistent-rule approval.`);
    if (!values.yes) {
      if (!process.stdin.isTTY) throw new Error("Review the scope and cap, then pass --yes to submit.");
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { if ((await prompt.question("Submit paid work? [y/N] ")).trim().toLowerCase() !== "y") return; }
      finally { prompt.close(); }
    }
    const result = await cloudJson(session, "/api/work", { body, kind, ...(kind === 'goal' ? { reviewMode: values['manual-review'] ? 'manual' : 'automatic' } : {}), repositoryId: connection.repositoryId, maxCostUsd: cap,
      ...(values.at ? { scheduledAt: new Date(values.at).toISOString() } : {}),
      ...(repeated ? { recurrence: { weekdays, time: values.time, timezone: values.timezone, monthlyCapUsd: positive(values["monthly-cap"]!) } } : {}),
    });
    process.stdout.write(JSON.stringify(result, null, values.json ? undefined : 2) + '\n');
    return;
  }
  throw new Error("Unknown command. Run crew --help.");
}

async function waitForWorker(session: CliSession, connection: Connection): Promise<void> {
  const startedAt = Date.now();
  console.log("Waiting for the worker to report this repository…");
  for (let attempt = 0; attempt < 30; attempt++) {
    const data = await cloudJson(session, "/api/work") as { repositories: { id: string; online: boolean; enabled: boolean; lastSeenAt: string }[] };
    if (data.repositories.some((repo) => repo.id === connection.repositoryId && repo.online && repo.enabled && Date.parse(repo.lastSeenAt) >= startedAt)) {
      console.log(`Connected ${connection.root}. Worker online.
Next: ${session.dashboardUrl}/work
Setup costs nothing. Tasks use prepaid credits; failed attempts and revisions also consume credits. Keep this machine awake and connected for scheduled work.`);
      return;
    }
    await delay(2000);
  }
  throw new Error(`Worker has not reported online. Connection was saved; rerun crew setup. Logs: ${process.platform === "linux" ? `journalctl --user -u crew-${connection.id}.service` : join(connectionDirectory(connection.id), "worker.log")}. Sleeping or disconnected machines cannot run tasks.`);
}

async function login(dashboardUrl: string, options: BrowserOptions = {}): Promise<void> {
  const client: CliSession = { dashboardUrl, token: "" };
  const code = await cloudJson(client, "/api/auth/device/code", { client_id: "crew-cli" }) as { device_code: string; user_code: string; verification_uri_complete: string; expires_in: number; interval: number };
  if (new URL(code.verification_uri_complete).origin !== new URL(dashboardUrl).origin) throw new Error('Authorization URL does not belong to Crew Cloud.');
  console.log(`Confirm code: ${code.user_code}`);
  await showDestination(code.verification_uri_complete, options);
  let interval = Math.max(5, code.interval);
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await delay(interval * 1000);
    const response = await cloudRequest(client, "/api/auth/device/token", { client_id: "crew-cli", device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    const result = await response.json() as { access_token?: string; error?: string };
    if (response.ok && result.access_token) { saveSession({ dashboardUrl, token: result.access_token }); console.log("Logged in. Run crew connect . in your repository."); return; }
    if (result.error === "slow_down") interval += 5;
    else if (result.error !== "authorization_pending") throw new Error(`Login failed: ${result.error ?? response.status}`);
  }
  throw new Error("Login expired. Run crew login again.");
}

function findConnection(repo?: string): Connection {
  const connection = loadConnection(connectionId(repositoryRoot(repo)));
  if (!connection) throw Object.assign(new Error("Run crew setup in this repository first."), { code: 'not_connected' });
  return connection;
}

function positive(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error("Budget must be a positive USD amount.");
  return result;
}

function run(binary: string, args: string[], root: string): string {
  // Match the login-independent user service, without temporary tokens or SSH agents.
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'USER', 'TMPDIR'].flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
  const result = spawnSync(binary, args, { cwd: root, env: { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' }, encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error(`${binary} is missing. macOS: brew install git gh. Debian/Ubuntu: sudo apt-get install git gh. Then rerun crew setup.`), { code: 'prerequisite_missing' });
  if (result.status !== 0 && binary === "git" && args[0] === "rev-parse") throw new Error("Choose an existing Git checkout: cd /path/to/repository; then crew setup .");
  if (result.status !== 0) throw new Error(`${binary} persistent access check failed. Run: env -u GH_TOKEN -u GITHUB_TOKEN gh auth login --hostname github.com --git-protocol https; then gh auth setup-git. Use a token scoped to this repository. Session-only tokens and SSH agents cannot survive reboot.`);
  return result.stdout;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes('--json');
  if (json) console.log = (...values: unknown[]) => console.error(...values);
  main().catch((error: unknown) => { const message = error instanceof Error ? error.message : 'Crew command failed'; const code = (error as { code?: unknown })?.code; if (json) process.stdout.write(JSON.stringify({ ok: false, code: typeof code === 'string' ? code : 'command_failed', message }) + '\n'); else console.error(message); process.exitCode = 1; });
}
