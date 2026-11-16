/** Real harness transcripts remain readable and resumable after storage maintenance and a cold restart. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJsonString } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { THREAD_IMAGE_REPLIES_CAPABILITY } from "@canopy/domain/release/protocol";
import { loadThreadItem } from "@canopy/domain/thread-content";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { pruneDatabase } from "../../apps/gateway/src/maintenance/prune.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { liveProxyReady, useLiveProxy } from "./support/live.ts";
import {
  ageSettledThread,
  projectedDigest,
  rawContents,
  storageQuery,
  storageSizes,
} from "./support/storage-retention.ts";

const LIVE = process.env["CANOPY_LIVE"] === "1";
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];
const MINUTE = 60_000;

const CASES = [
  { name: "codex", provider: Provider.CODEX, model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol" },
  { name: "claude", provider: Provider.CLAUDE, model: process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5" },
];

// A harness executes this in the isolated workspace. Both the output and PNG are synthetic, deterministic bytes.
const FIXTURE = `import hashlib, struct, zlib
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
pixels = b''.join(hashlib.sha256(str(i).encode()).digest() for i in range(1536))
scan = b''.join(b'\\0' + pixels[i*384:(i+1)*384] for i in range(128))
png = b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB',128,128,8,2,0,0,0))
png += chunk(b'IDAT', zlib.compress(scan)) + chunk(b'IEND', b'')
open('retention-generated.png', 'wb').write(png)
for i in range(320):
    print('RETENTION-%04d-' % i + hashlib.sha256(str(i).encode()).hexdigest())
`;

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)(
  "storage retention with real harnesses (live)",
  () => {
    const dir = tempDir("canopy-storage-live-");
    const repo = tempDir("canopy-storage-repo-");
    let gw: TestGateway;
    let workerId = "";
    let credential = "";
    let projectId = "";
    let workspaceId = "";
    let stop = async () => {};

    const query = <T extends object>(sql: string, args: readonly unknown[] = []) => storageQuery<T>(gw, sql, args);

    async function startWorker() {
      const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
      const host = new WorkerHost({ runtime, dataDir: join(dir, "data"), clientVersion: "live" });
      await host.recover();

      const link = await openGatewayLink({
        baseUrl: gw.grpcUrl,
        credential,
        hello: {
          workerId,
          host: { os: process.platform },
          capabilities: [THREAD_IMAGE_REPLIES_CAPABILITY, "full_access", "running_turns"],
          attachmentsRoot: host.attachmentsRoot,
          ...(await runtime.runPromise(journalHello())),
        },
      });

      const serving = serveLink(link, host, runtime);
      stop = async () => {
        link.close();
        await serving;
        await host.close();
        await runtime.dispose();
      };

      await liveProxyReady(
        gw,
        workerId,
        CASES.map((c) => c.provider),
        2 * MINUTE,
      );
    }

    beforeAll(async () => {
      gw = await startTestGateway();
      ({ workerId, credential } = await gw.runtime.runPromise(
        GatewayStore.use((s) => s.addWorker({ name: "storage-live", ownerUserId: gw.userId })),
      ));
      await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
      writeFileSync(join(repo, "storage-fixture.py"), FIXTURE);
      await startWorker();
      projectId = (await gw.api.createProject({ name: "Storage regression" })).project!.id;
      workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;
    }, 3 * MINUTE);

    afterAll(async () => {
      await stop();
      await gw?.close();
    });

    async function snapshot(threadId: string): Promise<ui.ThreadSnapshot> {
      const abort = new AbortController();

      try {
        for await (const update of gw.api.watchThread(
          { threadId, sequence: true },
          { signal: abort.signal, timeoutMs: 10_000 },
        ))
          if (update.change.case === "snapshot") {
            const state = update.change.value;

            for (const item of state.items) {
              const reference = item.contentRef;

              if (!reference) continue;
              item.item = await loadThreadItem(
                reference,
                (offset, length) => gw.api.getThreadSyncContent({ threadId, sha256: reference.sha256, offset, length }),
                abort.signal,
              );
            }

            return state;
          }
      } finally {
        abort.abort();
      }

      throw new Error("Missing persisted transcript snapshot");
    }

    async function ready(threadId: string) {
      const response = await eventually(
        () => gw.api.getThread({ threadId }),
        (r) => r.thread?.status === "idle" || r.thread?.status === "failed",
        MINUTE,
      );

      expect(response.thread?.status).toBe("idle");
    }

    async function turn(threadId: string, text: string) {
      const id = (await gw.api.sendMessage({ threadId, text, clientRequestId: crypto.randomUUID() })).turn!.id;

      const ended = await eventually(
        () =>
          query<{ status: string; error_source: string | null; error_code: string | null; error_tags: string[] }>(
            `SELECT status,error_source,error_code,ARRAY(SELECT tag FROM unnest(ARRAY[
              'session','not found','already','permission','resume','model','fork','tool','exit',
              'Cannot read','ENOENT','uuid','context','closed','timeout','schema','profile'
            ]) tag WHERE error ILIKE '%'||tag||'%') AS error_tags FROM turns WHERE id=$1::uuid`,
            [id],
          ),
        (rows) => ["completed", "failed", "interrupted"].includes(rows[0]?.status ?? ""),
        5 * MINUTE,
      );

      if (ended[0]?.status !== "completed") console.info(JSON.stringify({ storage_turn_failure: ended[0] }));
      expect(ended[0]?.status).toBe("completed");

      const state = await snapshot(threadId);

      const answer = state.items
        .filter((item) => item.turnId === id)
        .flatMap((item) => (item.item?.content.case === "agentMessage" ? [item.item.content.value.text] : []))
        .join("\n");

      return { id, answer, state };
    }

    async function blobs(threadId: string) {
      const refs = await query<{ sha256: string; attachment_id: string | null }>(
        `SELECT sha256,NULL::uuid AS attachment_id FROM thread_blobs WHERE thread_id=$1::uuid
        UNION ALL SELECT sha256,id AS attachment_id FROM attachments WHERE thread_id=$1::uuid
        ORDER BY sha256,attachment_id`,
        [threadId],
      );

      const results = [];

      for (const ref of refs) {
        const response = ref.attachment_id
          ? await gw.api.getAttachment({ attachmentId: ref.attachment_id })
          : await gw.api.getThreadBlob({ threadId, sha256: ref.sha256 });

        expect(hash(response.data)).toBe(ref.sha256);
        results.push({ sha256: ref.sha256, attachmentId: ref.attachment_id, bytes: response.data.length });
      }

      return results;
    }

    async function maintain(owner: string) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await query("UPDATE database_maintenance SET next_run_at=now() WHERE owner_user_id=$1::uuid", [owner]);
        const touched = await gw.runtime.runPromise(pruneDatabase(owner));

        if (!touched) return;
      }

      throw new Error("Storage maintenance did not become idle");
    }

    async function restart() {
      await stop();

      const storage = {
        pg: gw.pg,
        secretsKey: gw.secretsKey,
        workerId: gw.workerId,
        workerCredential: gw.workerCredential,
      };

      await gw.close(true);
      gw = await startTestGateway({ storage });
      await startWorker();
    }

    for (const c of CASES) {
      test(
        `${c.name}: complete projections and image bytes survive maintenance, restart, resume and fork`,
        async () => {
          const thread = (
            await gw.api.createThread({
              projectId,
              workspaceId,
              title: `${c.name} storage`,
              provider: c.provider,
              providerProfileId: "cliproxyapi",
              model: c.model,
              permissionMode: PermissionMode.FULL_AUTO,
              effort: "low",
            })
          ).thread!;

          await ready(thread.id);

          const first = await turn(
            thread.id,
            "Remember the codeword PELICAN for later. Run `python3 storage-fixture.py` once, retaining all 320 output lines " +
              "(use an output limit of at least 20000 tokens if supported). Then call the platform show_images tool with " +
              "retention-generated.png and descriptive alt text to publish the generated image. Do not read environment " +
              "variables or unrelated files. Finally reply with exactly STORAGE_READY.",
          );

          expect(first.answer).toContain("STORAGE_READY");
          const projected = toJsonString(ui.ThreadSnapshotSchema, first.state);

          const expected = Array.from(
            { length: 320 },
            (_, i) => `RETENTION-${String(i).padStart(4, "0")}-${createHash("sha256").update(String(i)).digest("hex")}`,
          );

          expect(expected.every((line) => projected.includes(line))).toBe(true);
          const originalBlobs = await blobs(thread.id);
          expect(originalBlobs.length).toBeGreaterThan(0);
          expect(originalBlobs.some((b) => b.bytes > 10_000)).toBe(true);
          const originalDigest = await projectedDigest(gw, thread.id);
          const before = await storageSizes(gw, thread.id);
          const originalRaw = await rawContents(gw, thread.id);
          const owner = crypto.randomUUID();
          await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Storage stranger','user')", [
            owner,
            `${owner}@example.test`,
          ]);
          const foreign = new GatewayCore({ runtime: gw.runtime, userId: owner, instanceId: crypto.randomUUID() });
          expect(await failure(foreign.getThreadBlob(thread.id, originalBlobs[0]!.sha256))).toContain("not found");

          for (const blob of originalBlobs)
            if (blob.attachmentId)
              expect(await failure(foreign.getAttachment(blob.attachmentId, false))).toContain("not found");
          await ageSettledThread(gw, thread.id);
          await query("UPDATE thread_events SET recorded_at=now()-interval '2 hours' WHERE thread_id=$1::uuid", [
            thread.id,
          ]);
          await query(
            "UPDATE worker_commands SET completed_at=now()-interval '8 days' WHERE thread_id=$1::uuid AND status IN ('completed','failed')",
            [thread.id],
          );
          await query("UPDATE attachments SET created_at=now()-interval '32 days' WHERE thread_id=$1::uuid", [
            thread.id,
          ]);
          await query("UPDATE blobs SET created_at=now()-interval '8 days' WHERE sha256=ANY($1::text[])", [
            originalBlobs.map((b) => b.sha256),
          ]);
          await maintain(owner);
          expect(await projectedDigest(gw, thread.id)).toBe(originalDigest);
          expect(
            (
              await query<{ n: number }>(
                "SELECT count(*)::int n FROM worker_commands WHERE thread_id=$1::uuid AND payload_pruned_at IS NOT NULL",
                [thread.id],
              )
            )[0]?.n,
          ).toBe(0);
          await maintain(gw.userId);
          expect(
            (
              await query<{ n: number }>(
                "SELECT count(*)::int n FROM worker_commands WHERE thread_id=$1::uuid AND payload_pruned_at IS NOT NULL",
                [thread.id],
              )
            )[0]?.n,
          ).toBeGreaterThan(0);
          const after = await storageSizes(gw, thread.id);
          expect(await rawContents(gw, thread.id, originalRaw.through_seq)).toEqual(originalRaw);
          expect(await projectedDigest(gw, thread.id)).toBe(originalDigest);
          expect(await blobs(thread.id)).toEqual(originalBlobs);
          console.info(
            JSON.stringify({
              storage_retention: c.name,
              before,
              after,
              reconstructed_raw_json_bytes: originalRaw.reconstructed_json_bytes,
              blobs: originalBlobs.map((b) => ({ bytes: b.bytes })),
            }),
          );
          await restart();
          const restored = await snapshot(thread.id);
          expect(restored.items).toHaveLength(first.state.items.length);
          expect(restored.notices).toEqual(first.state.notices);
          const restoredText = toJsonString(ui.ThreadSnapshotSchema, restored);
          expect(expected.every((line) => restoredText.includes(line))).toBe(true);
          expect(await rawContents(gw, thread.id, originalRaw.through_seq)).toEqual(originalRaw);
          expect(await projectedDigest(gw, thread.id)).toBe(originalDigest);
          expect(await blobs(thread.id)).toEqual(originalBlobs);

          const resumed = await turn(
            thread.id,
            "What codeword did I ask you to remember? Reply with that word only, without tools.",
          );

          expect(resumed.answer.toUpperCase()).toContain("PELICAN");
          expect(resumed.state.notices).toEqual(first.state.notices);
          const fork = (await gw.api.createThread({ forkThreadId: thread.id, forkAtTurnId: first.id })).thread!;
          await ready(fork.id);
          const inherited = await snapshot(fork.id);
          expect(inherited.turns.some((t) => t.inherited)).toBe(true);
          expect(
            inherited.items.flatMap((i) =>
              i.item?.content.case === "imageGallery"
                ? i.item.content.value.images.map((image) => image.attachmentId)
                : [],
            ),
          ).toEqual(
            first.state.items.flatMap((i) =>
              i.item?.content.case === "imageGallery"
                ? i.item.content.value.images.map((image) => image.attachmentId)
                : [],
            ),
          );

          const forked = await turn(
            fork.id,
            "What codeword did I ask you to remember? Reply with that word only, without tools.",
          );

          expect(forked.answer.toUpperCase()).toContain("PELICAN");
          expect(forked.state.notices.filter((n) => n.notice?.code !== "connectors_baseline")).toEqual(
            inherited.notices.filter((n) => n.notice?.code !== "connectors_baseline"),
          );
          expect(await blobs(thread.id)).toEqual(originalBlobs);
          console.info(JSON.stringify({ storage_recovery: c.name, restart: true, resume: true, fork: true }));
        },
        15 * MINUTE,
      );
    }
  },
);
