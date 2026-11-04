import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { InteractionKind, ItemDeltaField, ItemStatus, Provider, ProviderProfileKind } from "@canopy/contracts";
import type { GatewayLink } from "@canopy/worker/gateway-link";
import { connectWorker, makeSelfSignedCert, startGateway, take, type TestCert } from "./helpers.ts";

async function expectConnectError(promise: Promise<unknown>, code: Code): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(ConnectError);
  expect((error as ConnectError).code).toBe(code);
}

/** Minimal worker loop: answers every command with ok=true. */
function autoAckCommands(link: GatewayLink): void {
  void (async () => {
    for await (const message of link.messages) {
      if (message.payload.case === "command") {
        link.send({ case: "commandResult", value: { commandId: message.payload.value.commandId, ok: true } });
      }
    }
  })().catch(() => {
    // Stream errors are asserted via link.closed in the tests that care.
  });
}

describe("WorkerLink over h2c (cleartext HTTP/2)", () => {
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  beforeAll(async () => {
    gateway = await startGateway();
  });
  afterAll(async () => {
    await gateway.link.shutdown();
    await gateway.server.close();
  });

  test("Hello -> Welcome handshake registers the worker", async () => {
    const link = await connectWorker(gateway.server.url);
    const connection = await gateway.nextConnection();

    expect(link.welcome.heartbeatIntervalSeconds).toBe(15);
    expect(connection.workerId).toBe("worker-1");
    expect(connection.hello.host?.hostname).toBe("test-host");
    expect(connection.hello.providers[0]?.provider).toBe(Provider.CLAUDE);
    expect(connection.hello.configVersion).toBe(0n);
    expect(gateway.link.connections.get("worker-1")).toBe(connection);

    link.close();
    await connection.closed;
    expect(gateway.link.connections.has("worker-1")).toBe(false);
  });

  test("rejects missing, unknown and mismatched credentials", async () => {
    await expectConnectError(connectWorker(gateway.server.url, { credential: "" }), Code.Unauthenticated);
    await expectConnectError(connectWorker(gateway.server.url, { credential: "nope" }), Code.Unauthenticated);
    // Valid credential of worker-2, but Hello claims worker-1.
    await expectConnectError(
      connectWorker(gateway.server.url, { credential: "secret-worker-2" }),
      Code.PermissionDenied,
    );
    expect(gateway.link.connections.size).toBe(0);
  });

  test("credential invalidation also rejects a handshake already authenticated but waiting for config", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const isolated = await startGateway({
      link: {
        welcome: async () => {
          entered.resolve();
          await release.promise;

          return { heartbeatIntervalSeconds: 15 };
        },
      },
    });

    try {
      const pending = connectWorker(isolated.server.url);
      await entered.promise;
      isolated.link.disconnect("worker-1");
      release.resolve();
      await expectConnectError(pending, Code.Unauthenticated);
      expect(isolated.link.connections.size).toBe(0);
    } finally {
      release.resolve();
      await isolated.link.shutdown();
      await isolated.server.close();
    }
  });

  test("gateway pushes a command to an idle worker and gets the correlated result", async () => {
    const link = await connectWorker(gateway.server.url);
    const connection = await gateway.nextConnection();
    autoAckCommands(link);

    // The worker has not sent anything since Hello: this is a pure server-initiated push.
    await Bun.sleep(50);

    const result = await connection.sendCommand({
      case: "startTurn",
      value: {
        thread: { threadId: "t-1", provider: Provider.CODEX, cwd: "/tmp" },
        turnId: "turn-1",
        input: { text: "hi" },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.commandId).not.toBe("");

    link.close();
    await connection.closed;
  });

  test("sendCommand times out when the worker does not answer", async () => {
    const link = await connectWorker(gateway.server.url);
    const connection = await gateway.nextConnection();
    await expectConnectError(
      connection.sendCommand({ case: "unloadThread", value: { threadId: "t-1" } }, 100),
      Code.DeadlineExceeded,
    );
    link.close();
    await connection.closed;
  });

  test("streams 5000 transcript events in order with batched acks", async () => {
    const link = await connectWorker(gateway.server.url);
    const connection = await gateway.nextConnection();
    const total = 5000;

    const persisted = (async () => {
      let lastSeq = 0n;
      const seen: bigint[] = [];

      for await (const message of connection.messages) {
        if (message.payload.case !== "threadEvent") continue;
        seen.push(message.payload.value.journalSeq);
        lastSeq = message.payload.value.journalSeq;

        if (seen.length % 100 === 0 || seen.length === total) {
          connection.send({ case: "eventAck", value: { threadId: "t-1", ackSeq: lastSeq } });
        }

        if (seen.length === total) break;
      }

      return seen;
    })();

    const started = performance.now();

    for (let seq = 1; seq <= total; seq++) {
      link.send({
        case: "threadEvent",
        value: {
          threadId: "t-1",
          journalSeq: BigInt(seq),
          eventId: `e-${seq}`,
          body: { case: "itemDelta", value: { itemId: "m1", field: ItemDeltaField.TEXT, chunk: `token ${seq} ` } },
          rawJson: '{"type":"stream_event"}',
        },
      });
    }

    const acks = await take(link.messages, total / 100);
    const seen = await persisted;
    const elapsedMs = performance.now() - started;
    console.log(`  ${total} events + ${acks.length} acks in ${elapsedMs.toFixed(0)} ms`);

    expect(seen).toEqual(Array.from({ length: total }, (_, i) => BigInt(i + 1)));
    const last = acks.at(-1);
    expect(last?.payload.case === "eventAck" && last.payload.value.ackSeq).toBe(BigInt(total));

    link.close();
    await connection.closed;
  });

  test("carries a 4 MiB command output in a single item event", async () => {
    const link = await connectWorker(gateway.server.url);
    const connection = await gateway.nextConnection();
    const output = "x".repeat(4 * 1024 * 1024);

    link.send({
      case: "threadEvent",
      value: {
        threadId: "t-1",
        journalSeq: 1n,
        eventId: "e-1",
        body: {
          case: "itemCompleted",
          value: {
            item: {
              itemId: "c1",
              status: ItemStatus.COMPLETED,
              content: { case: "commandExecution", value: { output } },
            },
          },
        },
      },
    });
    const [message] = await take(connection.messages, 1);
    const body = message?.payload.case === "threadEvent" ? message.payload.value.body : undefined;
    const content = body?.case === "itemCompleted" ? body.value.item?.content : undefined;
    expect(content?.case === "commandExecution" && content.value.output.length).toBe(output.length);

    link.close();
    await connection.closed;
  });

  test("interaction round trips: permission from a turn, question from a background task after the turn", async () => {
    const link = await connectWorker(gateway.server.url);
    const connection = await gateway.nextConnection();

    void (async () => {
      for await (const message of connection.messages) {
        if (message.payload.case !== "interactionRequest") continue;
        const request = message.payload.value;
        connection.send({
          case: "interactionResponse",
          value:
            request.kind === InteractionKind.PERMISSION
              ? { requestId: request.requestId, allow: false, message: "not in tests" }
              : { requestId: request.requestId, answerJson: '{"choice":"staging"}' },
        });
      }
    })().catch(() => {});

    link.send({
      case: "interactionRequest",
      value: {
        requestId: "p-1",
        threadId: "t-1",
        turnId: "turn-1",
        itemId: "tool-1",
        kind: InteractionKind.PERMISSION,
        toolName: "Bash",
        requestJson: '{"command":"rm -rf /"}',
      },
    });
    // No turn: a background subagent asks after its turn has finished.
    link.send({
      case: "interactionRequest",
      value: {
        requestId: "q-1",
        threadId: "t-1",
        itemId: "bg-agent",
        kind: InteractionKind.QUESTION,
        requestJson: '{"question":"Deploy where?","options":["staging","prod"]}',
      },
    });

    const responses = await take(link.messages, 2);
    const values = responses.map((m) => (m.payload.case === "interactionResponse" ? m.payload.value : undefined));
    expect(values[0]).toMatchObject({ requestId: "p-1", allow: false });
    expect(values[1]).toMatchObject({ requestId: "q-1", answerJson: '{"choice":"staging"}' });

    link.close();
    await connection.closed;
  });

  test("reconnect of the same worker replaces the previous connection", async () => {
    const first = await connectWorker(gateway.server.url);
    const firstConnection = await gateway.nextConnection();
    const second = await connectWorker(gateway.server.url);
    const secondConnection = await gateway.nextConnection();

    await firstConnection.closed;
    expect(await first.closed).toEqual({});
    expect(gateway.link.connections.get("worker-1")).toBe(secondConnection);

    second.close();
    await secondConnection.closed;
  });

  test("worker abort (e.g. SIGTERM) closes the gateway side", async () => {
    const controller = new AbortController();
    const link = await connectWorker(gateway.server.url, { signal: controller.signal });
    const connection = await gateway.nextConnection();
    controller.abort();
    await connection.closed;
    expect((await link.closed).error?.code).toBe(Code.Canceled);
    expect(connection.isOpen).toBe(false);
  });

  test("gateway close ends the worker stream and rejects pending commands", async () => {
    const link = await connectWorker(gateway.server.url);
    const connection = await gateway.nextConnection();
    const pending = connection.sendCommand({ case: "unloadThread", value: { threadId: "t-1" } }, 5_000);
    connection.close();
    await expectConnectError(pending, Code.Unavailable);
    expect(await link.closed).toEqual({});
    expect(() => link.send({ case: "heartbeat", value: {} })).toThrow(ConnectError);
  });

  test("handles 20 concurrent workers on separate connections", async () => {
    const many = await startGateway({
      link: {
        authenticate: async (credential) => credential.replace("secret-", ""),
      },
    });

    const links = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        connectWorker(many.server.url, {
          credential: `secret-w${i}`,
          hello: { workerId: `w${i}` },
        }),
      ),
    );

    const connections = await Promise.all(links.map(() => many.nextConnection()));

    for (const link of links) autoAckCommands(link);

    const results = await Promise.all(
      connections.map((c) =>
        c.sendCommand({ case: "interruptTurn", value: { threadId: c.workerId, turnId: "turn-1" } }),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(many.link.connections.size).toBe(20);

    for (const link of links) link.close();
    await Promise.all(connections.map((c) => c.closed));
    expect((await Promise.all(links.map((l) => l.closed))).every((c) => c.error === undefined)).toBe(true);
    await many.server.close();
  });

  test("graceful gateway shutdown: Drain, clean end of every worker stream, then server close", async () => {
    const local = await startGateway();

    const links = [
      await connectWorker(local.server.url),
      await connectWorker(local.server.url, {
        credential: "secret-worker-2",
        hello: { workerId: "worker-2" },
      }),
    ];

    await local.nextConnection();
    await local.nextConnection();

    await local.link.shutdown({ reason: "rolling update", reconnectAfterMs: 500, jitterMs: 1_000 });
    await local.server.close();
    expect(await Promise.all(links.map((l) => l.closed))).toEqual([{}, {}]);

    // Each worker got a Drain with a jittered reconnect delay before the clean end.
    for (const link of links) {
      const [drain] = await take(link.messages, 1);

      if (drain?.payload.case !== "drain") throw new Error(`expected drain, got ${drain?.payload.case}`);
      expect(drain.payload.value.reason).toBe("rolling update");
      expect(drain.payload.value.reconnectAfterMs).toBeGreaterThanOrEqual(500);
      expect(drain.payload.value.reconnectAfterMs).toBeLessThan(1_500);
    }
  });

  test("hard gateway shutdown: streams still open after the grace period fail on the worker", async () => {
    const local = await startGateway();
    const link = await connectWorker(local.server.url);
    const connection = await local.nextConnection();
    await local.server.close(50);
    await connection.closed;
    const { error } = await link.closed;
    expect(error).toBeInstanceOf(ConnectError);
  });
});

describe("remote worker configuration", () => {
  const configV = (version: bigint) => ({
    version,
    allowedRoots: ["/srv/repos"],
    claude: { enabled: true },
    codex: { enabled: false },
    profiles: [
      { id: "proxy", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317", apiKey: "sk-test" },
    ],
  });

  test("sent right after Welcome; the worker reports how it was applied", async () => {
    const gateway = await startGateway({ link: { config: async () => configV(3n) } });
    const link = await connectWorker(gateway.server.url);
    const connection = await gateway.nextConnection();

    const [first] = await take(link.messages, 1);

    if (first?.payload.case !== "config") throw new Error(`expected config, got ${first?.payload.case}`);
    expect(first.payload.value.version).toBe(3n);
    expect(first.payload.value.profiles[0]?.apiKey).toBe("sk-test");

    link.send({
      case: "configApplied",
      value: { version: 3n, applied: true, issues: [{ path: "allowed_roots[0]", message: "missing" }] },
    });
    const [applied] = await take(connection.messages, 1);
    expect(applied?.payload.case === "configApplied" && applied.payload.value).toMatchObject({
      version: 3n,
      applied: true,
    });

    link.close();
    await connection.closed;
    await gateway.link.shutdown();
    await gateway.server.close();
  });

  test("not resent when the worker already holds that version (reconnect within the same process)", async () => {
    const gateway = await startGateway({ link: { config: async () => configV(3n) } });

    const link = await connectWorker(gateway.server.url, {
      hello: { workerId: "worker-1", configVersion: 3n },
    });

    const connection = await gateway.nextConnection();
    // Push a heartbeat-sized marker from the gateway: if a config had been queued it would arrive first.
    connection.send({ case: "eventAck", value: { threadId: "marker", ackSeq: 1n } });
    const [next] = await take(link.messages, 1);
    expect(next?.payload.case).toBe("eventAck");

    link.close();
    await connection.closed;
    await gateway.link.shutdown();
    await gateway.server.close();
  });

  test("pushConfig delivers changes live; offline workers get them on connect", async () => {
    let current = configV(1n);
    const gateway = await startGateway({ link: { config: async () => current } });
    expect(gateway.link.pushConfig("worker-1", configV(2n))).toBe(false);

    const link = await connectWorker(gateway.server.url);
    const connection = await gateway.nextConnection();
    const [initial] = await take(link.messages, 1);
    expect(initial?.payload.case === "config" && initial.payload.value.version).toBe(1n);

    current = configV(2n);
    expect(gateway.link.pushConfig("worker-1", current)).toBe(true);
    const [update] = await take(link.messages, 1);
    expect(update?.payload.case === "config" && update.payload.value.version).toBe(2n);

    link.close();
    await connection.closed;
    await gateway.link.shutdown();
    await gateway.server.close();
  });
});

describe("WorkerLink over TLS (HTTP/2 + ALPN h2)", () => {
  let cert: TestCert;
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  beforeAll(async () => {
    cert = makeSelfSignedCert();
    gateway = await startGateway({ tls: cert });
  });
  afterAll(async () => {
    await gateway.link.shutdown();
    await gateway.server.close();
    cert.cleanup();
  });

  test("handshake and command round trip with a trusted self-signed CA", async () => {
    expect(gateway.server.url.startsWith("https://")).toBe(true);
    const link = await connectWorker(gateway.server.url, { ca: cert.cert });
    const connection = await gateway.nextConnection();
    autoAckCommands(link);

    const result = await connection.sendCommand({ case: "listDirectory", value: { path: "/tmp" } });
    expect(result.ok).toBe(true);

    link.close();
    await connection.closed;
  });

  test("refuses an untrusted certificate", async () => {
    // connect-node maps TLS verification failures to Code.Internal (same on Node); the cause carries the reason.
    const error = await connectWorker(gateway.server.url).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).cause).toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  });

  test("HTTP/2 PING keepalive keeps an idle stream open", async () => {
    const link = await connectWorker(gateway.server.url, { ca: cert.cert, pingIntervalMs: 50 });
    const connection = await gateway.nextConnection();
    await Bun.sleep(400);
    expect(connection.isOpen).toBe(true);

    connection.send({ case: "eventAck", value: { threadId: "t-1", ackSeq: 1n } });
    const [message] = await take(link.messages, 1);
    expect(message?.payload.case).toBe("eventAck");

    link.close();
    await connection.closed;
  });
});
