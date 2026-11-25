import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@canopy/domain/json";
import { tempDirs } from "@canopy/testing";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import sharp from "sharp";
import { MAX_BYTES } from "../agent-tools-mcp/protocol.ts";
import type { AutomationCall } from "../agent-tools-mcp/session-policy.ts";
import type { DesktopObservation } from "./desktop-observation.ts";
import { DesktopObservationStore } from "./desktop-observation-store.ts";
import { DesktopTargets } from "./desktop-targets.ts";
import type { DesktopNativeCall } from "./desktop-window.ts";

const temporary = tempDirs();

const editor = {
  id: "editor-window",
  app_name: "Editor",
  pid: 41,
  process_instance: "editor-epoch",
  title: "Document",
  bounds: { x: 120, y: 30, width: 32, height: 24 },
  accessible: false,
  is_focused: false,
};

const front = {
  ...editor,
  id: "canopy-window",
  app_name: "Canopy",
  pid: 42,
  process_instance: "canopy-epoch",
  title: "Mini Preview",
  is_focused: true,
};

const shape = { format: "png", scale_factor: 2, width: 64, height: 48 };

function pixels(color: string, format: "png" | "jpeg" = "png", width = shape.width, height = shape.height) {
  const image = sharp({ create: { width, height, channels: 3, background: color } });

  return image.toFormat(format).toBuffer();
}

function response(command: string, data: JsonValue, bytes?: Buffer, mimeType = "image/png"): CallToolResult {
  const structuredContent = { command, ok: true, data };

  return {
    structuredContent,
    content: [
      { type: "text", text: JSON.stringify(structuredContent) },
      ...(bytes ? [{ type: "image" as const, mimeType, data: bytes.toString("base64") }] : []),
    ],
  };
}

function harness() {
  const targets = new DesktopTargets();
  const home = temporary("canopy-observation-");
  const env = { HOME: home };
  const requests: string[] = [];
  const stop = new AbortController();

  const list: DesktopNativeCall = async (params) => {
    requests.push(params.name);
    expect(params.name).toBe("desktop_list_windows");

    return response("list-windows", [front, editor]);
  };

  const run = (command: string, args: AutomationCall["arguments"], result: CallToolResult, session = "thread") =>
    targets.run(
      session,
      env,
      { name: "desktop_" + command.replaceAll("-", "_"), arguments: args },
      stop.signal,
      list,
      async () => result,
    );

  return {
    targets,
    env,
    home,
    requests,
    stop,
    list,
    run,
    close() {
      stop.abort();
      targets.close();
    },
  };
}

test("Desktop keeps the exact MCP image for its own session and identifies only an ordinary verified window screenshot", async () => {
  const f = harness();
  const notices: (DesktopObservation | undefined)[] = [];
  f.targets.watch("thread", f.stop.signal, () => {
    throw new Error("Viewer disconnected");
  });
  f.targets.watch("thread", f.stop.signal, () => notices.push(f.targets.observation("thread")));

  try {
    const first = await pixels("green");
    const result = response("screenshot", shape, first);
    const original = JSON.stringify(result);
    expect(await f.run("screenshot", { app: editor.app_name, window_id: editor.id }, result)).toBe(result);
    expect(JSON.stringify(result)).toBe(original);
    const seen = f.targets.observation("thread")!;
    expect(seen).toMatchObject({
      mimeType: "image/png",
      width: 64,
      height: 48,
      windowAligned: true,
      title: "Editor — Document",
    });
    expect(seen.target).toBe(f.targets.current("thread"));
    expect(seen.target?.identity).toEqual({
      id: editor.id,
      pid: editor.pid,
      process_instance: editor.process_instance,
    });
    expect(Buffer.from(seen.data)).toEqual(first);
    expect(f.targets.observation("thread")).toBe(seen);
    expect(f.targets.observation("other")).toBeUndefined();

    const changed = await pixels("blue", "jpeg", 72, 52);
    const shadow = response("screenshot", { ...shape, format: "jpg", width: 72, height: 52 }, changed, "image/jpeg");
    await f.run("screenshot", { window_id: editor.id }, shadow);
    const next = f.targets.observation("thread")!;
    expect(notices).toEqual([seen, undefined, next]);
    expect(next).toMatchObject({
      mimeType: "image/jpeg",
      windowAligned: false,
      target: { identity: { id: editor.id } },
    });
    expect(Buffer.from(next.data)).toEqual(changed);
    expect(f.requests).toEqual(Array(4).fill("desktop_list_windows"));

    const observedDisplay = response("screenshot", shape, first);
    await f.run("screenshot", { screen: 1 }, observedDisplay);
    expect(f.targets.current("thread")).toBeUndefined();
    expect(f.targets.observation("thread")).toMatchObject({ title: "Display 2 screenshot", windowAligned: false });
    expect(f.targets.observation("thread")?.target).toBeUndefined();
    await f.run("screenshot", {}, observedDisplay, "other");
    expect(f.targets.observation("other")?.title).toBe("Desktop screenshot");
    await f.run("screenshot", { app: editor.app_name, region: { x: 1, y: 1, width: 8, height: 6 } }, observedDisplay);
    expect(f.targets.observation("thread")?.title).toBe("Agent screenshot");
    expect(f.targets.current("thread")).toBeUndefined();
    expect(f.requests).toHaveLength(4);
    f.targets.end("thread");
    expect(f.targets.observation("thread")).toBeUndefined();
    expect(f.targets.observation("other")).toBeDefined();
  } finally {
    f.close();
  }
});

