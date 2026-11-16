import { expect, test } from "bun:test";
import { existsSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentPreviewCommandSchema,
  AgentPreviewEventSchema,
  AgentPreviewInputSchema,
  RunAgentToolSchema,
  type AgentPreviewEvent,
  type AgentPreviewInput,
} from "@canopy/contracts";
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
    expect(existsSync(path)).toBe(true);
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
  runtime.scope.deviceId = "emulator-5556";
  runtime.scope.platform = "android";
  const selected = await deviceCatalog(runtime);
  expect(selected.targetId).toBe("android:emulator-5556");
  expect(selected.targets.find((target) => target.active)?.id).toBe(selected.targetId);
  const controls = new DeviceInput(runtime);
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
