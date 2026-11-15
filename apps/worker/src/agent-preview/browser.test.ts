import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentPreviewCommandSchema,
  AgentPreviewEventSchema,
  AgentPreviewInputSchema,
  AgentTool,
  RunAgentToolSchema,
  type AgentPreviewEvent,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import sharp from "sharp";
import { executable } from "../agent-tools/fixtures.test-support.ts";
import { AgentTools } from "../agent-tools/index.ts";
import { agentToolSpec } from "../agent-tools/specs.ts";
import { browserPreview } from "./browser.ts";
import { AgentPreviews } from "./index.ts";
import { sendBrowserText } from "./browser-support.ts";
import { PreviewRuntime } from "./runtime.ts";
import type { PreviewContext, PreviewUpdate } from "./types.ts";

const temp = tempDirs();

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (!check()) {
    if (Date.now() > deadline) throw new Error("Preview test timed out");
    await Bun.sleep(10);
  }
}

function fixture(enabled: boolean, connected = true, viewport = { width: 512, height: 256 }) {
  const root = temp("canopy-browser-preview-");
  const log = join(root, "calls.jsonl");
  const state = join(root, "state.json");
  const sockets = new Set<ServerWebSocket<undefined>>();
  const messages: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;

      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        const current = JSON.parse(readFileSync(state, "utf8"));
        socket.send(
          JSON.stringify({
            type: "status",
            connected: current.connected,
            viewportWidth: 512,
            viewportHeight: 256,
            engine: "chrome",
          }),
        );

        if (!current.connected) return;
        socket.send(
          JSON.stringify({
            type: "tabs",
            tabs: [{ tabId: "t7", title: "Fixture", url: current.url || "https://fixture.invalid/", active: true }],
          }),
        );
      },
      message(_socket, message) {
        messages.push(message.toString());
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });

  writeFileSync(state, JSON.stringify({ enabled, connected, port: server.port, ...viewport }));

  const cli = executable(
    join(root, "browser-cli"),
    `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("doctor")) { console.log(JSON.stringify({ success: true, checks: [{ id: "launch.elapsed", status: "pass", message: "Ready" }] })); process.exit(0); }
const args = process.argv.slice(2).slice(3);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const path = ${JSON.stringify(state)};
const state = JSON.parse(readFileSync(path, "utf8"));
if (args[0] === "open") { state.connected = true; state.url = args[1]; }
if (args[1] === "enable") state.enabled = true;
if (args[1] === "disable") state.enabled = false;
if (args[0] === "set" && args[1] === "viewport") { state.width = Number(args[2]); state.height = Number(args[3]); }
const data = args[0] === "eval" ? { result: { width: state.width, height: state.height } } : { ...state, port: state.enabled ? state.port : null };
if (args[1] === "status" && state.openAfterStatus) {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(["open", state.openAfterStatus]) + "\\n");
  state.connected = true;
  state.url = state.openAfterStatus;
  delete state.openAfterStatus;
}
writeFileSync(path, JSON.stringify(state));
console.log(JSON.stringify({ success: true, data }));
`,
  );

  const updates: PreviewUpdate[] = [];
  const controller = new AbortController();

  const runtime = new PreviewRuntime(
    {
      executable: cli,
      env: {},
      redact: (detail) => detail,
      scope: create(RunAgentToolSchema, { tool: AgentTool.BROWSER, session: crypto.randomUUID() }),
    },
    controller.signal,
  );

  let active = true;

  const context: PreviewContext = {
    runtime,
    signal: controller.signal,
    active: () => active,
    emit(update) {
      updates.push(update);

      if (update.state === "frame") active = false;
    },
  };

  return {
    context,
    runtime,
    updates,
    messages,
    server,
    sockets,
    controller,
    tools: new AgentTools({
      dataDir: root,
      env: {},
      probe: {
        platform: "linux",
        which: (name) => (name === "agent-browser" ? cli : null),
        version: async () => ({ line: agentToolSpec(AgentTool.BROWSER).version }),
      },
      send: () => {},
      progress: () => {},
    }),
    capacity: () => {
      active = true;
    },
    send: (value: string) => {
      for (const socket of sockets) socket.send(value);
    },
    openAfterStatus: (url: string) => {
      const current = JSON.parse(readFileSync(state, "utf8"));
      writeFileSync(state, JSON.stringify({ ...current, openAfterStatus: url }));
    },
    currentUrl: (): string => JSON.parse(readFileSync(state, "utf8")).url ?? "",
    calls: (): string[][] =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
  };
}

