import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopPointerPresentation } from "./desktop-pointer.ts";

const session = "existing-thread";
const scratch: string[] = [];
const signal = new AbortController().signal;

const disabled = {
  content: [],
  structuredContent: {
    ok: true,
    command: "cursor-overlay",
    data: { session_id: session, cursor_overlay: { enabled: false } },
  },
};

function existingOverlay() {
  const dir = mkdtempSync(join(tmpdir(), "canopy-cursor-upgrade-"));
  scratch.push(dir);
  const native = join(dir, "native");
  const state = join(native, "sessions", session);
  mkdirSync(state, { recursive: true, mode: 0o700 });

  const persist = (enabled: boolean) =>
    writeFileSync(
      join(state, "session.json"),
      JSON.stringify({ id: session, created_at: 1, cursor_overlay: { enabled, style: { ripple: false } } }),
      { mode: 0o600 },
    );

  persist(true);

  return { pointer: new DesktopPointerPresentation(dir), env: { AGENT_DESKTOP_HOME: native }, persist };
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { force: true, recursive: true });
});

test("adopts the previous opt-in only after confirmed native shutdown, and all later toggles stay local", async () => {
  const { pointer, env, persist } = existingOverlay();
  await expect(pointer.disableLegacy(session, signal, async () => undefined, env)).rejects.toThrow("could not hide");
  expect(pointer.settings(session)).toBeUndefined();
  await pointer.disableLegacy(
    session,
    signal,
    async (params) => {
      expect(params).toEqual({ name: "desktop_cursor_overlay_disable", arguments: {} });
      persist(false);

      return disabled;
    },
    env,
  );
  expect(pointer.settings(session)?.ripple).toBe(false);

  const unexpected = async () => {
    throw new Error("Unexpected native cursor call");
  };

  const enabled = await pointer.configure(
    session,
    { name: "desktop_cursor_overlay_enable", arguments: { accent: "#abcdef" } },
    signal,
    unexpected,
    env,
  );

  expect(enabled.structuredContent?.["ok"]).toBe(true);
  expect(pointer.settings(session)?.fill).toBe("#abcdef");
  await pointer.configure(session, { name: "desktop_cursor_overlay_disable", arguments: {} }, signal, unexpected, env);
  expect(pointer.settings(session)).toBeUndefined();
});

test("archiving during native shutdown cancels migration and an already queued enable", async () => {
  const { pointer, env, persist } = existingOverlay();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();

  const next = async () => {
    started.resolve();
    await finish.promise;
    persist(false);

    return disabled;
  };

  const migration = pointer.disableLegacy(session, signal, next, env);

  const enable = pointer.configure(
    session,
    { name: "desktop_cursor_overlay_enable", arguments: {} },
    signal,
    next,
    env,
  );

  const settled = Promise.allSettled([migration, enable]);

  try {
    await started.promise;
    pointer.end(session);
  } finally {
    finish.resolve();
    await settled;
  }

  expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(pointer.settings(session)).toBeUndefined();
});
