import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentPreviewCommandSchema,
  AgentPreviewEventSchema,
  AgentTool,
  AgentToolSessionDefaultsSchema,
  type AgentPreviewEvent,
} from "@canopy/contracts";
import type { JsonValue } from "@canopy/domain/json";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import sharp from "sharp";
import { createLocalAutomationMcp } from "../agent-tools-mcp/index.ts";
import { toolEnvironment } from "../agent-tools/paths.ts";
import { eventually, previewFixture } from "./fixtures.test-support.ts";
import { AgentPreviews } from "./index.ts";

const foreground = {
  id: "canopy",
  app_name: "Canopy (Nightly)",
  title: "Thread",
  pid: 17,
  process_instance: "canopy-process",
  is_focused: true,
  accessible: true,
  bounds: { x: 0, y: 0, width: 1200, height: 600 },
};

const probe = {
  ...foreground,
  id: "probe",
  app_name: "Canopy Focus Probe",
  title: "Background",
  pid: 42,
  process_instance: "probe-process",
  is_focused: false,
};

const editor = {
  ...probe,
  id: "editor",
  app_name: "Editor",
  title: "Document",
  pid: 53,
  process_instance: "editor-process",
};

const delivery = { disposition: { delivery: "delivered_verified" } };

async function pixel(frame: AgentPreviewEvent) {
  return Array.from(await sharp(frame.data).resize(1, 1).removeAlpha().raw().toBuffer());
}

async function harness() {
  const f = await previewFixture();
  const green = join(f.dir, "probe.png");
  const red = join(f.dir, "editor.png");
  await Promise.all([
    sharp({ create: { width: 1200, height: 600, channels: 3, background: "#00ff00" } })
      .png()
      .toFile(green),
    sharp({ create: { width: 1200, height: 600, channels: 3, background: "#ff0000" } })
      .png()
      .toFile(red),
  ]);
  f.update({ windowImages: { [probe.id]: green, [editor.id]: red } });
  await f.tools.report();
  const defaults = create(AgentToolSessionDefaultsSchema, { desktop: { allowPhysicalInput: false } });
  const descriptor = f.tools.localMcpServers([AgentTool.DESKTOP], "thread", defaults)[0]!;
  expect(descriptor.args).not.toContain("--headed");
  let denied = false;

  const bridge = createLocalAutomationMcp({
    env: toolEnvironment(f.env),
    servers: [
      {
        ...descriptor,
        command: process.execPath,
        args: [join(import.meta.dir, "../agent-tools/desktop-cursor-fixture.test-support.ts"), f.dir],
      },
    ],
    authorize: async () => {
      if (denied) throw new Error("Denied");
    },
  });

  const endpoint = bridge.servers[0]!;
  const client = new Client({ name: "Desktop follow fixture", version: "1" });
  const events: AgentPreviewEvent[] = [];

  const manager = new AgentPreviews({
    tools: f.tools,
    send: (event) => {
      events.push(create(AgentPreviewEventSchema, event));
    },
  });

  const close = async () => {
    await manager.close();
    await client.close();
    await bridge.close();
    await f.tools.close();
  };

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } }),
    );
  } catch (error) {
    await close();
    throw error;
  }

  const start = (previewId: string, followAgent: boolean, app = "", windowId = "", threadId = "thread") =>
    manager.accept(
      create(AgentPreviewCommandSchema, {
        kind: {
          case: "start",
          value: {
            previewId,
            threadId,
            scope: { tool: AgentTool.DESKTOP, app, windowId },
            followAgent,
            maxFps: 12,
            agentToolDefaults: defaults,
          },
        },
      }),
    );

  const stop = (previewId: string) =>
    manager.accept(create(AgentPreviewCommandSchema, { kind: { case: "stop", value: { previewId } } }));

  const ack = (frame: AgentPreviewEvent) =>
    manager.accept(
      create(AgentPreviewCommandSchema, {
        kind: { case: "ack", value: { previewId: frame.previewId, frameId: frame.frameId } },
      }),
    );

  const reply = (name: string, command: string, data: JsonValue) =>
    writeFileSync(join(f.dir, name + ".json"), JSON.stringify({ ok: true, command, data }));

  const inventory = (windows: (typeof probe)[]) => {
    f.update({ windows });
    reply("desktop_list_windows", "list-windows", windows);
  };

  inventory([foreground, probe, editor]);

  const snapshot = async (win: typeof probe, snapshotId: string, exact = false, unprovenRefs = false) => {
    reply("desktop_snapshot", "snapshot", {
      app: win.app_name,
      snapshot_id: snapshotId,
      complete: true,
      ref_count: 2,
      ...(exact && { window: { id: win.id, title: win.title } }),
      ...(unprovenRefs && { identity_unproven: true }),
      tree: { name: "private AX text" },
    });

    return client.callTool({ name: "desktop_snapshot", arguments: { app: win.app_name } });
  };

  const action = async (name: "type" | "click", ref: string) => {
    reply("desktop_" + name, name, delivery);

    return client.callTool({
      name: "desktop_" + name,
      arguments: { ref_id: ref, ...(name === "type" && { text: "private typed value" }) },
    });
  };

  const screenshot = async (windowId: string) => {
    reply("desktop_screenshot", "screenshot", { format: "png", width: 2400, height: 1200, scale_factor: 2 });

    return client.callTool({ name: "desktop_screenshot", arguments: { window_id: windowId } });
  };

  const inlineScreenshot = async (data: Buffer, windowId?: string) => {
    const { width, height } = await sharp(data).metadata();
    reply("desktop_screenshot", "screenshot", {
      format: "png",
      width,
      height,
      scale_factor: 1,
      data: data.toString("base64"),
    });

    return client.callTool({
      name: "desktop_screenshot",
      arguments: windowId ? { window_id: windowId } : { screen: 0 },
    });
  };

  const frame = (id: string, after = 0) =>
    events.slice(after).find((event) => event.previewId === id && event.state === "frame");

  const ready = (id: string, after = 0) =>
    events.slice(after).some((event) => event.previewId === id && event.state === "ready" && !event.targetId);

  return {
    ...f,
    start,
    stop,
    ack,
    action,
    screenshot,
    inlineScreenshot,
    snapshot,
    events,
    frame,
    ready,
    close,
    inventory,
    deny: (value: boolean) => {
      denied = value;
    },
  };
}

