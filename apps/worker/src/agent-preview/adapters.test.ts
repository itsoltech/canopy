import { expect, test } from "bun:test";
import { existsSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentToolSessionDefaultsSchema,
  AgentPreviewCommandSchema,
  AgentPreviewEventSchema,
  AgentPreviewInputSchema,
  RunAgentToolSchema,
  type AgentPreviewEvent,
  type AgentPreviewInput,
} from "@canopy/contracts";
import { PreviewRuntime } from "./runtime.ts";
import { AgentPreviews } from "./index.ts";
import { screenshotPreview } from "./screenshots.ts";
import { DesktopCatalog, deviceCatalog } from "./catalog.ts";
import { DesktopInput } from "./desktop-input.ts";
import { DeviceInput } from "./device-input.ts";
import { readPreviewImage } from "./frames.ts";
import { previewFixture, eventually } from "./fixtures.test-support.ts";
import type { PreviewUpdate } from "./types.ts";

const event = (kind: string, fields: Partial<Omit<AgentPreviewInput, "$typeName" | "$unknown" | "kind">> = {}) =>
  create(AgentPreviewInputSchema, { kind, ...fields });

test("shared screenshot viewers capture once, gate on exact ACK, and stopThread cancels capture and removes files", async () => {
  const f = await previewFixture();
  const events: AgentPreviewEvent[] = [];

  const manager = new AgentPreviews({
    tools: f.tools,
    send: (update) => {
      events.push(create(AgentPreviewEventSchema, update));
    },
  });

  const start = (id: string) =>
    manager.accept(
      create(AgentPreviewCommandSchema, {
        kind: {
          case: "start",
          value: {
            previewId: id,
            threadId: "thread",
            scope: create(RunAgentToolSchema, { tool: AgentTool.DESKTOP }),
            maxFps: 12,
          },
        },
      }),
    );

  const ack = (id: string, frameId: bigint) =>
    manager.accept(create(AgentPreviewCommandSchema, { kind: { case: "ack", value: { previewId: id, frameId } } }));

  try {
    start("one");
    await eventually(() => events.filter((update) => update.state === "frame").length === 1);
    start("two");
    await eventually(() => events.filter((update) => update.state === "frame").length === 2, 250);
    const frames = events.filter((update) => update.state === "frame");
    expect(frames.map((frame) => [frame.width, frame.height, frame.viewportWidth, frame.viewportHeight])).toEqual([
      [1600, 800, 1200, 600],
      [1600, 800, 1200, 600],
    ]);
    expect(f.calls().filter((call) => call.command === "screenshot" && call.event === "start")).toHaveLength(1);
    ack("one", 0n);
    ack("one", 99n);
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    expect(events.filter((update) => update.state === "frame")).toHaveLength(2);
    ack("one", 1n);
    await eventually(
      () => events.filter((update) => update.previewId === "one" && update.state === "frame").length === 2,
    );
    expect(events.filter((update) => update.previewId === "two" && update.state === "frame")).toHaveLength(1);
    const screenshotCalls = f.calls().filter((call) => call.command === "screenshot" && call.event === "start");
    const path = screenshotCalls[0]?.args.at(-1) ?? "";
    expect(existsSync(path)).toBe(false);
    f.update({ screenshotDelay: 5000 });
    ack("one", 2n);
    await eventually(
      () => f.calls().filter((call) => call.command === "screenshot" && call.event === "start").length === 3,
    );
    const stoppedAt = Date.now();
    await manager.stopThread("thread");
    expect(Date.now() - stoppedAt).toBeLessThan(1500);
    expect(existsSync(path)).toBe(false);
    expect(events.filter((update) => update.state === "closed")).toHaveLength(2);
    expect(f.calls().every((call) => !call.secret)).toBe(true);
  } finally {
    await manager.close();
  }
});

