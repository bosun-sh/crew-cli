import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJobResult, writeJobResult } from "./job-store.js";

export const clientDirectory = join(homedir(), ".crew", "client");
export const connectionsDirectory = join(homedir(), ".crew", "connections");
export type CliSession = { dashboardUrl: string; token: string; organizationId?: string };
export type Connection = { id: string; root: string; dashboardUrl: string; organizationId: string; key: string; repositoryId: string; installId: string; commands: string; timeoutSeconds: number; allowPublish: boolean };

export function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

export function loadSession(): CliSession | undefined {
  return readJobResult(privateDirectory(clientDirectory), "session")?.result as CliSession | undefined;
}

export function saveSession(session: CliSession): void {
  writeJobResult(privateDirectory(clientDirectory), "session", { result: session });
}

export function connectionId(root: string): string {
  return createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 24);
}

export function connectionDirectory(id: string): string {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid connection id");
  return privateDirectory(join(connectionsDirectory, id));
}

export function loadConnection(id: string): Connection | undefined {
  return readJobResult(connectionDirectory(id), "connection")?.result as Connection | undefined;
}

export function saveConnection(connection: Connection): void {
  writeJobResult(connectionDirectory(connection.id), "connection", { result: connection });
}

export function connections(): Connection[] {
  return readdirSync(privateDirectory(connectionsDirectory)).filter((name) => /^[a-f0-9]{24}$/.test(name)).flatMap((id) => { const connection = loadConnection(id); return connection ? [connection] : []; });
}

export function pendingConnections(): { id: string; connectionId: string; organizationId: string; dashboardUrl: string }[] {
  return readdirSync(privateDirectory(connectionsDirectory)).filter((id) => /^[a-f0-9]{24}$/.test(id)).flatMap((id) => {
    const saved = readJobResult(connectionDirectory(id), "connect-intent");
    if (saved?.error) throw new Error(`Connection intent ${id} is unreadable; restore local state before logout.`);
    const intent = saved?.result as { connectionId: string; organizationId: string; dashboardUrl: string } | undefined;
    return intent ? [{ ...intent, id }] : [];
  });
}

export async function cloudRequest(session: CliSession, path: string, body?: unknown): Promise<Response> {
  return fetch(`${session.dashboardUrl}${path}`, {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", ...(session.organizationId ? { "x-crew-organization": session.organizationId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function cloudJson(session: CliSession, path: string, body?: unknown): Promise<unknown> {
  const response = await cloudRequest(session, path, body);
  if (response.status === 401) throw new Error("Session expired or revoked. Run crew login again; persistent workers use their own credentials.");
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(`Crew request failed (${response.status}): ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}
