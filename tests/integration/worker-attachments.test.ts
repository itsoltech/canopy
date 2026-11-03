/**
 * A turn's attachments on a real WorkerHost over the gRPC link (docs/protocol.md, "Załączniki"): StartTurn names the
 * files, the worker fetches them (FetchBlob -> BlobChunk), checks them and writes them before the harness would get
 * the turn. No provider processes: the turn itself then fails as the provider is disabled.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionMode, Provider } from "@canopy/contracts";
import type { WorkerConnection } from "@canopy/gateway/worker-link";
import { tempDir } from "@canopy/testing";
import { journalHello } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { connectWorker, startGateway } from "./helpers.ts";

const dir = tempDir("canopy-host-attachments-");
const root = join(dir, "repos");
mkdirSync(join(root, "app"), { recursive: true });

let gateway: Awaited<ReturnType<typeof startGateway>>;
let connection: WorkerConnection;
let runtime: ManagedRuntime.ManagedRuntime<Journal, unknown>;
let host: WorkerHost;
/** What the fake gateway hands out, by sha256; the requests it saw. */
const blobs = new Map<string, Uint8Array>();
const requests: { threadId: string; sha256: string }[] = [];

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

beforeAll(async () => {
  gateway = await startGateway();
  runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
  host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "test" });
  const link = await connectWorker(gateway.server.url, { hello: { workerId: "worker-1", attachmentsRoot: host.attachmentsRoot, ...(await runtime.runPromise(journalHello())) } });
  void serveLink(link, host, runtime);
  connection = await gateway.nextConnection();
  connection.send({ case: "config", value: { version: 1n, allowedRoots: [root], claude: { enabled: false }, codex: { enabled: false } } });
  // The gateway's side of FetchBlob, in 1000-byte chunks.
  void (async () => {
    for await (const message of connection.messages) {
      if (message.payload.case !== "fetchBlob") continue;
      const { requestId, sha256, threadId } = message.payload.value;
      requests.push({ threadId, sha256 });
      const data = blobs.get(sha256);
      if (!data) {
        connection.send({ case: "blobChunk", value: { requestId, sha256, last: true, error: "attachment not found" } });
        continue;
      }
      for (let offset = 0; offset < data.length; offset += 1000) {
        const end = Math.min(offset + 1000, data.length);
        connection.send({ case: "blobChunk", value: { requestId, sha256, offset: BigInt(offset), data: data.subarray(offset, end), last: end === data.length } });
      }
    }
  })();
  await Bun.sleep(100); // config applied
});

afterAll(async () => {
  await gateway.link.shutdown();
  await gateway.server.close();
  await host.close();
  await runtime.dispose();
});

const startTurn = (threadId: string, attachments: { id: string; name: string; data: Uint8Array; sha256?: string }[]) =>
  connection.sendCommand({
    case: "startTurn",
    value: {
      thread: { threadId, provider: Provider.CODEX, cwd: join(root, "app"), permissionMode: PermissionMode.ASK },
      turnId: Bun.randomUUIDv7(),
      input: {
        text: "look",
        attachments: attachments.map((a) => ({
          attachmentId: a.id,
          sha256: a.sha256 ?? sha(a.data),
          sizeBytes: BigInt(a.data.length),
          mimeType: "text/plain",
          name: a.name,
          kind: "file",
          path: join(host.attachmentsRoot, threadId, a.id, a.name),
        })),
      },
    },
  });

describe("a turn's attachments on the worker", () => {
  test("the attachments root is in the worker's data directory, outside every repository", () => {
    expect(host.attachmentsRoot).toBe(join(dir, "data", "attachments"));
  });

  test("fetched from the gateway in chunks and written where the note says, before the turn starts", async () => {
    const threadId = Bun.randomUUIDv7();
    const data = new Uint8Array(5_500).map((_, i) => 97 + (i % 26));
    blobs.set(sha(data), data);
    const id = Bun.randomUUIDv7();
    const result = await startTurn(threadId, [{ id, name: "big.txt", data }]);
    // The provider is disabled here; the files were written first.
    expect(result).toMatchObject({ ok: false, errorCode: "PROVIDER_UNAVAILABLE" });
    expect(readFileSync(join(host.attachmentsRoot, threadId, id, "big.txt"))).toEqual(Buffer.from(data));
    expect(requests.at(-1)).toEqual({ threadId, sha256: sha(data) });
  });

  test("a file the gateway does not have fails the turn for good, with the reason", async () => {
    const threadId = Bun.randomUUIDv7();
    const id = Bun.randomUUIDv7();
    const result = await startTurn(threadId, [{ id, name: "gone.txt", data: new TextEncoder().encode("gone") }]);
    expect(result).toMatchObject({ ok: false, errorCode: "ATTACHMENT_UNAVAILABLE" });
    expect(result.errorMessage).toContain("attachment not found");
    expect(existsSync(join(host.attachmentsRoot, threadId, id))).toBe(false);
  });

  test("bytes that do not match their sha256 are not written", async () => {
    const threadId = Bun.randomUUIDv7();
    const id = Bun.randomUUIDv7();
    const real = new TextEncoder().encode("real");
    const forged = sha(new TextEncoder().encode("expected"));
    blobs.set(forged, real);
    const result = await startTurn(threadId, [{ id, name: "x.txt", data: new TextEncoder().encode("expected"), sha256: forged }]);
    expect(result).toMatchObject({ ok: false, errorCode: "ATTACHMENT_UNAVAILABLE" });
    expect(result.errorMessage).toContain("damaged");
  });
});
