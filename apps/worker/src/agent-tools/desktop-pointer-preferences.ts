import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readSourceText } from "../import/read.ts";
import type { DesktopPointerStyle } from "./desktop-pointer-types.ts";

const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const travel = z.number().int().min(30).max(700);

const style = z
  .object({
    accent: color,
    fill: color,
    rim: color,
    size: z.number().min(0.5).max(4),
    travelMinMs: travel,
    travelMaxMs: travel,
    ripple: z.boolean(),
  })
  .refine((value) => value.travelMinMs <= value.travelMaxMs);

const preference = z.object({ session: z.string(), style });

function fileName(session: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(session)) throw new Error("Invalid desktop pointer session");

  // Preserve distinct session keys on case-insensitive volumes, including Windows reserved names.
  return `${createHash("sha256").update(session).digest("hex")}.json`;
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A preference exists only while the user has opted in. Separate files keep concurrent thread updates independent. */
export class DesktopPointerPreferences {
  constructor(private readonly dataDir: string) {}

  get(session: string): DesktopPointerStyle | undefined {
    try {
      const name = fileName(session);
      const root = realpathSync(this.dataDir);
      const json = readSourceText({ root, path: join(root, "desktop-pointers", name) }, 1024);

      if (!json) return undefined;
      const saved = preference.parse(JSON.parse(json));

      return saved.session === session ? saved.style : undefined;
    } catch {
      return undefined;
    }
  }

  set(session: string, value: DesktopPointerStyle | undefined): void {
    const name = fileName(session);
    const setting = value === undefined ? undefined : style.parse(value);
    const directory = join(this.dataDir, "desktop-pointers");

    if (setting) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory, { throwIfNoEntry: false });

    if (!stat) return;

    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid desktop pointer preference directory");
    const path = join(directory, name);

    if (setting === undefined) {
      if (!lstatSync(path, { throwIfNoEntry: false })) return;
      rmSync(path, { force: true });
    } else {
      const temporary = join(directory, `.${crypto.randomUUID()}.tmp`);
      const fd = openSync(temporary, "wx", 0o600);

      try {
        try {
          writeFileSync(fd, JSON.stringify({ session, style: setting }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }

        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    }

    syncDirectory(directory);
  }
}