const input = (kind: string, init: Parameters<typeof create<typeof AgentPreviewInputSchema>>[1] = {}) =>
  create(AgentPreviewInputSchema, { ...init, kind });

test("browser group replays one bounded frame to late viewers without a repaint and clears it on tab change and close", async () => {
  const f = fixture(true);
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
          value: { previewId: id, threadId: "thread", scope: { tool: AgentTool.BROWSER }, maxFps: 12 },
        },
      }),
    );

  const frames = (id: string) => events.filter((update) => update.previewId === id && update.state === "frame");

  const jpeg = await sharp({ create: { width: 512, height: 256, channels: 3, background: "white" } })
    .jpeg()
    .toBuffer();

  try {
    start("one");
    await until(() => events.some((update) => update.targetId === "t7" || update.state === "error"));
    expect(events.filter((update) => update.state === "error")).toEqual([]);
    f.send(
      JSON.stringify({
        type: "frame",
        seq: 41,
        data: jpeg.toString("base64"),
        metadata: { deviceWidth: 512, deviceHeight: 256 },
      }),
    );
    await until(() => frames("one").length === 1);
    start("two");
    await until(() => frames("two").length === 1);
    expect(frames("two")[0]).toMatchObject({ frameId: 1n, targetId: "t7", mimeType: "image/jpeg" });
    expect(frames("two")[0]?.data).toEqual(frames("one")[0]?.data);
    expect(f.sockets.size).toBe(1);
    expect(f.calls().filter((args) => args[0] === "eval")).toHaveLength(1);
    f.send(JSON.stringify({ type: "tabs", tabs: [{ tabId: "t8", title: "Next", url: "about:blank", active: true }] }));
    await until(() => events.some((update) => update.targetId === "t8"));
    start("three");
    await until(() => events.some((update) => update.previewId === "three" && update.targetId === "t8"));
    expect(frames("three")).toHaveLength(0);
    manager.accept(
      create(AgentPreviewCommandSchema, { kind: { case: "ack", value: { previewId: "one", frameId: 1n } } }),
    );
    await until(() => f.messages.some((message) => JSON.parse(message).seq === 41));
    f.send(
      JSON.stringify({
        type: "frame",
        seq: 42,
        data: jpeg.toString("base64"),
        metadata: { deviceWidth: 512, deviceHeight: 256 },
      }),
    );
    await until(() => frames("three").length === 1);
    manager.stopThread("thread");
    await until(() => f.sockets.size === 0);
    start("fresh");
    await until(() => events.some((update) => update.previewId === "fresh" && update.targetId === "t7"));
    expect(frames("fresh")).toHaveLength(0);
  } finally {
    await manager.close();
    f.server.stop(true);
  }
});

