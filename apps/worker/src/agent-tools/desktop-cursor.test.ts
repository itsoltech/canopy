import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { JsonValue } from "@canopy/domain/json";
import {
  AgentPreviewCommandSchema,
  AgentPreviewEventSchema,
  AgentPreviewInputSchema,
  AgentTool,
  AgentToolSessionDefaultsSchema,
  RunAgentToolSchema,
  type AgentPreviewEvent,
} from "@canopy/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { tempDirs } from "@canopy/testing";
import { createLocalAutomationMcp } from "../agent-tools-mcp/index.ts";
import type { LocalAutomationServer } from "../agent-tools-mcp/stdio.ts";
import { AgentPreviews } from "../agent-preview/index.ts";
import { eventually, previewFixture } from "../agent-preview/fixtures.test-support.ts";
import { PreviewRuntime } from "../agent-preview/runtime.ts";
import { screenshotPreview } from "../agent-preview/screenshots.ts";
import { DesktopCursors, type DesktopCursorSample, type DesktopPresentation } from "./desktop-cursor.ts";
import { AgentToolLifecycle } from "./lifecycle.ts";
import { DesktopPointerPreferences } from "./desktop-pointer-preferences.ts";
import { toolEnvironment } from "./paths.ts";

const temporary = tempDirs();

const background = {
  id: "w-editor",
  pid: 41,
  process_instance: "editor-generation",
  title: "Document",
  app_name: "Editor",
  is_focused: false,
  bounds: { x: -200, y: 40, width: 1200, height: 600 },
};

const front = {
  ...background,
  id: "w-foreground",
  pid: 42,
  process_instance: "front-generation",
  app_name: "Other",
  is_focused: true,
};

const windows = [front, background];
const ref = "@snapshot-1:e4";
const field = { x: 90, y: 180, width: 20, height: 20 };
const delivery = { disposition: { delivery: "delivered_unverified" } };
const manifestPath = (dir: string) => join(dir, ".agent-desktop", "sessions", "thread", "session.json");

function pointerFixture() {
  const enabled = new Set<string>();
  const shown = new Map<string, DesktopCursorSample>();

  const style = {
    accent: "#ffffff",
    fill: "#000000",
    rim: "#ffffff",
    size: 1,
    travelMinMs: 100,
    travelMaxMs: 200,
    ripple: true,
  };

  const pointer: DesktopPresentation = {
    settings: (session) => (enabled.has(session) ? style : undefined),
    configure: async (session, params) => {
      if (params.name === "desktop_cursor_overlay_enable") enabled.add(session);
      else enabled.delete(session);

      return { content: [] };
    },
    disableLegacy: async () => {},
    show: (session, sample) => {
      shown.set(session, sample);
    },
    hide: (session) => {
      shown.delete(session);
    },
    end: (session) => {
      shown.delete(session);
      enabled.delete(session);
    },
    close: () => shown.clear(),
  };

  return { pointer, enabled, shown };
}

function nativeSnapshot(dir: string, snapshot: string, win = background) {
  const path = join(dir, ".agent-desktop", "sessions", "thread", "snapshots", snapshot);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(path, "refmap.json"),
    JSON.stringify({
      counter: 4,
      inner: {
        "@e4": {
          source_window_id: win.id,
          pid: win.pid,
          process_instance: win.process_instance,
          source_app: win.app_name,
          bounds_space: "window",
          bounds: { x: 10, y: 20, width: 20, height: 20 },
          value: "private stored value",
        },
      },
    }),
    { mode: 0o600 },
  );
}

