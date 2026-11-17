import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentTool, RunAgentToolSchema } from "@canopy/contracts";
import { agentToolSession } from "./scope.ts";
import { cleanupFixture, waitFor } from "./cleanup.test-support.ts";
import { serializeAgentTool } from "./queue.ts";
import { AgentTools } from "./index.ts";
import { fixture } from "./fixtures.test-support.ts";

const { BROWSER, DESKTOP, DEVICE } = AgentTool;

test("restart cleanup closes only the thread's browser/daemon/helpers and preserves shared resources", async () => {
  const f = cleanupFixture();
  const raw = "thread/with unsafe session";
  const session = agentToolSession(raw);

  const children = Array.from({ length: 6 }, () =>
    Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    }),
  );

  const pid = (index: number) => {
    const child = children[index];

    if (!child) throw new Error("Missing fixture process");

    return child.pid;
  };

  try {
    f.state(BROWSER, { sessions: { [session]: [pid(0), pid(1)], other: [pid(2)] } });
    f.state(DESKTOP, { sessions: { [session]: [pid(3)], other: [] } });
    f.state(DEVICE, { running: true, sessions: { [session]: [pid(4)], other: [] } });
    // A fresh instance has no report or MCP usage, just like a restarted worker.
    await f.manager().closeThread(raw);
    await waitFor(() =>
      [0, 1, 3, 4].every((index) => children[index]?.signalCode !== null || children[index]?.exitCode !== null),
    );
    expect(children[2]?.exitCode).toBeNull();
    expect(children[5]?.exitCode).toBeNull();
    expect(f.read(BROWSER).sessions).toEqual({ other: [pid(2)] });
    expect(f.read(DESKTOP).sessions).toEqual({ [session]: [], other: [] });
    expect(f.read(DEVICE)).toMatchObject({ running: true, sessions: { other: [] } });
    expect(f.calls().some((call) => call.privateEnv)).toBe(false);
    expect(
      f
        .calls()
        .some((call) => call.args.includes("doctor") || call.args.includes("--all") || call.args.includes("stop")),
    ).toBe(false);
    await f.manager().closeThread(raw);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
});

test("unused sessions use offline listings and daemon status without starting native runtimes", async () => {
  const f = cleanupFixture();
  await f.manager().closeThread("unused");
  expect(
    f
      .calls()
      .filter((call) => !call.args.includes("--version"))
      .map((call) => call.args),
  ).toEqual([
    ["--json", "session", "list"],
    ["session", "list"],
    ["--json", "daemon", "status"],
  ]);
});

test("a failed close does not prevent other tools' cleanup and a retry can finish", async () => {
  const f = cleanupFixture();
  f.state(BROWSER, { sessions: { thread: [] }, failClose: true });
  f.state(DESKTOP, { sessions: { thread: [] } });
  f.state(DEVICE, { running: true, sessions: { thread: [] } });
  const manager = f.manager();
  await expect(manager.closeThread("thread")).rejects.toBeInstanceOf(AggregateError);
  expect(f.read(DESKTOP).sessions).toEqual({ thread: [] });
  expect(f.read(DEVICE).sessions).toEqual({});
  f.state(BROWSER, { sessions: { thread: [] } });
  await manager.closeThread("thread");
  expect(f.read(BROWSER).sessions).toEqual({});
});

test("cleanup rejects unsupported CLI versions without issuing their session commands", async () => {
  const f = cleanupFixture();
  f.state(BROWSER, { sessions: { thread: [] }, version: "0.1.0" });
  f.state(DESKTOP, { sessions: { thread: [] } });
  await expect(f.manager().closeThread("thread")).rejects.toBeInstanceOf(AggregateError);
  expect(
    f
      .calls()
      .filter((call) => call.tool === "agent-browser")
      .map((call) => call.args),
  ).toEqual([["--version"]]);
  expect(f.read(BROWSER).sessions).toEqual({ thread: [] });
  expect(f.read(DESKTOP).sessions).toEqual({ thread: [] });
});

