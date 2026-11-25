import { afterEach, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDesktopOverlay, readDesktopRefMap } from "./desktop-overlay.ts";

const scratch: string[] = [];
const session = "01234567-89ab-7cde-8123-456789abcdef";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "canopy-desktop-state-"));
  scratch.push(home);
  const root = join(home, "native");
  const dir = join(root, "sessions", session);

  return { home, dir, root, env: { AGENT_DESKTOP_HOME: root, HOME: home } };
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("native overlay detection is passive and requires an enabled manifest for the exact active session", () => {
  const f = fixture();
  expect(readDesktopOverlay(session, f.env)).toBeUndefined();
  expect(readDesktopRefMap(session, f.env, "s0123")).toBeUndefined();
  expect(readdirSync(f.home)).toEqual([]);
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const path = join(f.dir, "session.json");
  const seed = { id: session, created_at: 1, trace: "off", artifacts: "events" };

  for (const [state, expected] of [
    [{ ...seed, cursor_overlay: { enabled: true } }, { ripple: true }],
    [{ ...seed, cursor_overlay: { enabled: true, style: { ripple: false } } }, { ripple: false }],
    [{ ...seed, ended_at: 2, cursor_overlay: { enabled: true } }, undefined],
    [{ ...seed, id: "different", cursor_overlay: { enabled: true } }, undefined],
    [{ ...seed, cursor_overlay: { enabled: false } }, undefined],
    [seed, undefined],
  ] as const) {
    const native = JSON.stringify(state);
    writeFileSync(path, native, { mode: 0o600 });
    expect(readDesktopOverlay(session, f.env)).toEqual(expected);
    expect(readFileSync(path, "utf8")).toBe(native);
  }

  expect(readdirSync(f.dir)).toEqual(["session.json"]);
});

test("refmap reads use the subprocess's relocated or default state and reject links, traversal and oversized files", () => {
  const f = fixture();
  const snapshot = join(f.dir, "snapshots", "s0123");
  mkdirSync(snapshot, { recursive: true, mode: 0o700 });
  const path = join(snapshot, "refmap.json");
  const native = '{"inner":{"@e1":{"window_id":"one"}}}';
  writeFileSync(path, native, { mode: 0o600 });
  expect(readDesktopRefMap(session, f.env, "s0123")).toBe(native);
  expect(readDesktopRefMap("../other", f.env, "s0123")).toBeUndefined();
  expect(readDesktopRefMap(session, f.env, "../../../other")).toBeUndefined();
  expect(readDesktopRefMap(session, { ...f.env, AGENT_DESKTOP_HOME: "" }, "s0123")).toBeUndefined();
  const second = join(f.home, "other");
  linkSync(path, second);
  expect(readDesktopRefMap(session, f.env, "s0123")).toBeUndefined();
  rmSync(second);
  writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
  expect(readDesktopRefMap(session, f.env, "s0123")).toBeUndefined();
  writeFileSync(path, native);
  renameSync(f.root, join(f.home, ".agent-desktop"));
  expect(readDesktopRefMap(session, { USERPROFILE: f.home }, "s0123")).toBe(native);
  symlinkSync(join(f.home, ".agent-desktop"), f.root, "junction");
  expect(readDesktopRefMap(session, f.env, "s0123")).toBeUndefined();
  const real = join(f.home, ".agent-desktop", "sessions", session);
  renameSync(real, second);
  symlinkSync(second, real, "junction");
  expect(readDesktopRefMap(session, { HOME: f.home }, "s0123")).toBeUndefined();
});
