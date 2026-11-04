/**
 * Wire compatibility of Bun's node:http2 with an independent gRPC stack:
 * @grpc/grpc-js on real Node.js, in both directions, over h2c and TLS.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JsonObject } from "@canopy/domain";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ItemDeltaField } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { connectWorker, makeSelfSignedCert, startGateway, take, type TestCert } from "./helpers.ts";

const tempDir = tempDirs();

const EVENTS = 100;

let workDir: string;
let peerScript: string;
let cert: TestCert;
let certFile: string;
let keyFile: string;

beforeAll(async () => {
  workDir = tempDir("canopy-interop-");

  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/node-peer.ts")],
    target: "node",
    format: "esm",
    outdir: workDir,
    naming: "node-peer.mjs",
  });

  if (!build.success) throw new AggregateError(build.logs, "bundling node-peer failed");
  peerScript = join(workDir, "node-peer.mjs");

  cert = makeSelfSignedCert();
  certFile = join(workDir, "cert.pem");
  keyFile = join(workDir, "key.pem");
  writeFileSync(certFile, cert.cert);
  writeFileSync(keyFile, cert.key);
});

afterAll(() => {
  cert.cleanup();
});

type PeerLine = { step: string } & JsonObject;

/** Spawns the Node peer and exposes its JSON-lines stdout. */
function spawnPeer(args: string[]) {
  const proc = Bun.spawn(["node", peerScript, ...args], { stdout: "pipe", stderr: "pipe" });
  const lines: PeerLine[] = [];
  const waiters: Array<{ step: string; resolve: (line: PeerLine) => void }> = [];

  const reading = (async () => {
    let rest = "";

    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      rest += chunk;
      let newline: number;

      while ((newline = rest.indexOf("\n")) >= 0) {
        const line = JSON.parse(rest.slice(0, newline)) as PeerLine;
        rest = rest.slice(newline + 1);
        lines.push(line);

        for (const waiter of waiters.filter((w) => w.step === line.step)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    }
  })();

  return {
    proc,
    lines,
    waitFor: (step: string): Promise<PeerLine> => {
      const seen = lines.find((l) => l.step === step);

      return seen ? Promise.resolve(seen) : new Promise((resolve) => waiters.push({ step, resolve }));
    },
    finished: async () => {
      const exitCode = await proc.exited;
      await reading;

      return { exitCode, stderr: await new Response(proc.stderr).text() };
    },
  };
}

describe.each([
  { name: "h2c", tls: false },
  { name: "TLS", tls: true },
])("grpc-js (Node) worker -> Bun gateway over $name", ({ tls }) => {
  test("handshake, command, 100 events, acks, clean end", async () => {
    const gateway = await startGateway(tls ? { tls: cert } : {});
    const peer = spawnPeer(["client", gateway.server.url, ...(tls ? [certFile] : [])]);

    const connection = await gateway.nextConnection();
    expect(connection.hello.host?.hostname).toBe("node-peer");

    const result = await connection.sendCommand({
      case: "createThread",
      value: { thread: { threadId: "t-1", cwd: "/tmp" } },
    });

    expect(result.ok).toBe(true);

    const events = await take(connection.messages, EVENTS);
    expect(events.map((m) => m.payload.case === "threadEvent" && Number(m.payload.value.journalSeq))).toEqual(
      Array.from({ length: EVENTS }, (_, i) => i + 1),
    );
    connection.send({ case: "eventAck", value: { threadId: "t-1", ackSeq: BigInt(EVENTS) } });

    const { exitCode, stderr } = await peer.finished();
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(peer.lines.map((l) => l.step)).toEqual(["welcome", "command", "ack", "status"]);
    expect(peer.lines.at(-1)).toMatchObject({ step: "status", code: 0 });

    await connection.closed;
    await gateway.server.close();
  });
});

describe.each([
  { name: "h2c", tls: false },
  { name: "TLS", tls: true },
])("Bun worker -> grpc-js (Node) gateway over $name", ({ tls }) => {
  test("handshake, command, 100 events, ack, worker half-close", async () => {
    const peer = spawnPeer(["server", ...(tls ? [certFile, keyFile] : [])]);

    try {
      const { port } = await peer.waitFor("listening");
      const baseUrl = `${tls ? "https" : "http"}://127.0.0.1:${String(port)}`;
      const link = await connectWorker(baseUrl, tls ? { ca: cert.cert } : {});
      expect(link.welcome.heartbeatIntervalSeconds).toBe(7);

      const [command] = await take(link.messages, 1);

      if (command?.payload.case !== "command") throw new Error(`expected command, got ${command?.payload.case}`);
      expect(command.payload.value.kind.case).toBe("createThread");
      link.send({ case: "commandResult", value: { commandId: command.payload.value.commandId, ok: true } });

      for (let seq = 1; seq <= EVENTS; seq++) {
        link.send({
          case: "threadEvent",
          value: {
            threadId: "t-1",
            journalSeq: BigInt(seq),
            eventId: `e-${seq}`,
            body: { case: "itemDelta", value: { itemId: "m1", field: ItemDeltaField.TEXT, chunk: "x" } },
          },
        });
      }

      const [ack] = await take(link.messages, 1);
      expect(ack?.payload.case === "eventAck" && ack.payload.value.ackSeq).toBe(BigInt(EVENTS));

      // Worker half-closes (e.g. draining); the Node gateway answers by ending the call with OK.
      link.close();
      expect(await link.closed).toEqual({});
      expect(peer.lines.map((l) => l.step)).toEqual(["listening", "hello", "commandResult", "events", "clientEnd"]);
      expect(peer.lines[1]).toMatchObject({ workerId: "worker-1", hostname: "test-host" });
    } finally {
      peer.proc.kill();
      await peer.finished();
    }
  });
});