test.each([true, false])(
  "desktop archive preserves history and allows new snapshots after reopen (manifest: %s)",
  async (manifest) => {
    const f = cleanupFixture();
    const manager = f.manager();
    const history = ["previous trace segment", "previous snapshot"];
    f.state(DESKTOP, { sessions: manifest ? { thread: [] } : {}, history });
    const request = create(RunAgentToolSchema, { tool: DESKTOP, operation: "snapshot", session: "thread" });

    await manager.run(request);
    await manager.closeThread("thread");
    expect(f.read(DESKTOP)).toMatchObject({ snapshots: 1, history });
    await expect(manager.run(request)).rejects.toThrow("closed");
    const callsBeforeReopen = f.calls().length;
    await manager.threadOpened("thread");
    expect(f.calls()).toHaveLength(callsBeforeReopen);
    await manager.run(request);
    expect(f.read(DESKTOP)).toMatchObject({ snapshots: 2, history });
    expect(f.read(DESKTOP).desktopEnded).toBeUndefined();
    expect(f.calls().some((call) => call.args.includes("end"))).toBe(false);
  },
);

test("close fences MCP, operations and previews immediately; reopening waits for cleanup", async () => {
  const f = cleanupFixture();
  const gate = join(f.dir, "release-close");
  f.state(BROWSER, { sessions: { thread: [] }, waitClose: gate });
  const manager = f.manager();
  const closing = manager.closeThread("thread");
  expect(manager.closeThread("thread")).toBe(closing);
  const scope = create(RunAgentToolSchema, { tool: BROWSER, operation: "snapshot", session: "thread" });
  await expect(manager.run(scope)).rejects.toThrow("closed");
  await expect(manager.resolvePreviewScope(scope)).rejects.toThrow("closed");
  expect(manager.localMcpServers([BROWSER], "thread")).toEqual([]);
  let reopened = false;

  const opening = manager.threadOpened("thread").then(() => {
    reopened = true;
  });

  try {
    await waitFor(() => f.calls().some((call) => call.args.includes("close")));
    expect(reopened).toBe(false);
    writeFileSync(gate, "");
    await Promise.all([closing, opening]);
    expect(reopened).toBe(true);
  } finally {
    writeFileSync(gate, "");
    await Promise.allSettled([closing, opening]);
  }
});

test("archive drains discovery and prevents a pending operation from starting a native session", async () => {
  const f = fixture();
  f.state(BROWSER, { delay: 75 });

  const manager = new AgentTools({
    dataDir: f.dir,
    env: f.env,
    probe: { which: f.which },
    send: () => {},
    progress: () => {},
  });

  const scope = create(RunAgentToolSchema, {
    tool: BROWSER,
    operation: "open",
    target: "https://example.test",
    session: "thread",
  });

  const outcome = manager.run(scope).catch((error: Error) => error);
  await waitFor(() => f.calls().some((call) => call.args.includes("--version")));
  // The generic fixture has no cleanup grammar; even that failure must leave the pending open fenced.
  const closing = manager.closeThread("thread").catch(() => undefined);
  expect(await outcome).toBeInstanceOf(Error);
  await closing;
  expect(f.calls().some((call) => call.args.includes("open"))).toBe(false);
});

test("a delayed reopen cannot remove a newer archive fence or start native automation", async () => {
  const f = cleanupFixture();
  const manager = f.manager();
  const scope = create(RunAgentToolSchema, { tool: DESKTOP, operation: "snapshot", session: "thread" });
  const opening = manager.threadOpened("thread");
  manager.fenceThread("thread");
  await opening;
  await expect(manager.run(scope)).rejects.toThrow("closed");
  expect(f.calls()).toEqual([]);
  await manager.closeThread("thread");
  await manager.threadOpened("thread");
  await manager.run(scope);
  expect(f.read(DESKTOP).snapshots).toBe(1);
});

test("an operation queued behind another session cannot start its native command after archive", async () => {
  const f = cleanupFixture();
  const manager = f.manager();
  const scope = create(RunAgentToolSchema, { tool: DESKTOP, operation: "snapshot", session: "thread" });
  await manager.run(scope);
  const gate = Promise.withResolvers<void>();
  const queued = serializeAgentTool("operations", () => gate.promise);
  const pending = manager.run(scope).catch((error: Error) => error);

  try {
    // Discovery is cached; advance microtasks until runAgentToolOperation has joined the operations lane.
    await Bun.sleep(10);
    manager.fenceThread("thread");
    gate.resolve();
    await queued;
    expect(await pending).toBeInstanceOf(Error);
    expect(f.read(DESKTOP).snapshots).toBe(1);
    await manager.closeThread("thread");
  } finally {
    gate.resolve();
    await queued;
    await pending;
  }
});