test("mini Desktop Preview follows the background app's AX snapshot, typing and click without cursor opt-in or physical input", async () => {
  const f = await harness();

  try {
    f.start("automatic", true);
    f.start("hinted", true, probe.app_name);
    await eventually(() => f.ready("automatic") && f.ready("hinted"));
    expect(f.calls().some((call) => call.command === "screenshot")).toBe(false);
    f.start("manual", false);
    await eventually(() => Boolean(f.frame("manual")));
    const manual = f.frame("manual")!;
    expect(manual.targetId).toBe(foreground.id);
    expect(manual.followingAgent).toBe(false);
    expect((await pixel(manual))[2]).toBeGreaterThan(245);

    f.deny(true);
    await expect(f.snapshot(probe, "probe-first")).rejects.toThrow("denied");
    expect(f.frame("automatic")).toBeUndefined();
    f.deny(false);
    const snapDir = join(f.dir, ".agent-desktop", "sessions", "thread", "snapshots", "probe-first");
    mkdirSync(snapDir, { recursive: true, mode: 0o700 });

    // Pinned Desktop's process-rooted refs have no source_window_id.
    const source = {
      source_app: probe.app_name,
      pid: probe.pid,
      process_instance: probe.process_instance,
      source_window_title: "",
    };

    writeFileSync(join(snapDir, "refmap.json"), JSON.stringify({ inner: { "@e1": source, "@e2": source } }), {
      mode: 0o600,
    });
    await f.snapshot(probe, "probe-first");
    await eventually(() => Boolean(f.frame("automatic") && f.frame("hinted")));
    expect(f.frame("hinted")?.targetId).toBe(probe.id);

    // Activity changes from app-scoped to ref-only. Reconnecting after the input must use the same private session.
    f.stop("hinted");
    await f.action("type", "@probe-first:e1");
    f.inventory([{ ...foreground, is_focused: false }, probe, { ...editor, is_focused: true }]);
    f.start("rejoined", true);
    await eventually(() => Boolean(f.frame("rejoined")));
    const first = f.frame("automatic")!;
    expect(first.cursor).toBeUndefined();
    await f.action("click", "@probe-first:e2");
    const mark = f.events.length;
    f.ack(first);
    await eventually(() => Boolean(f.frame("automatic", mark)));

    for (const event of f.events.filter((item) => item.state === "frame" && item.previewId !== "manual")) {
      expect(event.followingAgent).toBe(true);
      expect(event.targetId).toBe(probe.id);
      expect(event.targets.map((target) => target.windowId)).toEqual([probe.id]);
      const [r, g, b] = await pixel(event);
      expect(r!).toBeLessThan(10);
      expect(g!).toBeGreaterThan(245);
      expect(b!).toBeLessThan(10);
    }

    const captures = f.calls().filter((call) => call.command === "screenshot" && call.event === "start");
    expect(captures.filter((call) => call.args.includes(foreground.id))).toHaveLength(1);
    expect(
      captures
        .filter((call) => call.args.includes(probe.id))
        .every((call) => call.args.includes("--app=" + probe.app_name)),
    ).toBe(true);
    expect(
      f
        .calls()
        .filter((call) => ["list-windows", "screenshot"].includes(call.command))
        .every((call) => !call.args.includes("--headed")),
    ).toBe(true);
    expect(f.events.filter((event) => event.state !== "frame").every((event) => !event.followingAgent)).toBe(true);
    expect(readFileSync(join(f.dir, "cursor-calls"), "utf8")).not.toContain("cursor_overlay");
  } finally {
    await f.close();
  }
}, 15_000);

