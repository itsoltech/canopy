import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AttachmentStore, GatewayStore } from "@canopy/gateway/store";
import { qualifyId } from "@canopy/domain/computers";
import sharp from "sharp";
import { attachmentResponse } from "../../apps/web/src/lib/server/attachment-response.ts";
import { readVideoRequest, type VideoWrite } from "../../apps/mobile/src/features/attachments/video-read.ts";
import { configComputer, pairConfig } from "./support/config-sync.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { mp4, webm } from "./support/video-fixtures.ts";

describe.skipIf(!dockerAvailable)("video attachments through the gateway and BFF", () => {
  let gw: TestGateway;

  beforeAll(async () => {
    gw = await startTestGateway({ attachmentLimits: { maxFileBytes: 4096, maxMessageBytes: 5000, maxFiles: 2 } });
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  function read(id: string, headers: Record<string, string> = {}, query = "", method = "GET") {
    const url = new URL(`http://localhost/api/attachments/${id}${query}`);

    return attachmentResponse(gw.api, id, url, null, new Request(url.href, { headers, method }));
  }

  test("container bytes classify MP4, WebM and MOV, never disguised HTML or SVG", async () => {
    const mov = Buffer.from(mp4);
    mov.write("qt  ", 8);

    for (const [data, type] of [
      [mp4, "video/mp4"],
      [webm, "video/webm"],
      [mov, "video/quicktime"],
    ] as const) {
      const file = (await gw.api.uploadAttachment({ name: "clip.txt", data })).attachment!;
      expect(file).toMatchObject({ kind: "video", mimeType: type, durationMs: 2000, hasThumbnail: true });
      const poster = await gw.api.getAttachment({ attachmentId: file.id, thumbnail: true });
      expect(poster.mimeType).toBe("image/webp");
      expect((await sharp(poster.data).metadata()).width).toBe(320);
      const http = await read(file.id);
      expect(http.headers.get("content-type")).toBe(type);
      expect(http.headers.get("content-disposition")).toStartWith("inline;");
      expect(http.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await http.arrayBuffer())).toEqual(new Uint8Array(data));
    }

    for (const data of ["<!doctype html><html>not video</html>", '<svg xmlns="http://www.w3.org/2000/svg"/>']) {
      const file = (await gw.api.uploadAttachment({ name: "clip.mp4", data: new TextEncoder().encode(data) }))
        .attachment!;

      expect(file.kind).toBe("file");
      expect(file.mimeType.startsWith("video/")).toBe(false);
      const http = await read(file.id);
      expect(http.headers.get("content-disposition")).toStartWith("attachment;");
      await http.arrayBuffer();
    }
  });

  test("ranges are bounded in the gateway, seekable in HTTP and conditional on the full representation", async () => {
    const file = (await gw.api.uploadAttachment({ name: "clip.mp4", data: mp4 })).attachment!;
    const metadata = await gw.api.getAttachment({ attachmentId: file.id, metadataOnly: true });
    expect(metadata.data.length).toBe(0);
    expect(metadata.totalSize).toBe(BigInt(mp4.length));
    const chunk = await gw.api.getAttachment({ attachmentId: file.id, offset: 8n, limit: 24 });
    expect(chunk.offset).toBe(8n);
    expect(chunk.data).toEqual(new Uint8Array(mp4.subarray(8, 32)));
    expect(await failure(gw.api.getAttachment({ attachmentId: file.id, offset: 2n ** 63n, limit: 1 }))).toContain(
      "invalid attachment byte range",
    );
    expect(await failure(gw.api.getAttachment({ attachmentId: file.id, limit: 1024 ** 2 + 1 }))).toContain(
      "invalid attachment byte range",
    );

    for (const [range, start, end] of [
      ["bytes=8-31", 8, 31],
      ["bytes=-20", mp4.length - 20, mp4.length - 1],
      ["bytes=32-", 32, mp4.length - 1],
    ] as const) {
      const response = await read(file.id, { range });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${mp4.length}`);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(mp4.subarray(start, end + 1)));
    }

    for (const range of [
      "bytes=99999-",
      "bytes=8-2",
      "bytes=-0",
      "bytes=0-1,4-8",
      "bytes=nope",
      "bytes=999999999999999999999999999999-",
    ]) {
      const response = await read(file.id, { range });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe(`bytes */${mp4.length}`);
      expect(await response.text()).toBe("");
    }

    const full = await read(file.id, { range: "bytes=0-5", "if-range": '"changed"' });
    expect(full.status).toBe(200);
    expect((await full.arrayBuffer()).byteLength).toBe(mp4.length);
    const etag = full.headers.get("etag")!;
    expect((await read(file.id, { "if-none-match": etag })).status).toBe(304);
    const head = await read(file.id, { range: "bytes=0-5" }, "", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(mp4.length));
    expect(await head.text()).toBe("");
    const download = await read(file.id, {}, "?download");
    expect(download.headers.get("content-disposition")).toStartWith("attachment;");
    await download.arrayBuffer();
  });

  test("ownership precedes metadata, range and cache validation", async () => {
    const mine = (await gw.api.uploadAttachment({ name: "private.mp4", data: mp4 })).attachment!;

    const stranger = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("video-stranger@test", "Stranger")),
    );

    const file = await gw.runtime.runPromise(
      AttachmentStore.use((s) =>
        s.create({
          ownerUserId: stranger,
          name: "private.mp4",
          data: mp4,
          sha256: mine.sha256,
          mimeType: "video/mp4",
          kind: "video",
        }),
      ),
    );

    expect(await failure(gw.api.getAttachment({ attachmentId: file.id, metadataOnly: true }))).toContain("not found");
    expect(await failure(gw.api.getAttachment({ attachmentId: file.id, offset: 0n, limit: 10 }))).toContain(
      "not found",
    );
    const denied = await read(file.id, { range: "bytes=0-9", "if-none-match": `"${file.sha256}"` });
    expect(denied.status).toBe(404);
    expect(denied.headers.get("cache-control")).toBe("no-store");
  });

  test("native player reads use the authenticated gateway for seeks, denial and cancellation", async () => {
    const file = (await gw.api.uploadAttachment({ name: "native.mp4", data: mp4 })).attachment!;

    async function nativeRead(id: string, range: string, method = "GET", signal = new AbortController().signal) {
      const writes: { status: number; headers: Record<string, string>; data: Uint8Array; end: boolean }[] = [];

      const write: VideoWrite = async (status, headers, data, end) => {
        writes.push({ status, headers, data, end });
      };

      await readVideoRequest(gw.api, id, { serverId: "test", requestId: "test", method, range }, write, signal);

      return writes;
    }

    const partial = await nativeRead(file.id, "bytes=8-31");
    expect(partial[0]).toMatchObject({
      status: 206,
      headers: { "Content-Range": `bytes 8-31/${mp4.length}`, "Content-Type": "video/mp4" },
    });
    expect(partial[1]?.data).toEqual(new Uint8Array(mp4.subarray(8, 32)));
    expect(partial[1]?.end).toBe(true);
    expect((await nativeRead(file.id, "bytes=99999-"))[0]).toMatchObject({ status: 416, end: true });
    expect(await nativeRead(file.id, "", "HEAD")).toHaveLength(1);

    const html = (
      await gw.api.uploadAttachment({ name: "fake.mp4", data: new TextEncoder().encode("<html>fake</html>") })
    ).attachment!;

    expect(await failure(nativeRead(html.id, ""))).toContain("Update the computer");

    const controller = new AbortController();
    controller.abort();
    expect(await failure(nativeRead(file.id, "", "GET", controller.signal))).toBeTruthy();

    const stranger = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("native-video@test", "Stranger")),
    );

    const foreign = await gw.runtime.runPromise(
      AttachmentStore.use((s) =>
        s.create({
          ownerUserId: stranger,
          name: "private.mp4",
          data: mp4,
          sha256: file.sha256,
          mimeType: "video/mp4",
          kind: "video",
        }),
      ),
    );

    expect(await failure(nativeRead(foreign.id, "bytes=8-31"))).toContain("not found");
  });

  test("video limits still apply and workers receive original bytes with a video duration note", async () => {
    const large = Buffer.concat([mp4, Buffer.alloc(4097)]);
    expect(await failure(gw.api.uploadAttachment({ name: "large.mp4", data: large }))).toContain("up to");

    const files = await Promise.all(
      [1, 2].map(
        async (i) =>
          (await gw.api.uploadAttachment({ name: `${i}.mp4`, data: Buffer.concat([mp4, Buffer.alloc(2000)]) }))
            .attachment!,
      ),
    );

    const overview = await gw.api.getOverview({});
    const workerId = overview.workers[0]!.id;
    const projectId = (await gw.api.createProject({ name: "Video" })).project!.id;
    const workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: "/repo/video" })).workspace!.id;
    const threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!.id;
    await eventually(
      () => gw.api.getThread({ threadId }),
      (r) => r.thread?.status === "idle",
    );
    expect(await failure(gw.api.sendMessage({ threadId, attachmentIds: files.map((f) => f.id) }))).toContain(
      "a message can carry",
    );
    const file = (await gw.api.uploadAttachment({ name: "clip.mp4", data: mp4 })).attachment!;
    const turn = (await gw.api.sendMessage({ threadId, attachmentIds: [file.id] })).turn!;
    expect(turn.platformNote).toContain("video, video/mp4,");
    expect(turn.platformNote).toContain("2.0 s");
    expect(turn.attachments[0]?.durationMs).toBe(2000);
    await eventually(async () => gw.worker.attachments.get(turn.id), Boolean);
    const blob = await gw.worker.fetchBlob(threadId, file.sha256);
    expect(blob.data).toEqual(new Uint8Array(mp4));
  });
});

test.skipIf(!dockerAvailable)(
  "native streaming reads a multi-chunk video without losing bytes",
  async () => {
    const gw = await startTestGateway();

    try {
      const data = Buffer.concat([mp4, Buffer.alloc(700_000, 42)]);
      const file = (await gw.api.uploadAttachment({ name: "long.mp4", data })).attachment!;
      const chunks: Uint8Array[] = [];

      await readVideoRequest(
        gw.api,
        file.id,
        { serverId: "test", requestId: "test", method: "GET", range: "bytes=1024-690000" },
        async (status, headers, bytes, end) => {
          if (status) {
            expect(status).toBe(206);
            expect(headers["Content-Length"]).toBe("688977");
          }

          if (bytes.length) chunks.push(bytes);

          if (end) expect(Buffer.concat(chunks)).toEqual(data.subarray(1024, 690001));
        },
        new AbortController().signal,
      );
      expect(chunks).toHaveLength(3);
      expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(256 * 1024);
    } finally {
      await gw.close();
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable)(
  "video ranges preserve linked home routing and ownership",
  async () => {
    const home = await configComputer("Video home");
    const viewer = await configComputer("Video viewer");

    try {
      home.links.options.heartbeatMs = 1500;
      viewer.links.options.heartbeatMs = 1500;
      await pairConfig(home, viewer);
      await eventually(async () => viewer.links.reachable().includes(home.node), Boolean, 15_000);
      const file = (await home.gateway.api.uploadAttachment({ name: "linked.webm", data: webm })).attachment!;
      const id = qualifyId(file.id, home.node);
      const url = new URL(`http://localhost/api/attachments/${id}`);

      const response = await attachmentResponse(
        viewer.gateway.api,
        id,
        url,
        null,
        new Request(url.href, { headers: { range: "bytes=8-31" } }),
      );

      expect(response.status).toBe(206);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(webm.subarray(8, 32)));
      expect((await viewer.gateway.api.getAttachment({ attachmentId: id, thumbnail: true })).mimeType).toBe(
        "image/webp",
      );
      expect(await failure(viewer.gateway.api.getAttachment({ attachmentId: file.id, metadataOnly: true }))).toContain(
        "not found",
      );

      const stranger = await home.gateway.runtime.runPromise(
        GatewayStore.use((s) => s.ensureUser("linked-video-stranger@test", "Stranger")),
      );

      await home.store.query("UPDATE attachments SET owner_user_id=$1::uuid WHERE id=$2::uuid", [stranger, file.id]);

      const denied = await attachmentResponse(
        viewer.gateway.api,
        id,
        url,
        null,
        new Request(url.href, { headers: { range: "bytes=8-31" } }),
      );

      expect(denied.status).toBe(404);
    } finally {
      await viewer.close();
      await home.close();
    }
  },
  60_000,
);
