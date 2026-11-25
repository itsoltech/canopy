import { closeSync, fstatSync, lstatSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { openSource } from "../import/read.ts";
import type { ToolEnv } from "./paths.ts";

function envValue(env: ToolEnv, name: string) {
  if (process.platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);

  return key === undefined ? undefined : env[key];
}

/** Agent Desktop 1.3.1 uses AGENT_DESKTOP_HOME or the subprocess's HOME/USERPROFILE + .agent-desktop. */
function stateRoot(env: ToolEnv): string | undefined {
  const configured = envValue(env, "AGENT_DESKTOP_HOME");
  const base = configured ?? envValue(env, "HOME") ?? envValue(env, "USERPROFILE");

  if (
    !base ||
    !isAbsolute(base) ||
    base.includes("\0") ||
    base.split(process.platform === "win32" ? /[\\/]/ : "/").includes("..")
  )
    return;

  if (process.platform === "win32") {
    const drivePath = base.replace(/^\\\\\?\\(?=[a-z]:[\\/])/i, "");

    if (!/^[a-z]:[\\/]/i.test(drivePath) || drivePath.slice(2).includes(":")) return;
  }

  const basePath = resolve(base);
  const root = configured === undefined ? join(basePath, ".agent-desktop") : basePath;
  const volume = parse(root).root;
  let current = volume;

  for (const part of relative(volume, root).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);

    // Upstream permits system-owned directory aliases above its home (e.g. /var on macOS).
    if (
      stat.isSymbolicLink() &&
      process.platform !== "win32" &&
      stat.uid === 0 &&
      current !== basePath &&
      current !== root
    )
      continue;

    if (!stat.isDirectory() || stat.isSymbolicLink()) return;

    if (current === basePath && process.platform !== "win32" && stat.uid !== process.getuid?.()) return;
  }

  return realpathSync(root);
}

function nativeFile(session: string, env: ToolEnv, parts: string[], limit: number): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(session)) return;

  try {
    const root = stateRoot(env);

    if (!root) return;
    const fd = openSource({ root, path: join(root, "sessions", session, ...parts) });

    try {
      const stat = fstatSync(fd);

      if (stat.nlink !== 1 || !stat.size || stat.size > limit) return;

      if (process.platform !== "win32" && (stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0)) return;
      const data = Buffer.alloc(stat.size);

      for (let offset = 0; offset < data.length;) {
        const count = readSync(fd, data, offset, data.length - offset, offset);

        if (!count) return;
        offset += count;
      }

      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const manifest = z.object({
  id: z.string(),
  created_at: z.number().int().nonnegative(),
  ended_at: z.number().int().nonnegative().nullish(),
  cursor_overlay: z
    .object({
      enabled: z.boolean().optional(),
      style: z.object({ ripple: z.boolean().optional() }).optional(),
    })
    .optional(),
});

/** Detect a previous native overlay so the authorized caller can retire it. Always read-only. */
export function readDesktopOverlay(session: string, env: ToolEnv): { ripple: boolean } | undefined {
  const bytes = nativeFile(session, env, ["session.json"], 64 * 1024);

  if (!bytes) return;

  try {
    const data = manifest.parse(JSON.parse(bytes));

    // The native setter uses the embedded ID to choose the manifest to update.
    return data.id === session && data.ended_at == null && data.cursor_overlay?.enabled
      ? { ripple: data.cursor_overlay.style?.ripple ?? true }
      : undefined;
  } catch {
    return undefined;
  }
}

/** A qualified ref's native snapshot, capped at Agent Desktop's own refmap limit. */
export function readDesktopRefMap(session: string, env: ToolEnv, snapshotId: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(snapshotId)) return;

  return nativeFile(session, env, ["snapshots", snapshotId, "refmap.json"], 1024 * 1024);
}