test("automatic Desktop drops old captures during target changes, process replacement, ambiguous snapshots and viewer joins", async () => {
  const f = await harness();

  try {
    await f.snapshot(probe, "first", true);
    f.start("slow", true);
    await eventually(() => Boolean(f.frame("slow")));
    const first = f.frame("slow")!;

    const captures = () =>
      f
        .calls()
        .filter((call) => call.command === "screenshot" && call.event === "start" && call.args.includes(probe.id))
        .length;

    const before = captures();
    const gate = join(f.dir, "release-old-capture");
    f.update({ screenshotGate: gate });
    f.ack(first);
    await eventually(() => captures() > before);
    const beforeSwitch = f.events.length;
    await f.snapshot(editor, "second", true);
    await eventually(() => f.ready("slow", beforeSwitch));
    const switched = f.events.length;
    f.update({ screenshotGate: "" });
    f.start("joined", true);
    await eventually(() => f.ready("joined"));
    expect(f.frame("joined")).toBeUndefined();
    writeFileSync(gate, "");
    await eventually(() => Boolean(f.frame("slow", switched) && f.frame("joined")), 4000);

    for (const event of f.events.slice(switched).filter((item) => item.state === "frame")) {
      expect(event.targetId).toBe(editor.id);
      const [r, g, b] = await pixel(event);
      expect(r!).toBeGreaterThan(245);
      expect(g!).toBeLessThan(10);
      expect(b!).toBeLessThan(10);
    }

    // Same window ID and PID, new native process generation. A newly joined watcher must not replay cached bytes.
    const replaced = f.events.length;
    f.inventory([foreground, probe, { ...editor, process_instance: "replacement" }]);
    f.start("after-reuse", true);
    f.ack(f.frame("slow", switched)!);
    await eventually(() => f.ready("slow", replaced) && f.ready("after-reuse", replaced));
    expect(f.events.slice(replaced).some((item) => item.state === "frame")).toBe(false);

    const sibling = { ...probe, id: "probe-sibling", title: "Second", is_focused: true };
    f.inventory([foreground, probe, sibling, editor]);
    await f.snapshot(probe, "ambiguous");
    await f.action("click", "@ambiguous:e2");
    f.start("other-session", true, probe.app_name, sibling.id, "unrelated");
    await eventually(() => f.ready("other-session"));
    expect(f.events.slice(replaced).some((item) => item.state === "frame")).toBe(false);

    // A later explicitly identified native window resolves the ambiguity and resumes the same watch.
    // A tokenless AX element can lack uniqueness while the successful snapshot still proves its window.
    await f.snapshot(probe, "exact", true, true);
    await eventually(() => Boolean(f.frame("after-reuse", replaced)));
    expect(f.frame("after-reuse", replaced)?.targetId).toBe(probe.id);
    expect((await pixel(f.frame("after-reuse", replaced)!))[1]).toBeGreaterThan(245);
    expect(f.frame("other-session")).toBeUndefined();

    // Multiple immutable snapshots can stay live. A qualified ref from the first one can return to its window.
    const newest = f.events.length;
    await f.snapshot(editor, "latest", true);
    f.ack(f.frame("after-reuse", replaced)!);
    await eventually(() => f.frame("after-reuse", newest)?.targetId === editor.id);
    const olderRef = f.events.length;
    await f.action("type", "@first:e1");
    f.ack(f.frame("after-reuse", newest)!);
    await eventually(() => f.frame("after-reuse", olderRef)?.targetId === probe.id);
    expect((await pixel(f.frame("after-reuse", olderRef)!))[1]).toBeGreaterThan(245);
    expect(
      f
        .calls()
        .filter((call) => call.command === "screenshot")
        .every((call) => !call.args.includes(foreground.id)),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 15_000);

test("a successful screenshot of an AX-inaccessible window can supply an exact passive target outside the catalog cap", async () => {
  const f = await harness();

  try {
    const other = Array.from({ length: 70 }, (_, index) => ({
      ...probe,
      id: "other-" + index,
      is_focused: index === 0,
    }));

    f.inventory([foreground, ...other, { ...probe, accessible: false }]);
    f.start("automatic", true, foreground.app_name, foreground.id);
    await eventually(() => f.ready("automatic"));
    expect(f.calls().some((item) => item.command === "screenshot")).toBe(false);
    await f.screenshot(probe.id);
    await eventually(() => Boolean(f.frame("automatic")));
    const frame = f.frame("automatic")!;
    expect(frame).toMatchObject({ targetId: probe.id, followingAgent: true });
    expect(frame.targets).toHaveLength(1);
    expect(frame.targets[0]).toMatchObject({ active: true, windowId: probe.id, app: probe.app_name });
    expect((await pixel(frame))[1]).toBeGreaterThan(245);
    expect(
      f
        .calls()
        .filter((item) => item.command === "screenshot")
        .every((item) => item.args.includes(probe.id)),
    ).toBe(true);

    const mark = f.events.length;
    f.tools.fenceThread("thread");
    f.ack(frame);
    await eventually(() => f.ready("automatic", mark));
    expect(f.frame("automatic", mark)).toBeUndefined();
  } finally {
    await f.close();
  }
}, 10_000);

test("a slow viewer receives the model's exact display screenshot and never captures the desktop on its own", async () => {
  const f = await harness();

  try {
    f.start("slow", true);
    await f.snapshot(probe, "first", true);
    await eventually(() => !!f.frame("slow"));
    const previous = f.frame("slow")!;

    const oneShot = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ffff00" } })
      .png()
      .toBuffer();

    const mark = f.events.length;
    await f.inlineScreenshot(oneShot);
    await eventually(() => f.ready("slow", mark));
    f.start("joining", true);
    await eventually(() => !!f.frame("joining"));
    f.ack(previous);
    await eventually(() => !!f.frame("slow", mark));

    for (const frame of [f.frame("joining")!, f.frame("slow", mark)!]) {
      expect(frame).toMatchObject({
        agentObservation: true,
        followingAgent: false,
        targetId: "",
        mimeType: "image/png",
        width: 64,
        height: 48,
        targets: [],
      });
      expect(Buffer.from(frame.data)).toEqual(oneShot);
      expect(frame.cursor).toBeUndefined();
      f.ack(frame);
    }

    const changed = f.events.length;
    await f.snapshot(editor, "second", true);
    await eventually(() => Boolean(f.frame("joining", changed)));
    expect(f.frame("joining", changed)).toMatchObject({
      followingAgent: true,
      agentObservation: false,
      targetId: editor.id,
    });
    expect(
      f
        .calls()
        .filter((call) => call.command === "screenshot")
        .every((call) => call.args.includes(probe.id) || call.args.includes(editor.id)),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 12_000);

test("a viewer joining a live window starts with the current model image even after other viewers received newer window pixels", async () => {
  const f = await harness();

  try {
    const source = await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#00ffff" } })
      .png()
      .toBuffer();

    f.start("first", true);
    await f.inlineScreenshot(source, probe.id);
    await eventually(() => Boolean(f.frame("first")?.agentObservation));
    const mark = f.events.length;
    f.ack(f.frame("first")!);
    await eventually(() => Boolean(f.frame("first", mark)?.followingAgent));
    expect((await pixel(f.frame("first", mark)!))[2]).toBeLessThan(5);

    f.start("late", true);
    await eventually(() => Boolean(f.frame("late")));
    const late = f.frame("late")!;
    expect(late).toMatchObject({ agentObservation: true, targetId: probe.id });
    expect(Buffer.from(late.data)).toEqual(source);

    // The window is still present, but its live pixels temporarily cannot be captured.
    f.update({ windowImages: { [probe.id]: join(f.dir, "unavailable.png") } });
    const unavailable = f.events.length;
    f.ack(f.frame("first", mark)!);
    await eventually(() => Boolean(f.frame("first", unavailable)?.agentObservation));
    expect(Buffer.from(f.frame("first", unavailable)!.data)).toEqual(source);
  } finally {
    await f.close();
  }
}, 10_000);

test("a model screenshot larger than the frame budget comes from the same returned pixels after resizing", async () => {
  const f = await harness();

  try {
    const width = 1700;
    const height = 480;

    const source = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();

    expect(source.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    f.start("display", true);
    await f.inlineScreenshot(source);
    await eventually(() => Boolean(f.frame("display")));
    const frame = f.frame("display")!;
    expect(frame).toMatchObject({
      agentObservation: true,
      mimeType: "image/jpeg",
      width: 1600,
      viewportWidth: width,
      viewportHeight: height,
      targetId: "",
    });
    const jpeg = await sharp(source).resize(1600).jpeg({ quality: 75 }).toBuffer();
    expect(Buffer.from(frame.data)).toEqual(jpeg);
  } finally {
    await f.close();
  }
}, 10_000);