test("native browser input shares a stream, maps CSS coordinates, paces frames and releases only its owner's holds", async () => {
  const f = fixture(false);
  const first = browserPreview(f.context);
  const second = browserPreview({ ...f.context, emit: () => {} });

  try {
    await first.start();
    await second.start();
    await until(() => f.sockets.size === 2 && f.updates.some((update) => update.targets?.length === 1));

    const jpeg = await sharp({ create: { width: 1024, height: 512, channels: 3, background: "white" } })
      .jpeg()
      .toBuffer();

    // Only one recipient gets this frame: each native connection has its own ack pacing.
    f.sockets
      .values()
      .next()
      .value!.send(
        JSON.stringify({
          type: "frame",
          seq: 41,
          data: jpeg.toString("base64"),
          metadata: { deviceWidth: 512, deviceHeight: 256 },
        }),
      );
    await until(() => f.updates.some((update) => update.state === "frame"));
    await Bun.sleep(60);
    expect(f.messages.some((message) => JSON.parse(message).type === "ack")).toBe(false);
    f.capacity();
    await until(() => f.messages.some((message) => message.includes('"seq":41')));
    const frame = f.updates.find((update) => update.state === "frame");
    expect(frame).toMatchObject({ width: 1024, height: 512, viewportWidth: 512, viewportHeight: 256, targetId: "t7" });
    expect(f.calls()).toEqual([
      ["stream", "status"],
      ["stream", "enable", "--port", "0"],
      ["eval", "({width:window.innerWidth,height:window.innerHeight})"],
    ]);

    await first.input(
      [
        input("pointer-down", { x: 0.5, y: 0.5 }),
        input("pointer-up", { x: 0.5, y: 0.5 }),
        input("pointer-down", { x: 0.5, y: 0.5 }),
        input("pointer-up", { x: 0.5, y: 0.5 }),
        input("wheel", { x: 0.25, y: 0.25, deltaX: -5, deltaY: 100 }),
        input("text", { text: "Zażółć 👋" }),
        input("key-down", { key: "Control", code: "ControlLeft", modifiers: 2 }),
      ],
      "one",
    );
    await second.input([input("key-down", { key: "Control", code: "ControlLeft", modifiers: 2 })], "two");
    await first.release("one");
    await until(() => f.messages.length >= 9);
    const events = f.messages.map((message) => JSON.parse(message));
    expect(events.filter((event) => event.eventType === "mousePressed").map((event) => event.clickCount)).toEqual([
      1, 2,
    ]);
    expect(events.find((event) => event.eventType === "mousePressed")).toMatchObject({ x: 256, y: 128 });
    expect(events.find((event) => event.eventType === "mouseWheel")).toMatchObject({
      x: 128,
      y: 64,
      deltaX: -5,
      deltaY: 100,
    });
    const characters = events.filter((event) => event.eventType === "char").map((event) => event.text);
    expect(characters).toEqual([..."Zażółć 👋"]);
    expect(characters.join("")).toBe("Zażółć 👋");
    expect(events.filter((event) => event.eventType === "keyUp")).toHaveLength(0);
    await first.close();
    expect(f.calls().some((args) => args[1] === "disable")).toBe(false);
    await second.close();
    await until(() => f.messages.some((message) => JSON.parse(message).eventType === "keyUp"));
    expect(f.calls().at(-1)).toEqual(["stream", "disable"]);
  } finally {
    await first.close();
    await second.close();
    f.server.stop(true);
  }
});