test("desktop inputs pin a window, map original logical bounds and use atomic gestures plus focused text refs", async () => {
  const f = await previewFixture();
  const runtime = f.runtime();
  const catalog = new DesktopCatalog(runtime);
  const metadata = await catalog.refresh();
  const controls = new DesktopInput(runtime, catalog);
  expect(metadata.targetId).toBe("window-1");
  await controls.input(event("pointer-down", { x: 0.5, y: 0.5 }), "owner");
  await controls.input(event("pointer-up", { x: 0.5, y: 0.5 }), "owner");
  await controls.input(event("pointer-down", { x: 0, y: 0 }), "owner");
  await controls.input(event("pointer-up", { x: 1, y: 1 }), "owner");
  await controls.input(event("wheel", { x: 0.5, y: 0.5, deltaY: 120 }), "owner");
  await controls.input(event("key-down", { key: "a", modifiers: 2 }), "owner");
  await controls.input(event("text", { text: "--session=literal\n☃" }), "owner");
  const calls = f.calls().filter((call) => call.event === "start");
  expect(calls.find((call) => call.command === "mouse-click")?.args).toContain("--xy=499.5,339.5");
  expect(calls.find((call) => call.command === "drag")?.args).toContain("--from-xy=-100,40");
  expect(calls.find((call) => call.command === "drag")?.args).toContain("--to-xy=1099,639");
  expect(calls.find((call) => call.command === "mouse-wheel")?.args).toContain("--dy=-3");
  expect(calls.find((call) => call.command === "press")?.args.slice(-4)).toEqual([
    "--window-id",
    "window-1",
    "--",
    "ctrl+a",
  ]);
  const typed = calls.find((call) => call.command === "type");
  expect(typed?.args.slice(-4)).toEqual(["type", "--stdin", "--", "@snapshot:e1"]);
  expect(typed?.stdin).toBe("--session=literal\n☃");
  await expect(controls.input(event("navigate", { text: "https://example.test" }), "owner")).rejects.toThrow(
    "does not support",
  );
});

test("desktop defaults follow focus while explicit windows and apps retain their scope", async () => {
  const f = await previewFixture();

  const windows = [
    {
      id: "editor",
      title: "Document",
      app_name: "Editor",
      is_focused: true,
      bounds: { x: 0, y: 0, width: 1200, height: 600 },
    },
    {
      id: "terminal",
      title: "Shell",
      app_name: "Terminal",
      is_focused: false,
      bounds: { x: 1200, y: 0, width: 800, height: 600 },
    },
  ];

  f.update({ windows });
  const runtime = f.runtime();
  const following = new DesktopCatalog(runtime);
  const pinnedRuntime = f.runtime();
  pinnedRuntime.scope.windowId = "editor";
  const pinned = new DesktopCatalog(pinnedRuntime);
  const appRuntime = f.runtime();
  appRuntime.scope.app = "Editor";
  const app = new DesktopCatalog(appRuntime);
  expect((await following.refresh()).targetId).toBe("editor");
  expect((await pinned.refresh()).targetId).toBe("editor");
  expect((await app.refresh()).targetId).toBe("editor");

  f.update({ windows: windows.map((window) => ({ ...window, is_focused: window.id === "terminal" })) });
  expect((await following.refresh()).targetId).toBe("terminal");
  expect(following.point(0, 0)).toEqual({ x: 1200, y: 0 });
  expect(following.scopeArgs()).toEqual(["--window-id", "terminal"]);
  expect((await pinned.refresh()).targetId).toBe("editor");
  expect((await app.refresh()).targetId).toBe("editor");

  f.update({ windows: windows.filter((window) => window.id === "terminal") });
  expect((await pinned.refresh()).targetId).toBe("");
  expect((await app.refresh()).targetId).toBe("");
});

test("device catalog keeps selection usable without an active session and maps taps/swipes against logical dimensions", async () => {
  const f = await previewFixture(AgentTool.DEVICE);
  f.update({
    readiness: false,
    sessions: [],
    devices: [
      { id: "emulator-5554", name: "One", platform: "android" },
      { id: "emulator-5556", name: "Two", platform: "android" },
    ],
  });
  const resolved = await f.tools.resolvePreviewScope(f.scope);
  expect(resolved.executable).toBe(f.path(AgentTool.DEVICE));
  const runtime = f.runtime();
  const catalog = await deviceCatalog(runtime);
  expect(catalog.selected).toBe(false);
  expect(catalog.targets).toHaveLength(2);
  expect(catalog.targetId).toBe("");
  const selectedRuntime = f.runtime();
  selectedRuntime.scope.deviceId = "emulator-5556";
  selectedRuntime.scope.platform = "android";
  const selected = await deviceCatalog(selectedRuntime);
  expect(selected.targetId).toBe("android:emulator-5556");
  expect(selected.targets.find((target) => target.active)?.id).toBe(selected.targetId);
  const controls = new DeviceInput(selectedRuntime);
  controls.width = 400;
  controls.height = 800;
  await controls.input(event("pointer-down", { x: 0.5, y: 0.5 }), "a");
  await controls.input(event("pointer-up", { x: 0.5, y: 0.5 }), "a");
  await controls.input(event("pointer-down", { x: 0, y: 0 }), "a");
  await controls.input(event("pointer-up", { x: 1, y: 1 }), "a");
  await controls.input(event("text", { text: "--literal" }), "a");
  const clicks = f.calls().filter((call) => call.command === "click" && call.event === "start");
  expect(clicks[0]?.args.slice(-3)).toEqual(["--", "200", "400"]);
  const swipe = f.calls().find((call) => call.command === "swipe" && call.event === "start");
  expect(swipe?.args.slice(-5)).toEqual(["--", "0", "0", "399", "799"]);
  expect(swipe?.args).toContain("--no-post-gesture-stabilization");
  expect(
    f
      .calls()
      .find((call) => call.command === "type")
      ?.args.slice(-2),
  ).toEqual(["--", "--literal"]);
});

