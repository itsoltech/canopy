import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopPointerPreferences } from "./desktop-pointer-preferences.ts";
import type { DesktopPointerStyle } from "./desktop-pointer-types.ts";

const scratch: string[] = [];

const style: DesktopPointerStyle = {
  accent: "#4299FF",
  fill: "#123456",
  rim: "#111318",
  size: 1.25,
  travelMinMs: 90,
  travelMaxMs: 320,
  ripple: true,
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "canopy-desktop-pointers-"));
  scratch.push(dir);

  return { dir, root: join(dir, "desktop-pointers"), store: new DesktopPointerPreferences(dir) };
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("pointer preferences persist only opted-in sessions, including case-distinct and Windows-reserved IDs", () => {
  const f = fixture();
  expect(f.store.get("CON")).toBeUndefined();
  f.store.set("CON", undefined);
  expect(readdirSync(f.dir)).toEqual([]);
  const second = { ...style, ripple: false };
  f.store.set("CON", style);
  f.store.set("con", second);
  const restored = new DesktopPointerPreferences(f.dir);
  expect(restored.get("CON")).toEqual(style);
  expect(restored.get("con")).toEqual(second);
  expect(readdirSync(f.root)).toHaveLength(2);
  f.store.set("CON", undefined);
  expect(restored.get("CON")).toBeUndefined();
  expect(restored.get("con")).toEqual(second);
  const remaining = readdirSync(f.root);
  expect(remaining).toHaveLength(1);

  if (process.platform !== "win32") expect(statSync(join(f.root, remaining[0]!)).mode & 0o777).toBe(0o600);
});

test("refuses unsafe keys, oversized or invalid stored styles and redirected preference directories", () => {
  const f = fixture();
  expect(() => f.store.set("../escape", style)).toThrow();
  f.store.set("one", style);
  expect(() => f.store.set("one", { ...style, accent: "url(private)" })).toThrow();
  expect(f.store.get("one")).toEqual(style);
  const file = join(f.root, readdirSync(f.root)[0]!);
  writeFileSync(file, "{");
  expect(f.store.get("one")).toBeUndefined();
  writeFileSync(file, JSON.stringify({ session: "other", style }));
  expect(f.store.get("one")).toBeUndefined();
  writeFileSync(file, JSON.stringify({ session: "one", style, ignored: "x".repeat(1024) }));
  expect(f.store.get("one")).toBeUndefined();
  rmSync(f.root, { recursive: true });
  const other = fixture();
  other.store.set("one", { ...style, size: 4 });
  symlinkSync(other.root, f.root, "junction");
  expect(f.store.get("one")).toBeUndefined();
  expect(() => f.store.set("one", style)).toThrow();
  expect(() => f.store.set("one", undefined)).toThrow();
  expect(other.store.get("one")?.size).toBe(4);
});

test("separate workers committing concurrent opt-ins retain each session's complete style", async () => {
  const f = fixture();

  const source = `
    import { DesktopPointerPreferences } from ${JSON.stringify(import.meta.resolve("./desktop-pointer-preferences.ts"))};
    const [dir, session, size] = process.argv.slice(1);
    const preferences = new DesktopPointerPreferences(dir);
    process.stdout.write("ready");
    await Bun.stdin.text();
    preferences.set(session, { ...${JSON.stringify(style)}, size: Number(size) });
  `;

  const sessions = ["worker-one", "worker-two"];

  const children = sessions.map((session, i) =>
    Bun.spawn([process.execPath, "-e", source, f.dir, session, String(i + 1)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    }),
  );

  try {
    await Promise.all(
      children.map(async (child) => {
        const { value } = await child.stdout.getReader().read();
        expect(new TextDecoder().decode(value)).toBe("ready");
      }),
    );

    for (const child of children) child.stdin.end();
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    expect(sessions.map((session) => f.store.get(session))).toEqual([
      { ...style, size: 1 },
      { ...style, size: 2 },
    ]);
    expect(readdirSync(f.root)).toHaveLength(2);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
});