test("authorized Desktop actions annotate matching Preview frames and follow a background ref across viewers", async () => {
  const display = pointerFixture();
  const f = await previewFixture(AgentTool.DESKTOP, display.pointer);
  f.update({ windows });
  await f.tools.report();
  const defaults = create(AgentToolSessionDefaultsSchema, { desktop: { allowPhysicalInput: false } });
  const descriptor = f.tools.localMcpServers([AgentTool.DESKTOP], "thread", defaults)[0]!;
  const calls: string[] = [];
  let denied = true;

  const bridge = createLocalAutomationMcp({
    env: toolEnvironment(f.env),
    servers: [
      {
        ...descriptor,
        command: process.execPath,
        args: [join(import.meta.dir, "desktop-cursor-fixture.test-support.ts"), f.dir],
      },
    ],
    authorize: async (_server, name) => {
      calls.push(name);

      if (denied) throw new Error("Denied");
    },
  });

  const client = new Client({ name: "Preview cursor fixture", version: "1" });
  const events: AgentPreviewEvent[] = [];

  const previews = new AgentPreviews({
    tools: f.tools,
    send: (event) => {
      const parsed = create(AgentPreviewEventSchema, event);
      events.push(parsed);

      if (parsed.state === "frame")
        previews.accept(
          create(AgentPreviewCommandSchema, {
            kind: { case: "ack", value: { previewId: parsed.previewId, frameId: parsed.frameId } },
          }),
        );
    },
  });

  const start = (previewId: string, windowId = "", app = "") =>
    previews.accept(
      create(AgentPreviewCommandSchema, {
        kind: {
          case: "start",
          value: {
            previewId,
            threadId: "thread",
            scope: { tool: AgentTool.DESKTOP, windowId, app },
            agentToolDefaults: { desktop: { app: front.app_name } },
          },
        },
      }),
    );

  const reply = (name: string, command: string, data: JsonValue) =>
    writeFileSync(join(f.dir, name + ".json"), JSON.stringify({ ok: true, command, data }));

  const clear = () => events.splice(0);
  const frame = (id: string) => events.findLast((event) => event.previewId === id && event.state === "frame");
  const action = (name: string, args = {}) => client.callTool({ name, arguments: args });
  const endpoint = bridge.servers[0]!;

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }),
    );
    await expect(action("desktop_cursor_overlay_enable")).rejects.toThrow("denied");
    expect(existsSync(manifestPath(f.dir))).toBe(false);
    expect(display.enabled.size).toBe(0);
    denied = false;
    await action("desktop_cursor_overlay_enable");
    nativeSnapshot(f.dir, "snapshot-1");
    nativeSnapshot(f.dir, "snapshot-2", front);
    reply("desktop_list_windows", "list-windows", windows);
    reply("desktop_get", "get", { ref, property: "bounds", live: true, value: field });
    reply("desktop_click", "click", delivery);
    expect((await action("desktop_click", { ref_id: ref })).structuredContent).toEqual({
      ok: true,
      command: "click",
      data: delivery,
    });
    expect(calls).toEqual(["desktop_cursor_overlay_enable", "desktop_cursor_overlay_enable", "desktop_click"]);
    start("follow");
    start("pinned", front.id);
    await eventually(() => Boolean(frame("follow")?.cursor && frame("pinned")));
    const first = frame("follow")!;
    expect(first.targetId).toBe(background.id);
    expect(first.cursor).toMatchObject({ x: 0.25, y: 0.25, click: true });
    expect(display.shown.get("thread")).toMatchObject({
      actionId: first.cursor!.actionId,
      identity: { id: background.id },
    });
    expect(frame("pinned")?.cursor).toBeUndefined();
    start("joined");
    await eventually(() => Boolean(frame("joined")));
    expect(frame("joined")?.cursor?.actionId).toBe(first.cursor!.actionId);
    expect(frame("joined")?.cursor?.click).toBe(false);
    expect(events.some((event) => event.state !== "frame" && event.cursor)).toBe(false);
    start("pinned-app", "", front.app_name);
    await eventually(() => Boolean(frame("pinned-app")));
    expect(frame("pinned-app")?.targetId).toBe(front.id);
    expect(frame("pinned-app")?.cursor).toBeUndefined();
    previews.accept(create(AgentPreviewCommandSchema, { kind: { case: "stop", value: { previewId: "pinned-app" } } }));

    clear();
    reply("desktop_type", "type", delivery);
    await action("desktop_type", { ref_id: ref, text: "private model input" });
    await eventually(() => frame("follow")?.cursor?.click === false);
    expect(frame("follow")?.cursor?.actionId).not.toBe(first.cursor!.actionId);
    expect(JSON.stringify(frame("follow")?.cursor)).not.toContain("private");

    const other = "@snapshot-2:e4";
    reply("desktop_get", "get", { ref: other, property: "bounds", live: true, value: field });
    await action("desktop_click", { ref_id: other });
    await eventually(() => frame("follow")?.targetId === front.id && Boolean(frame("follow")?.cursor));
    clear();
    f.update({ windows: [background, { ...front, process_instance: "replacement" }] });
    await eventually(() => Boolean(frame("follow")) && !frame("follow")?.cursor && !display.shown.size);
    expect(display.enabled.has("thread")).toBe(true);
    clear();
    await action("desktop_cursor_overlay_disable");
    await eventually(() => Boolean(frame("follow")));
    expect(frame("follow")?.cursor).toBeUndefined();
    expect(display.shown.size).toBe(0);
    expect(readFileSync(join(f.dir, "cursor-calls"), "utf8")).not.toContain("desktop_cursor_overlay_enable");
    expect(existsSync(manifestPath(f.dir))).toBe(false);
    expect(
      readFileSync(join(f.dir, "cursor-calls"), "utf8")
        .split("\n")
        .filter((name) => name === "desktop_click"),
    ).toHaveLength(2);
  } finally {
    await previews.close();
    await client.close();
    await bridge.close();
    await f.tools.close();
  }
}, 15_000);