test("artifacts, errors, hidden, malformed and oversized image replies cannot expose pixels in Desktop Preview", async () => {
  const f = harness();

  try {
    const bytes = await pixels("purple");
    const path = join(f.home, "model-selected.png");
    writeFileSync(path, bytes);
    const pathOnly = response("screenshot", { ...shape, path });
    await f.run("screenshot", { window_id: editor.id, output_path: path }, pathOnly);
    expect(f.targets.observation("thread")).toBeUndefined();

    const ax = {
      app: editor.app_name,
      snapshot_id: "ax-123",
      window: { id: editor.id },
      tree: { screenshot: path, encoded: bytes.toString("base64") },
    };

    const snapshot = response("snapshot", ax);
    await f.run("snapshot", { app: editor.app_name }, snapshot);
    expect(f.targets.observation("thread")).toBeUndefined();

    const afterAction = response(
      "press",
      {
        ...ax,
        after_action: {
          disposition: { delivery: "delivered_verified" },
          target: { kind: "window", id: editor.id, process: { pid: editor.pid, instance: editor.process_instance } },
        },
      },
      bytes,
    );

    await f.run("press", { key: "return", window_id: editor.id }, afterAction);
    expect(f.targets.observation("thread")?.title).toBe("Agent observation");
    expect(f.targets.observation("thread")?.target).toBeUndefined();
    expect(f.targets.current("thread")?.identity.id).toBe(editor.id);
    expect(Buffer.from(f.targets.observation("thread")!.data)).toEqual(bytes);
    const annotated = response("screenshot", { ...shape, annotations: [{ label: "ref" }] }, bytes);
    await f.run("screenshot", { window_id: editor.id }, annotated);
    expect(f.targets.observation("thread")?.title).toBe("Agent screenshot");
    expect(f.targets.current("thread")).toBeUndefined();

    const valid = response("screenshot", shape, bytes);
    const block = { type: "image" as const, mimeType: "image/png", data: bytes.toString("base64") };
    const broken = Buffer.concat([bytes.subarray(0, 33), bytes.subarray(-12)]);

    const invalid: CallToolResult[] = [
      { ...valid, isError: true },
      { ...valid, structuredContent: { command: "other", ok: true, data: shape } },
      { ...valid, content: [{ ...block, annotations: { audience: ["user"] } }] },
      { ...valid, content: [{ ...block, mimeType: "image/jpeg" }] },
      { ...valid, content: [{ ...block, data: broken.toString("base64") }] },
      { ...valid, content: [{ ...block, data: block.data.slice(0, -4) + "----" }] },
      { ...valid, content: [block, { type: "text", text: "x".repeat(MAX_BYTES) }] },
    ];

    for (const item of invalid) {
      expect(await f.run("screenshot", {}, item)).toBe(item);
      expect(f.targets.observation("thread")).toBeUndefined();
    }

    await f.run("screenshot", {}, valid);
    await f.run("batch", {}, response("batch", { results: [{ command: "screenshot", data: shape }] }, bytes));
    expect(f.targets.observation("thread")).toBeUndefined();
    expect(f.targets.current("thread")).toBeUndefined();
  } finally {
    f.close();
  }
});

