import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Provider } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { journalHello, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import type { WorkerConnection } from "@canopy/gateway/worker-link";
import { connectWorker, startGateway } from "./helpers.ts";

const root = tempDir("canopy-worker-storage-cleanup-");
const dataDir = join(root, "data");
const threadId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";
let gateway: Awaited<ReturnType<typeof startGateway>>;
let connection: WorkerConnection;
let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
let host: WorkerHost;
let link: GatewayLink;

beforeAll(async () => {
  gateway = await startGateway();
  runtime = ManagedRuntime.make(Journal.layer(join(root, "journal.db")));
  host = new WorkerHost({ runtime, dataDir, clientVersion: "test" });
  link = await connectWorker(gateway.server.url, {
    hello: {
      workerId: "worker-1",
      attachmentsRoot: host.attachmentsRoot,
      capabilities: ["thread_storage_cleanup_v1"],
      ...(await runtime.runPromise(journalHello())),
    },
  });
  void serveLink(link, host, runtime);
  connection = await gateway.nextConnection();
  connection.send({ case: "config", value: { version: 1n, claude: { enabled: false }, codex: { enabled: false } } });
  const messages = connection.messages[Symbol.asyncIterator]();

  for (;;) {
    const next = await messages.next();

    if (next.done) throw new Error("worker link closed before config");

    if (next.value.payload.case === "configApplied") break;
  }
});

afterAll(async () => {
  await host.close();
  await runtime.dispose();
  await gateway.link.shutdown();
  await gateway.server.close();
});

test("authoritative cleanup travels over WorkerLink and removes only its managed scope", async () => {
  const sessionDir = join(dataDir, "codex-home", "sessions", "2026", "11", "16");
  const attachment = join(dataDir, "attachments", threadId, "a", "file.txt");
  const global = join(root, "global", `${sessionId}.jsonl`);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(attachment, ".."), { recursive: true });
  mkdirSync(join(global, ".."), { recursive: true });
  writeFileSync(
    join(sessionDir, `rollout-2026-11-16T00-00-00-${sessionId}.jsonl`),
    `{"type":"session_meta","payload":{"id":"${sessionId}"}}\n`,
  );
  writeFileSync(attachment, "attachment");
  writeFileSync(global, "global");

  const requestId = "66666666-6666-4666-8666-666666666666";
  connection.send({
    case: "threadStorageCleanup",
    value: {
      requestId,
      scopes: [{ threadId, provider: Provider.CODEX, providerProfileId: "native", providerThreadIds: [sessionId] }],
    },
  });

  const messages = connection.messages[Symbol.asyncIterator]();

  for (;;) {
    const next = await messages.next();

    if (next.done) throw new Error("worker link closed before cleanup reply");

    if (next.value.payload.case === "threadStorageCleanup") {
      expect(next.value.payload.value).toMatchObject({ requestId, completedThreadIds: [threadId] });
      break;
    }
  }

  expect(existsSync(join(dataDir, "attachments", threadId))).toBe(false);
  expect(existsSync(join(sessionDir, `rollout-2026-11-16T00-00-00-${sessionId}.jsonl`))).toBe(false);
  expect(existsSync(global)).toBe(true);
});

test("admission reservation keeps a cleanup tick away from files until the command settles", async () => {
  const id = "77777777-7777-4777-8777-777777777777";
  const session = "88888888-8888-4888-8888-888888888888";
  const sessionDir = join(dataDir, "codex-home", "sessions", "2026", "11", "17");
  const attachment = join(dataDir, "attachments", id, "a", "file.txt");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(attachment, ".."), { recursive: true });
  writeFileSync(
    join(sessionDir, `rollout-2026-11-17T00-00-00-${session}.jsonl`),
    `{"type":"session_meta","payload":{"id":"${session}"}}\n`,
  );
  writeFileSync(attachment, "attachment");

  const release = Promise.withResolvers<void>();
  const admitted = host.storage.use(() => release.promise);
  await Bun.sleep(10);
  connection.send({
    case: "threadStorageCleanup",
    value: {
      requestId: "99999999-9999-4999-8999-999999999999",
      scopes: [{ threadId: id, provider: Provider.CODEX, providerProfileId: "native", providerThreadIds: [session] }],
    },
  });
  await Bun.sleep(20);
  expect(existsSync(attachment)).toBe(true);

  release.resolve();
  await admitted;
  host.storage.tick();
  await host.storage.settled();
  expect(existsSync(join(dataDir, "attachments", id))).toBe(false);
});
