/**
 * Independent gRPC peer for interop tests: @grpc/grpc-js running on real Node.js.
 * Bundled with Bun.build({ target: "node" }) and executed with `node`.
 *
 *   node node-peer.mjs client <baseUrl> [caFile]   -> acts as a worker against a Bun gateway
 *   node node-peer.mjs server [certFile keyFile]   -> acts as a gateway for a Bun worker
 *
 * Prints one JSON object per line: {"step": ...}. Exits non-zero on failure.
 */
import { readFileSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
// Type-only: the apps' envelope helpers use Bun APIs, the peer must stay pure Node.
import type { GatewayPayloadInit } from "@canopy/gateway/worker-link";
import type { WorkerPayloadInit } from "@canopy/worker/gateway-link";
import {
  GatewayMessageSchema,
  Provider,
  WorkerMessageSchema,
  type GatewayMessage,
  type WorkerMessage,
} from "@canopy/contracts";

const CONNECT_PATH = "/openagents.worker.v1.WorkerLinkService/Connect";
const EVENTS = 100;

const definition = {
  connect: {
    path: CONNECT_PATH,
    requestStream: true,
    responseStream: true,
    requestSerialize: (m: WorkerMessage) => Buffer.from(toBinary(WorkerMessageSchema, m)),
    requestDeserialize: (b: Buffer) => fromBinary(WorkerMessageSchema, b),
    responseSerialize: (m: GatewayMessage) => Buffer.from(toBinary(GatewayMessageSchema, m)),
    responseDeserialize: (b: Buffer) => fromBinary(GatewayMessageSchema, b),
    originalName: "connect",
  },
} satisfies grpc.ServiceDefinition;

const log = (step: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(`${JSON.stringify({ step, ...extra })}\n`);

function fail(error: unknown): never {
  log("error", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

function runClient(baseUrl: string, caFile: string | undefined): void {
  const url = new URL(baseUrl);
  const credentials = caFile
    ? grpc.credentials.createSsl(readFileSync(caFile))
    : grpc.credentials.createInsecure();
  const Client = grpc.makeGenericClientConstructor(definition, "WorkerLinkService");
  // Node refuses an IP address as TLS servername; the test certificate also covers DNS:localhost.
  const channelOptions = caFile ? { "grpc.ssl_target_name_override": "localhost" } : {};
  const client = new Client(url.host, credentials, channelOptions) as unknown as grpc.Client & {
    connect(metadata: grpc.Metadata): grpc.ClientDuplexStream<WorkerMessage, GatewayMessage>;
  };
  const metadata = new grpc.Metadata();
  metadata.set("authorization", "Bearer secret-worker-1");
  const call = client.connect(metadata);
  const send = (payload: WorkerPayloadInit) =>
    call.write(create(WorkerMessageSchema, { messageId: crypto.randomUUID(), payload }));

  call.on("data", (message: GatewayMessage) => {
    switch (message.payload.case) {
      case "welcome":
        log("welcome", { heartbeat: message.payload.value.heartbeatIntervalSeconds });
        break;
      case "command":
        log("command", { kind: message.payload.value.kind.case });
        send({ case: "commandResult", value: { commandId: message.payload.value.commandId, ok: true } });
        for (let seq = 1; seq <= EVENTS; seq++) {
          send({
            case: "threadEvent",
            value: { threadId: "t-1", journalSeq: BigInt(seq), eventId: `e-${seq}` },
          });
        }
        break;
      case "eventAck":
        log("ack", { ackSeq: Number(message.payload.value.ackSeq) });
        if (message.payload.value.ackSeq === BigInt(EVENTS)) call.end();
        break;
      default:
        break;
    }
  });
  call.on("status", (status: grpc.StatusObject) => {
    log("status", { code: status.code, details: status.details });
    client.close();
    process.exit(status.code === grpc.status.OK ? 0 : 2);
  });
  call.on("error", () => {
    // Reported via the "status" event.
  });

  send({
    case: "hello",
    value: {
      workerId: "worker-1",
      workerLinkProtocol: 1,
      minWorkerLinkProtocol: 1,
      host: { hostname: "node-peer", os: process.platform, arch: process.arch, workerVersion: "node-interop" },
      providers: [{ provider: Provider.CLAUDE, available: true }],
    },
  });
}

function runServer(certFile: string | undefined, keyFile: string | undefined): void {
  const server = new grpc.Server();
  server.addService(definition, {
    connect: (call: grpc.ServerDuplexStream<WorkerMessage, GatewayMessage>) => {
      const auth = call.metadata.get("authorization")[0];
      if (auth !== "Bearer secret-worker-1") {
        call.emit("error", { code: grpc.status.UNAUTHENTICATED, details: "bad credential" });
        return;
      }
      const send = (payload: GatewayPayloadInit) =>
        call.write(create(GatewayMessageSchema, { messageId: crypto.randomUUID(), payload }));
      let events = 0;
      call.on("data", (message: WorkerMessage) => {
        switch (message.payload.case) {
          case "hello":
            log("hello", { workerId: message.payload.value.workerId, hostname: message.payload.value.host?.hostname });
            send({ case: "welcome", value: { heartbeatIntervalSeconds: 7 } });
            send({
              case: "command",
              value: {
                commandId: "cmd-1",
                kind: { case: "createThread", value: { thread: { threadId: "t-1", provider: Provider.CODEX, cwd: "/tmp" } } },
              },
            });
            break;
          case "commandResult":
            log("commandResult", { commandId: message.payload.value.commandId, ok: message.payload.value.ok });
            break;
          case "threadEvent":
            events++;
            if (events === EVENTS) {
              log("events", { count: events });
              send({ case: "eventAck", value: { threadId: "t-1", ackSeq: BigInt(events) } });
            }
            break;
          default:
            break;
        }
      });
      // Worker half-closed its request stream: finish the call with OK.
      call.on("end", () => {
        log("clientEnd");
        call.end();
      });
    },
  });
  const credentials =
    certFile && keyFile
      ? grpc.ServerCredentials.createSsl(null, [{ cert_chain: readFileSync(certFile), private_key: readFileSync(keyFile) }])
      : grpc.ServerCredentials.createInsecure();
  server.bindAsync("127.0.0.1:0", credentials, (error, port) => {
    if (error) fail(error);
    log("listening", { port });
  });
  process.on("SIGTERM", () => server.forceShutdown());
}


const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === "client" && args[0]) runClient(args[0], args[1]);
  else if (mode === "server") runServer(args[0], args[1]);
  else fail(`usage: node-peer client <baseUrl> [caFile] | server [certFile keyFile]`);
} catch (error) {
  fail(error);
}
