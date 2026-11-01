import { describe, expect, test } from "bun:test";
import { AsyncChannel } from "@open-agents/transport";
import { JsonRpcPeer, RpcClosedError, RpcError, readLines, type RpcHandlers } from "./rpc.ts";

/** In-memory server side: lines the client wrote, and a channel to push server lines. */
function fakeServer(handlers: Partial<RpcHandlers> = {}) {
  const written: unknown[] = [];
  const incoming = new AsyncChannel<string>();
  const notifications: [string, unknown][] = [];
  const peer = new JsonRpcPeer(
    { write: (line) => written.push(JSON.parse(line)), lines: incoming },
    {
      onNotification: (method, params) => notifications.push([method, params]),
      onRequest: handlers.onRequest ?? (async () => ({})),
    },
  );
  const running = peer.run();
  const push = (message: unknown) => incoming.push(JSON.stringify(message));
  const pushRaw = (line: string) => incoming.push(line);
  return { peer, written, push, pushRaw, notifications, close: () => incoming.close(), running };
}

describe("JsonRpcPeer", () => {
  test("correlates responses by id, also out of order", async () => {
    const server = fakeServer();
    const a = server.peer.request("thread/start", { cwd: "/a" });
    const b = server.peer.request("thread/start", { cwd: "/b" });
    expect(server.written).toEqual([
      { id: 1, method: "thread/start", params: { cwd: "/a" } },
      { id: 2, method: "thread/start", params: { cwd: "/b" } },
    ]);
    server.push({ id: 2, result: { thread: { id: "B" } } });
    server.push({ id: 1, result: { thread: { id: "A" } } });
    expect(await a).toEqual({ thread: { id: "A" } });
    expect(await b).toEqual({ thread: { id: "B" } });
  });

  test("error responses reject with RpcError carrying the method", async () => {
    const server = fakeServer();
    const pending = server.peer.request("thread/goal/set", {});
    server.push({ id: 1, error: { code: -32600, message: "no goal" } });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).method).toBe("thread/goal/set");
    expect((error as RpcError).code).toBe(-32600);
  });

  test("notifications go to the handler; garbage lines are ignored", async () => {
    const server = fakeServer();
    server.push({ method: "turn/started", params: { turnId: "t1" } });
    server.peer.notify("initialized");
    server.pushRaw("not json");
    await Bun.sleep(1);
    expect(server.notifications).toEqual([["turn/started", { turnId: "t1" }]]);
    expect(server.written).toEqual([{ method: "initialized" }]);
  });

  test("server requests are answered with the handler result or an error", async () => {
    const server = fakeServer({
      onRequest: async (method) => {
        if (method === "item/commandExecution/requestApproval") return { decision: "decline" };
        throw new RpcError(method, -32601, "unsupported");
      },
    });
    server.push({ id: 7, method: "item/commandExecution/requestApproval", params: {} });
    server.push({ id: "x", method: "item/tool/requestUserInput", params: {} });
    await Bun.sleep(1);
    expect(server.written).toEqual([
      { id: 7, result: { decision: "decline" } },
      { id: "x", error: { code: -32601, message: "item/tool/requestUserInput: unsupported (-32601)" } },
    ]);
  });

  test("closing the transport fails pending and future requests", async () => {
    const server = fakeServer();
    const pending = server.peer.request("turn/start", {});
    server.close();
    await server.running;
    expect(await pending.catch((e: unknown) => e)).toBeInstanceOf(RpcClosedError);
    expect(await server.peer.request("x", {}).catch((e: unknown) => e)).toBeInstanceOf(RpcClosedError);
  });
});

describe("readLines", () => {
  test("splits across chunk boundaries and multi-byte characters", async () => {
    const bytes = new TextEncoder().encode('{"a":"zażółć"}\n{"b":1}\n{"c"');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    const lines: string[] = [];
    for await (const line of readLines(stream)) lines.push(line);
    expect(lines).toEqual(['{"a":"zażółć"}', '{"b":1}', '{"c"']);
  });
});
