import { accessSync, constants } from "node:fs";
import { delimiter, sep } from "node:path";

export function which(command: string): string | null {
  if (command.includes(sep)) {
    return canExecute(command) ? command : null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const path = `${dir}${sep}${command}`;
    if (canExecute(path)) return path;
  }
  return null;
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function globMatches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char ?? "");
    }
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