test("device catalog follows its session and hides pinned targets outside that session", async () => {
  const f = await previewFixture(AgentTool.DEVICE);

  const devices = [
    { id: "emulator-5554", name: "One", platform: "android" },
    { id: "emulator-5556", name: "Two", platform: "android" },
    { id: "sim-1", name: "iPhone", platform: "ios" },
  ];

  const select = (id: string, platform: string) => f.update({ sessions: [{ name: "thread", id, platform }] });
  f.update({ devices });
  const following = f.runtime();
  const filtered = f.runtime();
  filtered.scope.platform = "android";
  const pinned = f.runtime();
  pinned.scope.platform = "android";
  pinned.scope.deviceId = "emulator-5554";

  for (const runtime of [following, filtered, pinned])
    expect((await deviceCatalog(runtime)).targetId).toBe("android:emulator-5554");

  select("emulator-5556", "android");
  expect((await deviceCatalog(following)).targetId).toBe("android:emulator-5556");
  expect((await deviceCatalog(filtered)).targetId).toBe("android:emulator-5556");
  expect((await deviceCatalog(pinned)).targetId).toBe("");
  await following.command(["home"]);
  expect(f.calls().find((call) => call.command === "home")?.args).toContain("emulator-5556");

  select("sim-1", "ios");
  expect((await deviceCatalog(following)).targetId).toBe("ios:sim-1");
  expect((await deviceCatalog(filtered)).targetId).toBe("");
  expect((await deviceCatalog(pinned)).targetId).toBe("");
  f.update({ devices: devices.filter((device) => device.id !== "emulator-5554") });
  expect((await deviceCatalog(pinned)).targetId).toBe("");
});

test("Apple device selection accepts public iOS and macOS platforms and preserves narrower filters", async () => {
  const f = await previewFixture(AgentTool.DEVICE);
  f.update({
    devices: [
      { id: "sim-1", name: "iPhone", platform: "ios" },
      { id: "mac-1", name: "Mac", platform: "macos" },
    ],
    sessions: [{ name: "thread", id: "sim-1", platform: "ios" }],
  });
  const apple = f.runtime();
  apple.scope.platform = "apple";
  const pinned = f.runtime();
  pinned.scope.platform = "apple";
  pinned.scope.deviceId = "sim-1";
  const ios = f.runtime();
  ios.scope.platform = "ios";
  ios.scope.deviceId = "mac-1";
  expect((await deviceCatalog(apple)).targetId).toBe("ios:sim-1");
  expect((await deviceCatalog(pinned)).targetId).toBe("ios:sim-1");
  expect((await deviceCatalog(ios)).targetId).toBe("");

  f.update({ sessions: [{ name: "thread", id: "mac-1", platform: "macos" }] });
  expect((await deviceCatalog(apple)).targetId).toBe("macos:mac-1");
  expect((await deviceCatalog(pinned)).targetId).toBe("");
  await apple.command(["home"]);
  expect(f.calls().find((call) => call.command === "home")?.args).toEqual([
    "--json",
    "--session",
    "thread",
    "--platform",
    "macos",
    "--udid",
    "mac-1",
    "home",
  ]);
});

test("catalog-only screenshot backend emits selectable targets and never captures or accepts input without selection", async () => {
  const f = await previewFixture(AgentTool.DEVICE);
  f.update({
    sessions: [],
    devices: [
      { id: "a", name: "One", platform: "android" },
      { id: "b", name: "Two", platform: "android" },
    ],
  });
  const controller = new AbortController();
  const updates: PreviewUpdate[] = [];

  const backend = screenshotPreview({
    runtime: f.runtime(controller.signal),
    signal: controller.signal,
    active: () => true,
    emit: (update) => updates.push(update),
  });

  await backend.start();
  expect(updates.find((update) => update.state === "ready")?.targets).toHaveLength(2);
  expect(f.calls().some((call) => call.command === "screenshot")).toBe(false);
  await expect(backend.input([event("pointer-down")], "owner")).rejects.toThrow("Select a preview target");
  controller.abort();
  await backend.close();
});