test("a new read, a different window, cancellation or a session fence supersedes an in-flight Desktop observation", async () => {
  const f = harness();
  const bytes = await pixels("red");
  const screenshot = response("screenshot", shape, bytes);
  const params = { name: "desktop_screenshot", arguments: { window_id: editor.id } };

  const slow = (signal: AbortSignal) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let count = 0;

    const result = f.targets.run(
      "thread",
      f.env,
      params,
      signal,
      async (p, s) => {
        if (++count === 2) {
          entered.resolve();
          await release.promise;
        }

        return f.list(p, s);
      },
      async () => screenshot,
    );

    return {
      entered: entered.promise,
      release: async () => {
        release.resolve();

        return result;
      },
    };
  };

  try {
    const green = await pixels("green");
    const older = slow(f.stop.signal);

    try {
      await older.entered;
      await f.run("screenshot", { window_id: front.id }, response("screenshot", shape, green));
    } finally {
      expect(await older.release()).toBe(screenshot);
    }

    expect(f.targets.observation("thread")?.target?.identity.id).toBe(front.id);
    expect(Buffer.from(f.targets.observation("thread")!.data)).toEqual(green);

    for (const next of ["wait", "read", "end", "abort"]) {
      const request = new AbortController();
      const { entered, release } = slow(request.signal);

      try {
        await entered;

        if (next === "wait") await f.run("wait", { window: "Mini" }, response("wait", { found: true, window: front }));
        else if (next === "read") await f.run("list-notifications", {}, response("list-notifications", []));
        else if (next === "end") f.targets.end("thread");
        else request.abort();
      } finally {
        expect(await release()).toBe(screenshot);
      }

      expect(f.targets.current("thread")?.identity.id).toBe(next === "wait" ? front.id : undefined);
      expect(f.targets.observation("thread")).toBeUndefined();
    }

    let count = 0;
    await f.targets.run(
      "thread",
      f.env,
      params,
      f.stop.signal,
      async () =>
        response("list-windows", [
          front,
          ++count === 1 ? editor : { ...editor, process_instance: "reused-id-and-pid" },
        ]),
      async () => screenshot,
    );
    expect(f.targets.current("thread")).toBeUndefined();
    expect(f.targets.observation("thread")?.target).toBeUndefined();
    expect(Buffer.from(f.targets.observation("thread")!.data)).toEqual(bytes);
    let inventories = 0;
    await f.targets.run(
      "thread",
      f.env,
      { name: "desktop_screenshot", arguments: { app: editor.app_name } },
      f.stop.signal,
      async () =>
        response("list-windows", ++inventories === 1 ? [editor] : [editor, { ...front, app_name: editor.app_name }]),
      async () => screenshot,
    );
    expect(f.targets.current("thread")).toBeUndefined();
    expect(f.targets.observation("thread")?.target).toBeUndefined();
    await f.run("focus-window", { window_id: editor.id }, response("focus-window", { focused: editor }));
    expect(f.targets.current("thread")?.identity.id).toBe(editor.id);
    expect(f.targets.observation("thread")).toBeUndefined();
    await f.run(
      "open-system-surface",
      { surface: "start-menu" },
      response("open-system-surface", { surface: "start-menu" }),
    );
    expect(f.targets.current("thread")).toBeUndefined();
    await f.run(
      "list-windows",
      { app: editor.app_name },
      response("list-windows", [editor, { ...editor, id: "second" }]),
    );
    expect(f.targets.current("thread")).toBeUndefined();
  } finally {
    f.close();
  }
});