test("one-shot Desktop input and Preview controls retire the session's legacy global cursor before native input", async () => {
  const f = await previewFixture();
  const file = manifestPath(f.dir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });

  const previous = () =>
    writeFileSync(
      file,
      JSON.stringify({ id: "thread", created_at: 1, cursor_overlay: { enabled: true, style: { ripple: false } } }),
      { mode: 0o600 },
    );

  const settings = new DesktopPointerPreferences(f.dir);
  const stop = new AbortController();
  const runtime = new PreviewRuntime(await f.tools.resolvePreviewScope(f.scope), stop.signal);
  const backend = screenshotPreview({ runtime, signal: stop.signal, active: () => false, emit: () => {} });

  try {
    await backend.start();
    previous();
    await f.tools.run(
      create(RunAgentToolSchema, { tool: AgentTool.DESKTOP, operation: "click", target: ref, session: "thread" }),
    );
    expect(settings.get("thread")?.ripple).toBe(false);
    previous();

    const gesture = ["pointer-down", "pointer-up"].map((kind) =>
      create(AgentPreviewInputSchema, { kind, x: 0.5, y: 0.5 }),
    );

    await backend.input(gesture, "viewer");
    expect(
      f
        .calls()
        .filter((item) => item.event === "start" && ["cursor-overlay", "click", "mouse-click"].includes(item.command))
        .map((item) => item.command),
    ).toEqual(["cursor-overlay", "click", "cursor-overlay", "mouse-click"]);
    f.tools.fenceThread("thread");
    expect(settings.get("thread")).toBeUndefined();
    await expect(backend.input(gesture, "viewer")).rejects.toThrow("closed");
  } finally {
    stop.abort();
    await backend.close();
    await f.tools.close();
  }
});

type NativeCall = Parameters<NonNullable<LocalAutomationServer["managed"]>["call"]>[2];

function result(command: string, data: JsonValue, ok = true): CallToolResult {
  return { content: [], structuredContent: { command, ok, data }, isError: !ok };
}

