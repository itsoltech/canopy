import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { isMessage, toJsonString } from "@bufbuild/protobuf";
import { ExportThreadImageSchema, ItemSchema, Provider, type AgentToolResult } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AttachmentStore, GatewayStore } from "@canopy/gateway/store";
import { THREAD_IMAGE_REPLIES_CAPABILITY } from "@canopy/domain/release/protocol";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import sharp from "sharp";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("durable image publication over WorkerLink", () => {
  let gw: TestGateway;
  let worker: TestGateway["worker"];
  let workspaceId: string;
  let projectId: string;
  let png: Uint8Array;
  let reads = 0;
  let mode = "normal";
  const files = new Map<string, Uint8Array>();
  const deferred: (() => void)[] = [];

  const json = (reply: AgentToolResult) =>
    JSON.parse(reply.content) as { delivered: boolean; item_id: string; attachment_ids: string[] };

  const query = <A extends object>(text: string, params: readonly string[] = []) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(text, params)));

  function exporter() {
    worker.handlers.set("exportThreadImage", (value, reply) => {
      if (!isMessage(value, ExportThreadImageSchema)) return reply(false);
      const data = files.get(value.path);

      if (value.operation === "release") return reply(true, { threadImageExport: {} });

      if (!data) return reply(false, { errorMessage: "Image unavailable." });

      if (value.operation === "read") reads++;
      const start = Number(value.offset);
      const chunk = value.operation === "probe" ? new Uint8Array() : data.slice(start, start + 256 * 1024);

      const respond = () =>
        reply(true, {
          threadImageExport: {
            name: value.path.split("/").at(-1)!,
            sizeBytes: mode === "oversized" ? 400_001n : BigInt(data.length),
            sha256: mode === "corrupt" ? "0".repeat(64) : createHash("sha256").update(data).digest("hex"),
            data: mode === "empty" ? new Uint8Array() : chunk,
          },
        });

      if (mode === "pause" && value.operation === "probe") deferred.push(respond);
      else respond();
    });
  }

  beforeAll(async () => {
    gw = await startTestGateway({
      worker: { hello: { capabilities: [THREAD_IMAGE_REPLIES_CAPABILITY] } },
      attachmentLimits: { maxFileBytes: 300_000, maxMessageBytes: 400_000, maxFiles: 3 },
    });
    worker = gw.worker;
    projectId = (await gw.api.createProject({ name: "Image replies" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/images" }))
      .workspace!.id;
    png = new Uint8Array(
      await sharp({ create: { width: 80, height: 40, channels: 3, background: "#44aabb" } })
        .png()
        .toBuffer(),
    );
    files.set("screens/after.png", png);
    files.set("screens/before.png", png);
    exporter();
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  async function turn() {
    worker.holdTurns = true;

    const thread = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Screens" }))
      .thread!;

    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );

    const sent = (
      await gw.api.sendMessage({ threadId: thread.id, text: "Show the result", clientRequestId: crypto.randomUUID() })
    ).turn!;

    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id))),
      (rows) => rows.some((row) => row.id === sent.id && row.status === "running"),
    );

    return { threadId: thread.id, turnId: sent.id };
  }

  const images = [{ path: "screens/after.png", alt: "Updated effect" }];

  const show = (source: { threadId: string; turnId: string }, callId = Bun.randomUUIDv7()) =>
    worker.callTool({ ...source, callId, tool: "show_images", args: { images } });

  test("copies normalized bytes, thumbnail and a small gateway manifest, then replays once after restart", async () => {
    const source = await turn();
    const callId = Bun.randomUUIDv7();
    const first = await show(source, callId);
    expect(first.isError).toBe(false);
    const published = json(first);
    expect(published.delivered).toBe(true);
    const id = published.attachment_ids[0]!;
    const full = await gw.api.getAttachment({ attachmentId: id });
    const thumb = await gw.api.getAttachment({ attachmentId: id, thumbnail: true });
    expect((await sharp(full.data).metadata()).width).toBe(80);
    expect((await sharp(thumb.data).metadata()).format).toBe("webp");
    const snapshot = await gw.runtime.runPromise(GatewayStore.use((s) => s.snapshot(source.threadId)));
    const gallery = snapshot.items.find((row) => row.item?.itemId === published.item_id)?.item;
    expect(gallery?.content.case).toBe("imageGallery");
    expect(gallery && toJsonString(ItemSchema, gallery)).not.toContain("screens/");
    expect(
      await query("SELECT id FROM attachments WHERE thread_id=$1::uuid AND turn_id=$2::uuid", [
        source.threadId,
        source.turnId,
      ]),
    ).toHaveLength(1);
    const count = reads;
    expect(json(await show(source, callId))).toEqual(published);
    expect(reads).toBe(count);
    await expect(gw.runtime.runPromise(AttachmentStore.use((s) => s.owned(Bun.randomUUIDv7(), id)))).rejects.toThrow(
      "not found",
    );

    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    worker.finish(source.threadId, source.turnId);
    await eventually(
      () => gw.api.getThread({ threadId: source.threadId }),
      (r) => r.thread?.status === "idle",
    );
    files.delete("screens/after.png");
    await gw.close(true);
    gw = await startTestGateway({
      storage,
      attachmentLimits: { maxFileBytes: 300_000, maxMessageBytes: 400_000, maxFiles: 3 },
    });
    worker = gw.worker;
    expect(json(await show(source, callId))).toEqual(published);
    expect((await gw.api.getAttachment({ attachmentId: id })).data).toEqual(full.data);
    expect(
      await query("SELECT item_id FROM thread_items WHERE type='image_gallery' AND thread_id=$1::uuid", [
        source.threadId,
      ]),
    ).toHaveLength(1);
    files.set("screens/after.png", png);
    // The new worker gets the explicitly negotiated image capability for subsequent tests.
    worker.link.close();
    worker = await gw.connect(gw.workerId, gw.workerCredential, undefined, {
      hello: { capabilities: [THREAD_IMAGE_REPLIES_CAPABILITY] },
    });
    exporter();
  }, 30_000);

  test("old workers get an actionable refusal; a worker cannot speak for another worker's thread", async () => {
    const source = await turn();
    const other = await gw.addWorker("Old image worker");
    const old = await gw.connect(other.workerId, other.credential);
    const wrong = await old.callTool({ ...source, tool: "show_images", args: { images } });
    expect(wrong.isError).toBe(true);
    expect(wrong.content).toBe("Thread not found");
    worker.link.close();
    worker = await gw.connect(gw.workerId, gw.workerCredential);
    const refused = await show(source);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("Update this computer");
    worker.link.close();
    worker = await gw.connect(gw.workerId, gw.workerCredential, undefined, {
      hello: { capabilities: [THREAD_IMAGE_REPLIES_CAPABILITY] },
    });
    exporter();
  });

  test("validates counts and complete pairs before export", async () => {
    const source = await turn();
    const before = reads;

    for (const args of [
      { images: [] },
      { images: Array(11).fill(images[0]) },
      { images: [{ ...images[0]!, pair: "effect", side: "before" }] },
    ]) {
      expect((await worker.callTool({ ...source, tool: "show_images", args })).isError).toBe(true);
    }

    expect(reads).toBe(before);
  });

  test("refuses oversized metadata before allocating, corrupt/empty chunks and SVG atomically", async () => {
    const source = await turn();

    for (const failureMode of ["oversized", "corrupt", "empty"]) {
      mode = failureMode;
      const before = reads;
      expect((await show(source)).isError).toBe(true);

      if (mode === "oversized") expect(reads).toBe(before);
    }

    mode = "normal";
    files.set(
      "unsafe.svg",
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    );
    expect(
      (
        await worker.callTool({
          ...source,
          tool: "show_images",
          args: { images: [{ path: "unsafe.svg", alt: "Unsafe" }] },
        })
      ).isError,
    ).toBe(true);
    expect(await query("SELECT id FROM attachments WHERE thread_id=$1::uuid", [source.threadId])).toHaveLength(0);
    expect(
      await query("SELECT call_id FROM thread_image_publications WHERE thread_id=$1::uuid", [source.threadId]),
    ).toHaveLength(0);
  });

  test("reserves per-thread and per-worker slots before transfer, releasing both after completion", async () => {
    const sources = [await turn(), await turn(), await turn()];
    mode = "pause";
    const first = show(sources[0]!);
    await eventually(
      async () => deferred.length,
      (count) => count === 1,
    );
    const sameThread = await show(sources[0]!);
    expect(sameThread.content).toContain("already being prepared");
    const second = show(sources[1]!);
    await eventually(
      async () => deferred.length,
      (count) => count === 2,
    );
    const sameWorker = await show(sources[2]!);
    expect(sameWorker.content).toContain("already being prepared");
    mode = "normal";

    for (const resume of deferred.splice(0)) resume();
    expect((await first).isError).toBe(false);
    expect((await second).isError).toBe(false);
    expect((await show(sources[2]!)).isError).toBe(false);
  });

  test("enforces owner limits and durable turn counts/bytes before reading; foreign and finished turns cannot publish", async () => {
    const source = await turn();
    const before = reads;
    expect(
      (await worker.callTool({ ...source, tool: "show_images", args: { images: Array(4).fill(images[0]) } })).isError,
    ).toBe(true);
    await query(
      `INSERT INTO thread_image_publications(call_id,thread_id,turn_id,worker_id,request_hash,lease_token,expires_at,state,image_count,size_bytes)
      SELECT gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'fixture',gen_random_uuid(),now(),'committed',10,1 FROM generate_series(1,10)`,
      [source.threadId, source.turnId, gw.workerId],
    );
    expect((await show(source)).content).toContain("image limit");
    await query("DELETE FROM thread_image_publications WHERE turn_id=$1::uuid", [source.turnId]);
    await query(
      `INSERT INTO thread_image_publications(call_id,thread_id,turn_id,worker_id,request_hash,lease_token,expires_at,state,image_count,size_bytes)
      SELECT gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'fixture',gen_random_uuid(),now(),'committed',1,52428800 FROM generate_series(1,4)`,
      [source.threadId, source.turnId, gw.workerId],
    );
    expect((await show(source)).content).toContain("image limit");
    const foreign = await turn();
    expect((await show({ threadId: source.threadId, turnId: foreign.turnId })).isError).toBe(true);
    worker.finish(source.threadId, source.turnId);
    await eventually(
      () => gw.api.getThread({ threadId: source.threadId }),
      (reply) => reply.thread?.status === "idle",
    );
    expect((await show(source)).isError).toBe(true);
    expect(reads).toBe(before);
  });

  test("bounds encoded output when normalized JPEG, PNG and WebP exceed the owner's byte budget", async () => {
    const source = await turn();
    const noise = randomBytes(1200 * 1200 * 3);
    const input = sharp(noise, { raw: { width: 1200, height: 1200, channels: 3 } });

    const fixtures = [
      { path: "expansion.jpg", data: await input.clone().resize(1800, 1800).jpeg({ quality: 8 }).toBuffer() },
      { path: "expansion.tiff", data: await input.clone().tiff({ compression: "jpeg", quality: 5 }).toBuffer() },
      { path: "expansion.webp", data: await input.clone().webp({ quality: 1 }).toBuffer() },
    ];

    for (const fixture of fixtures) {
      expect(fixture.data.length, fixture.path).toBeLessThan(300_000);
      files.set(fixture.path, fixture.data);

      const result = await worker.callTool({
        ...source,
        tool: "show_images",
        args: { images: [{ path: fixture.path, alt: "Compression expansion" }] },
      });

      expect(result.isError, fixture.path).toBe(true);
      expect(result.content).toContain("image limit after processing");
    }

    expect(await query("SELECT id FROM attachments WHERE thread_id=$1::uuid", [source.threadId])).toHaveLength(0);
    // Aborted native writers release their sink and reservation; subsequent publication remains usable.
    expect((await show(source)).isError).toBe(false);
  }, 30_000);

  test("strips image metadata, flattens animation and preserves complete before/after captions", async () => {
    const source = await turn();
    files.set("oriented.jpg", new Uint8Array(await sharp(png).jpeg().withMetadata({ orientation: 6 }).toBuffer()));
    files.set("still.gif", Uint8Array.fromBase64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"));

    const reply = await worker.callTool({
      ...source,
      tool: "show_images",
      args: {
        caption: "Effect comparison",
        images: [
          { path: "oriented.jpg", alt: "Before", caption: "Original", pair: "effect", side: "before" },
          { path: "still.gif", alt: "After", caption: "Updated", pair: "effect", side: "after" },
        ],
      },
    });

    expect(reply.isError).toBe(false);
    const published = json(reply);
    const jpeg = await gw.api.getAttachment({ attachmentId: published.attachment_ids[0]! });
    const meta = await sharp(jpeg.data).metadata();
    expect([meta.width, meta.height, meta.exif, meta.xmp]).toEqual([40, 80, undefined, undefined]);
    const gif = await gw.api.getAttachment({ attachmentId: published.attachment_ids[1]! });
    expect((await sharp(gif.data).metadata()).format).toBe("png");
  });
});