test("browser pointer geometry uses the page viewport when configured stream height includes window chrome", async () => {
  const f = fixture(true, true, { width: 512, height: 253 });
  const preview = browserPreview(f.context);

  const jpeg = await sharp({ create: { width: 1024, height: 506, channels: 3, background: "white" } })
    .jpeg()
    .toBuffer();

  const frame = (seq: number) =>
    JSON.stringify({
      type: "frame",
      seq,
      data: jpeg.toString("base64"),
      metadata: { deviceWidth: 512, deviceHeight: 300 },
    });

  try {
    await preview.start();
    await until(() => f.sockets.size === 1);
    f.send(frame(1));
    await until(() => f.updates.some((update) => update.state === "frame"));
    expect(f.updates.find((update) => update.state === "frame")).toMatchObject({
      width: 1024,
      height: 506,
      viewportWidth: 512,
      viewportHeight: 253,
    });
    await preview.input([input("pointer-down", { x: 0.5, y: 0.75 }), input("pointer-up", { x: 0.5, y: 0.75 })], "one");
    await until(() => f.messages.some((message) => JSON.parse(message).eventType === "mousePressed"));
    expect(
      f.messages.map((message) => JSON.parse(message)).find((event) => event.eventType === "mousePressed"),
    ).toMatchObject({ x: 256, y: 189.75 });
    f.capacity();
    await until(() => f.messages.some((message) => JSON.parse(message).seq === 1));
    f.send(frame(2));
    await until(() => f.updates.filter((update) => update.state === "frame").length === 2);
    expect(f.calls().filter((args) => args[0] === "eval")).toHaveLength(1);
    f.capacity();
    await until(() => f.messages.some((message) => JSON.parse(message).seq === 2));
    await preview.input([input("resize", { width: 400, height: 300 })], "one");
    f.send(frame(3));
    await until(() => f.updates.filter((update) => update.state === "frame").length === 3);
    expect(f.updates.filter((update) => update.state === "frame").at(-1)).toMatchObject({
      viewportWidth: 400,
      viewportHeight: 300,
    });
    expect(f.calls().filter((args) => args[0] === "eval")).toHaveLength(2);
  } finally {
    await preview.close();
    f.server.stop(true);
  }
});

test("browser paste drains its transport queue and cancels a blocked write", async () => {
  const controller = new AbortController();
  const socket = { bufferedAmount: 256 * 1024, readyState: WebSocket.OPEN };
  const messages: string[] = [];
  const paste = "Zażółć 👋\nsecond line\twith tabs e\u0301 ".repeat(100);

  const writing = sendBrowserText(socket, paste, controller.signal, (message) =>
    messages.push(JSON.stringify(message)),
  );

  await Bun.sleep(25);
  expect(messages).toHaveLength(0);
  socket.bufferedAmount = 0;
  await writing;
  expect(messages.map((message) => JSON.parse(message).text).join("")).toBe(paste);
  expect(messages.every((message) => [...JSON.parse(message).text].length === 1)).toBe(true);

  socket.bufferedAmount = 256 * 1024;
  const blocked = sendBrowserText(socket, "text", controller.signal, () => {});
  controller.abort();
  await expect(blocked).rejects.toMatchObject({ name: "AbortError" });
});

test("browser preview preserves agent navigation after a disconnected status", async () => {
  const f = fixture(false, false);
  const preview = browserPreview(f.context);
  const url = "https://fixture.invalid/agent-target";
  f.openAfterStatus(url);

  try {
    await preview.start();
    await until(() => f.updates.some((update) => update.url === url));
    expect(f.calls()).toEqual([
      ["stream", "status"],
      ["open", url],
      ["stream", "enable", "--port", "0"],
    ]);
    expect(f.currentUrl()).toBe(url);
  } finally {
    await preview.close();
    f.server.stop(true);
  }
});

test("disconnected browser previews allow explicit navigation and leave externally owned streams enabled", async () => {
  const f = fixture(true, false);
  const preview = browserPreview(f.context);

  try {
    await preview.start();
    await until(() => f.updates.some((update) => update.state === "ready"));
    expect(f.updates.at(-1)).toMatchObject({ state: "ready", detail: "Waiting for a page…" });
    expect(f.calls()).toEqual([["stream", "status"]]);
    expect(f.currentUrl()).toBe("");
    const url = "https://fixture.invalid/manual-target";
    await preview.input([input("navigate", { text: url })], "one");
    expect(f.currentUrl()).toBe(url);
    expect(f.calls()).toEqual([
      ["stream", "status"],
      ["open", url],
    ]);
    f.send(JSON.stringify({ type: "frame", seq: 1, data: "AAAA", metadata: { deviceWidth: 8193, deviceHeight: 1 } }));
    await until(() => f.updates.some((update) => update.state === "error"));
    await preview.close();
    expect(f.calls().some((args) => args[1] === "disable")).toBe(false);
    expect(f.updates.some((update) => update.state === "frame")).toBe(false);
  } finally {
    await preview.close();
    f.server.stop(true);
  }
});