test("Desktop keeps one confirmed action across slow, refused and cancelled calls, and drops ambiguous positions", async () => {
  const dir = temporary("canopy-desktop-cursor-");
  const env = { HOME: dir };
  const display = pointerFixture();
  display.enabled.add("thread");
  const cursors = new DesktopCursors(display.pointer);
  const abort = new AbortController();
  nativeSnapshot(dir, "snapshot-1");
  const managed = cursors.configure("thread", env, true, new AgentToolLifecycle()).managed!;
  let inventory = windows;
  let live = true;
  let delivered = true;
  let nativeSucceeded = true;

  const next: NativeCall = async (call) => {
    if (call.name === "desktop_list_windows") return result("list-windows", inventory);

    if (call.name === "desktop_get") return result("get", { ref, property: "bounds", live, value: field });
    const command = call.name.slice(8).replaceAll("_", "-");

    return result(
      command,
      {
        disposition: { delivery: delivered ? "delivered_verified" : "not_delivered" },
        ...((call.name === "desktop_mouse_click" || call.name === "desktop_hover") && {
          target: { kind: "pointer", point: { x: 100, y: 190 } },
        }),
      },
      nativeSucceeded,
    );
  };

  const click = { name: "desktop_click", arguments: { ref_id: ref } };
  const raw = { name: "desktop_mouse_click", arguments: { xy: "100,190" } };
  const current = () => cursors.current("thread");

  try {
    await managed.call(click, abort.signal, next);
    const first = current()!;
    expect(first.identity.id).toBe(background.id);
    expect(cursors.current("other-thread")).toBeUndefined();
    const afterIdle = Date.now() + 5_000;
    const clock = spyOn(Date, "now").mockReturnValue(afterIdle);

    try {
      expect(current()).toEqual({ ...first, click: false });
    } finally {
      clock.mockRestore();
    }

    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const older = managed.call(click, abort.signal, async (params, signal) => {
      if (params.name === click.name) {
        arrived.resolve();
        await release.promise;
      }

      return next(params, signal);
    });

    await arrived.promise;
    expect(current()?.actionId).toBe(first.actionId);

    try {
      await managed.call({ name: "desktop_type", arguments: { ref_id: ref, text: "text" } }, abort.signal, next);
    } finally {
      release.resolve();
      await older;
    }

    const second = current()!;
    expect(second.actionId).not.toBe(first.actionId);
    expect(second.click).toBe(false);
    nativeSucceeded = false;
    await managed.call(click, abort.signal, next);
    expect(current()?.actionId).toBe(second.actionId);
    nativeSucceeded = true;
    delivered = false;
    await managed.call(click, abort.signal, next);
    expect(current()?.actionId).toBe(second.actionId);
    delivered = true;

    await managed.call(raw, abort.signal, next);
    expect(current()).toBeUndefined();
    expect(display.shown.size).toBe(0);
    inventory = [background];
    await managed.call(raw, abort.signal, next);
    // A single layer-zero window in inventory still does not identify the receiver of a raw screen click.
    expect(current()).toBeUndefined();
    const hover = { name: "desktop_hover", arguments: { ref_id: ref } };
    await managed.call(hover, abort.signal, next);
    expect(current()).toMatchObject({ x: 0.25, y: 0.25, click: false });
    expect(display.shown.get("thread")?.actionId).toBe(current()?.actionId);
    await managed.call(hover, abort.signal, (params, signal) => {
      if (params.name === "desktop_hover") inventory = [front];

      return next(params, signal);
    });
    expect(current()).toBeUndefined();
    inventory = windows;
    await managed.call(click, abort.signal, next);
    const cancelled = new AbortController();
    let sent = false;
    await expect(
      managed.call(click, cancelled.signal, async (params, signal) => {
        if (params.name === "desktop_get") cancelled.abort();

        if (params.name === click.name) sent = true;

        return next(params, signal);
      }),
    ).rejects.toThrow();
    expect(sent).toBe(false);
    expect(current()?.click).toBe(true);
    await expect(
      managed.call(click, abort.signal, async (params, signal) => {
        if (params.name === click.name) throw new Error("Native connection closed after dispatch");

        return next(params, signal);
      }),
    ).rejects.toThrow("after dispatch");
    expect(current()).toBeUndefined();
    await managed.call(click, abort.signal, next);
    live = false;
    await managed.call(click, abort.signal, next);
    expect(current()).toBeUndefined();
    live = true;
    await managed.call(click, abort.signal, next);
    await managed.call({ name: "desktop_batch", arguments: {} }, abort.signal, async () =>
      result("batch", {
        results: [{ command: "click", ok: true, data: { after_action: delivery } }],
      }),
    );
    expect(current()).toBeUndefined();
    expect(display.shown.size).toBe(0);
    await managed.call(click, abort.signal, next);
    await managed.call({ name: "desktop_session_end", arguments: { id: "thread" } }, abort.signal, async () =>
      result("session", { session_id: "thread", ended_at: 1 }),
    );
    expect(current()).toBeUndefined();
    expect(display.enabled.size).toBe(0);
  } finally {
    abort.abort();
    cursors.close();
  }
});