test("a global Desktop inventory clears the previously observed window and a timed wait preserves it", async () => {
  const f = harness();

  try {
    const screenshot = await pixels("green");
    await f.run("screenshot", { window_id: editor.id }, response("screenshot", shape, screenshot));
    const target = f.targets.current("thread");
    expect(target?.identity.id).toBe(editor.id);

    await f.run("wait", { ms: 20 }, response("wait", { elapsed_ms: 20 }));
    expect(f.targets.current("thread")).toBe(target);
    expect(f.targets.observation("thread")).toBeUndefined();

    await f.run("list-windows", {}, response("list-windows", [editor, front]));
    expect(f.targets.current("thread")).toBeUndefined();
    expect(f.targets.observation("thread")).toBeUndefined();
  } finally {
    f.close();
  }
});

test("repeated explicit window reads and a unique app scope keep live capture running while invalidating previous model pixels", async () => {
  const f = harness();
  const exact = { app: editor.app_name, snapshot_id: "exact-123", window: { id: editor.id }, tree: {} };
  const unique = { app: editor.app_name, snapshot_id: "unique-123", tree: {} };
  const scoped = { window_id: editor.id, app: editor.app_name };
  const events: (string | undefined)[] = [];
  f.targets.watch("thread", f.stop.signal, () => events.push(f.targets.current("thread")?.identity.id));

  const inspectPending = async (
    command: string,
    args: AutomationCall["arguments"],
    result: CallToolResult,
    inspect: () => void,
  ) => {
    const dispatched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const pending = f.targets.run(
      "thread",
      f.env,
      { name: "desktop_" + command, arguments: args },
      f.stop.signal,
      f.list,
      async () => {
        dispatched.resolve();
        await release.promise;

        return result;
      },
    );

    try {
      await dispatched.promise;
      inspect();
    } finally {
      release.resolve();
      await pending;
    }
  };

  try {
    await f.run("snapshot", scoped, response("snapshot", exact));
    const first = f.targets.current("thread");
    const unchanged = () => expect(f.targets.current("thread")).toBe(first);
    await inspectPending("snapshot", { window_id: editor.id }, response("snapshot", exact), unchanged);
    unchanged();
    expect(events).toEqual([editor.id]);
    const copy = response("screenshot", shape, await pixels("green"));
    await inspectPending("screenshot", scoped, copy, unchanged);
    expect(f.targets.observation("thread")?.target).toBe(first);
    await inspectPending("snapshot", scoped, response("snapshot", exact), () => {
      unchanged();
      expect(f.targets.observation("thread")).toBeUndefined();
    });
    unchanged();

    // An exact proof does not make an app-only request unambiguous while that request runs.
    await inspectPending("snapshot", { app: editor.app_name }, response("snapshot", unique), () => {
      expect(f.targets.current("thread")).toBeUndefined();
    });
    const single = f.targets.current("thread");
    expect(single?.unique).toBe(true);
    await inspectPending("snapshot", { app: editor.app_name }, response("snapshot", unique), () => {
      expect(f.targets.current("thread")).toBe(single);
    });
    expect(f.targets.current("thread")).toBe(single);
    await inspectPending(
      "screenshot",
      { window_id: editor.id, app: front.app_name },
      { ...copy, isError: true },
      () => {
        expect(f.targets.current("thread")).toBeUndefined();
      },
    );
  } finally {
    f.close();
  }
});

test("Desktop observation storage bounds all sessions' bytes and evicts expired, aborted and least-recently-used sources", () => {
  const changed: string[] = [];
  const store = new DesktopObservationStore((session) => changed.push(session));
  const stop = new AbortController();

  const image: DesktopObservation = {
    data: Buffer.alloc(4 * 1024 * 1024),
    mimeType: "image/png",
    width: 64,
    height: 48,
    windowAligned: false,
    title: "Agent observation",
  };

  const at = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(at);

  try {
    for (const session of ["a", "b", "c", "d"]) store.set(session, image, stop.signal);
    clock.mockReturnValue(at + 12_000);
    expect(store.get("a")).toBe(image);
    store.set("e", image, stop.signal);
    expect(store.get("b")).toBeUndefined();
    expect(changed).toEqual(["b"]);
    clock.mockReturnValue(at + 16_000);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("e")).toBe(image);
    stop.abort();
    expect(store.get("e")).toBeUndefined();
    expect(changed).toEqual(["b", "a", "c", "d", "e"]);
  } finally {
    stop.abort();
    clock.mockRestore();
  }
});
