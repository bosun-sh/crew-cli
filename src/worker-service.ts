import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectionDirectory, privateDirectory } from "./cli-state.js";

export function serviceDefinition(id: string, platform: string, executable: string, cliPath: string, logs: string): string {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid service id");
  const args = [executable, cliPath, "worker", "--connection", id];
  if (platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>sh.bosun.crew.${id}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(logs, "worker.log"))}</string><key>StandardErrorPath</key><string>${xml(join(logs, "worker.log"))}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string></dict></dict></plist>\n`;
  if (platform === "linux") return `[Unit]\nDescription=Crew repository worker ${id}\nAfter=network-online.target\n\n[Service]\nExecStart=${args.map(systemdQuote).join(" ")}\nRestart=on-failure\nRestartSec=5\nEnvironment=${systemdQuote(`PATH=${process.env.PATH ?? "/usr/bin:/bin"}`)}\n\n[Install]\nWantedBy=default.target\n`;
  throw new Error("Background installation supports macOS and Linux user services.");
}

export function installWorker(id: string): void {
  checkWorkerService();
  const logs = connectionDirectory(id);
  const path = servicePath(id);
  writeFileSync(path, serviceDefinition(id, process.platform, process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), logs), { mode: 0o600 });
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid!()}`;
    spawnSync("launchctl", ["bootout", `${domain}/sh.bosun.crew.${id}`]);
    command("launchctl", ["bootstrap", domain, path]);
  } else {
    command("systemctl", ["--user", "daemon-reload"]);
    command("systemctl", ["--user", "enable", "--now", `crew-${id}.service`]);
  }
}

export function checkWorkerService(): void {
  if (process.platform === "darwin") return;
  if (process.platform !== "linux") throw new Error("Background workers require macOS or Linux.");
  const result = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error('A systemd user session is required. On Debian/Ubuntu: sudo apt-get install dbus-user-session; sudo loginctl enable-linger "$USER"; then reconnect over SSH.');
}

export function stopWorker(id: string): void {
  const path = servicePath(id);
  if (!existsSync(path)) return;
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid!()}/sh.bosun.crew.${id}`;
    if (spawnSync("launchctl", ["print", domain]).status === 0) command("launchctl", ["bootout", domain]);
  } else command("systemctl", ["--user", "disable", "--now", `crew-${id}.service`]);
  unlinkSync(path);
}

function servicePath(id: string): string {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid service id");
  if (process.platform === "darwin") return join(privateDirectory(join(homedir(), "Library", "LaunchAgents")), `sh.bosun.crew.${id}.plist`);
  if (process.platform === "linux") return join(privateDirectory(join(homedir(), ".config", "systemd", "user")), `crew-${id}.service`);
  throw new Error("Background workers require macOS or Linux.");
}

function command(binary: string, args: string[]): void {
  const result = spawnSync(binary, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.error?.message ?? result.stderr?.trim() ?? "command unavailable"}`);
}

function xml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);
}

function systemdQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Service paths must not contain control characters.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$")}"`;
}