test("worker enforces four viewers and rejects malformed input before any CLI action", async () => {
  const f = await previewFixture();
  const events: AgentPreviewEvent[] = [];

  const manager = new AgentPreviews({
    tools: f.tools,
    send: (update) => {
      events.push(create(AgentPreviewEventSchema, update));
    },
  });

  try {
    for (let index = 0; index < 5; index++)
      manager.accept(
        create(AgentPreviewCommandSchema, {
          kind: {
            case: "start",
            value: {
              previewId: `watch-${index}`,
              threadId: "thread",
              scope: create(RunAgentToolSchema, { tool: AgentTool.DESKTOP }),
            },
          },
        }),
      );
    await eventually(() => events.some((update) => update.previewId === "watch-4" && update.state === "error"));
    expect(events.find((update) => update.previewId === "watch-4" && update.state === "error")?.detail).toContain(
      "four",
    );
    manager.accept(
      create(AgentPreviewCommandSchema, {
        kind: { case: "input", value: { previewId: "watch-0", inputs: [event("pointer-down", { x: 2 })] } },
      }),
    );
    await eventually(() => events.some((update) => update.previewId === "watch-0" && update.state === "closed"));
    expect(f.calls().some((call) => call.command === "mouse-click")).toBe(false);
  } finally {
    await manager.close();
  }
});

test("preview file reads reject symlinks and oversized files before reading", async () => {
  const f = await previewFixture();
  const path = join(f.dir, "symlink.png");
  symlinkSync(join(f.dir, "source.png"), path);
  expect(() => readPreviewImage(path)).toThrow("regular");
  writeFileSync(join(f.dir, "invalid.png"), "not an image");
  expect(readPreviewImage(join(f.dir, "invalid.png"))).toHaveLength(12);
});

test("Preview command app defaults filter the initial window while explicit window selection takes precedence", async () => {
  const f = await previewFixture();
  const events: AgentPreviewEvent[] = [];

  const manager = new AgentPreviews({
    tools: f.tools,
    send: (event) => {
      events.push(create(AgentPreviewEventSchema, event));
    },
  });

  const editor = {
    id: "editor",
    title: "Document",
    app_name: "Editor",
    is_focused: false,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  };

  const terminal = { ...editor, id: "terminal", title: "Shell", app_name: "Terminal", is_focused: true };
  f.update({ windows: [editor, terminal] });

  try {
    manager.accept(
      create(AgentPreviewCommandSchema, {
        kind: {
          case: "start",
          value: {
            previewId: "default-app",
            threadId: "thread",
            scope: f.scope,
            agentToolDefaults: { desktop: { app: "Editor" } },
          },
        },
      }),
    );
    await eventually(() => events.some((event) => event.previewId === "default-app" && event.state === "frame"));
    expect(events.find((event) => event.previewId === "default-app" && event.state === "frame")?.targetId).toBe(
      "editor",
    );
    await manager.stopThread("thread");
    manager.accept(
      create(AgentPreviewCommandSchema, {
        kind: {
          case: "start",
          value: {
            previewId: "explicit-window",
            threadId: "thread",
            scope: { ...f.scope, windowId: "terminal" },
            agentToolDefaults: { desktop: { app: "Editor" } },
          },
        },
      }),
    );
    await eventually(() => events.some((event) => event.previewId === "explicit-window" && event.state === "frame"));
    expect(events.find((event) => event.previewId === "explicit-window" && event.state === "frame")?.targetId).toBe(
      "terminal",
    );
  } finally {
    await manager.close();
    await f.tools.close();
  }
});

test("Device Preview prefers the held session over defaults and only catalogs devices without boot or waiting", async () => {
  const f = await previewFixture(AgentTool.DEVICE);

  const defaults = create(AgentToolSessionDefaultsSchema, {
    device: { platform: "ios", allowBoot: true, acquireTimeoutSeconds: 240 },
  });

  f.update({
    devices: [
      { id: "emulator-5554", name: "Android", platform: "android" },
      { id: "ios-udid", name: "iPhone", platform: "ios" },
    ],
  });

  const runtime = async (platform = "", deviceId = "") =>
    new PreviewRuntime(
      await f.tools.resolvePreviewScope(create(RunAgentToolSchema, { ...f.scope, platform, deviceId }), defaults),
      new AbortController().signal,
    );

  try {
    expect((await deviceCatalog(await runtime())).targetId).toBe("android:emulator-5554");
    f.update({ sessions: [] });
    expect((await deviceCatalog(await runtime())).targetId).toBe("ios:ios-udid");
    expect((await deviceCatalog(await runtime("android"))).targetId).toBe("android:emulator-5554");
    expect((await deviceCatalog(await runtime("", "emulator-5554"))).targetId).toBe("android:emulator-5554");
    expect(
      f
        .calls()
        .every((call) => ["session", "devices", "doctor"].includes(call.command) || call.args.includes("--version")),
    ).toBe(true);
  } finally {
    await f.tools.close();
  }
});
