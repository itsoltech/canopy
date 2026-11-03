/**
 * Attachments end to end on PostgreSQL (docs/ui-api.md, "Załączniki"; docs/protocol.md, "Załączniki"):
 * upload (limits, type from the content, images cleaned) -> a message -> the platform note with worker paths ->
 * StartTurn with the files -> the worker fetches the bytes (only its own threads') -> previews the worker uploads
 * -> the owner reads them through the thread.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Client } from "@connectrpc/connect";
import { ItemStatus, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AttachmentStore, GatewayStore } from "@canopy/gateway/store";
import sharp from "sharp";
import { eventually, failure, SCRIPTED_ATTACHMENTS_ROOT, startTestGateway, watchUntil, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let api: Client<typeof ui.GatewayService>;
let worker: ScriptedWorker;

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const text = (value: string) => new TextEncoder().encode(value);

/** A JPEG with EXIF (camera, GPS-like comment) and orientation 6 (rotated 90°): 40 x 20 stored, 20 x 40 upright. */
async function photoWithExif(): Promise<Uint8Array> {
  const data = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#3366cc" } })
    .jpeg()
    .withExif({ IFD0: { Make: "PhoneCo", Model: "Secret Phone", ImageDescription: "GPS 52.2297 N 21.0122 E" } })
    .toBuffer();
  return new Uint8Array(await sharp(data).withMetadata({ orientation: 6 }).toBuffer());
}

describe.skipIf(!dockerAvailable)("attachments", () => {
  let projectId = "";
  let workspaceId = "";
  let workerId = "";

  beforeAll(async () => {
    gw = await startTestGateway({ attachmentLimits: { maxFileBytes: 200_000, maxMessageBytes: 300_000, maxFiles: 3 } });
    ({ api, worker } = gw);
    workerId = (await api.getOverview({})).workers[0]!.id;
    projectId = (await api.createProject({ name: "Attachments" })).project!.id;
    workspaceId = (await api.createWorkspace({ projectId, workerId, rootPath: "/repo/app", label: "laptop" })).workspace!.id;
    // The worker reported its attachments root in Hello.
    await eventually(() => gw.runtime.runPromise(AttachmentStore.use((s) => s.workerRoot(workerId))), (r) => r.root !== "");
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  const newThread = async (title: string) => {
    const thread = (await api.createThread({ projectId, workspaceId, title, provider: Provider.CODEX })).thread!;
    await eventually(() => api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    return thread;
  };

  describe("upload: limits and the type from the content", () => {
    test("a PNG named .txt is an image; it gets a thumbnail and its dimensions", async () => {
      const png = new Uint8Array(await sharp({ create: { width: 64, height: 32, channels: 4, background: "#ff000080" } }).png().toBuffer());
      const { attachment } = await api.uploadAttachment({ name: "notes.txt", data: png });
      expect(attachment).toMatchObject({ kind: "image", mimeType: "image/png", width: 64, height: 32, hasThumbnail: true, name: "notes.txt" });
      const thumb = await api.getAttachment({ attachmentId: attachment!.id, thumbnail: true });
      expect(thumb.mimeType).toBe("image/webp");
      expect((await sharp(thumb.data).metadata()).format).toBe("webp");
    });

    test("photos are stored upright and without EXIF (camera, GPS)", async () => {
      const photo = await photoWithExif();
      expect((await sharp(photo).metadata()).exif).toBeDefined();
      const { attachment } = await api.uploadAttachment({ name: "IMG_0001.jpg", data: photo });
      expect(attachment).toMatchObject({ kind: "image", mimeType: "image/jpeg", width: 20, height: 40 });
      const stored = await api.getAttachment({ attachmentId: attachment!.id });
      const meta = await sharp(stored.data).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(Buffer.from(stored.data).includes(Buffer.from("Secret Phone"))).toBe(false);
      expect(stored.attachment?.sha256).toBe(sha(stored.data));
    });

    test("text named .png is a text file; SVG is a file, never an inline image", async () => {
      const fake = await api.uploadAttachment({ name: "shot.png", data: text("not an image") });
      expect(fake.attachment).toMatchObject({ kind: "file", mimeType: "text/plain", hasThumbnail: false });
      const svg = await api.uploadAttachment({ name: "logo.svg", data: text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') });
      expect(svg.attachment).toMatchObject({ kind: "file", mimeType: "image/svg+xml", hasThumbnail: false });
    });

    test("programs, empty files and files over the limit are refused with a reason", async () => {
      expect(await failure(api.uploadAttachment({ name: "tool", data: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]) }))).toContain("program");
      expect(await failure(api.uploadAttachment({ name: "setup.pdf", data: text("MZ\x90\0\x03") }))).toContain("program");
      expect(await failure(api.uploadAttachment({ name: "empty.txt", data: new Uint8Array() }))).toContain("empty");
      expect(await failure(api.uploadAttachment({ name: "big.txt", data: new Uint8Array(200_001).fill(65) }))).toContain("up to 195.3 KB");
    });

    test("names lose directories and control characters", async () => {
      const { attachment } = await api.uploadAttachment({ name: "../../etc/pass\u0000wd", data: text("x") });
      expect(attachment?.name).toBe("passwd");
    });

    test("the limits are part of the settings the UI reads", async () => {
      const settings = await api.getSettings({});
      expect(settings.attachmentLimits).toMatchObject({ maxFileBytes: 200_000n, maxMessageBytes: 300_000n, maxFiles: 3 });
    });
  });

  describe("a message with attachments", () => {
    test("the agent gets the platform note with each file's path on its worker; the worker fetches the bytes", async () => {
      const thread = await newThread("Look at this");
      const image = new Uint8Array(await sharp({ create: { width: 30, height: 10, channels: 3, background: "#00ff00" } }).png().toBuffer());
      const shot = (await api.uploadAttachment({ name: "screen shot.png", data: image })).attachment!;
      const notes = (await api.uploadAttachment({ name: "notes.md", data: text("# Notes\nhello") })).attachment!;
      const sent = await api.sendMessage({ threadId: thread.id, text: "What is in these?", clientRequestId: "att-1", attachmentIds: [shot.id, notes.id] });
      const turn = sent.turn!;
      const shotPath = `${SCRIPTED_ATTACHMENTS_ROOT}/${thread.id}/${shot.id}/screen shot.png`;
      const notesPath = `${SCRIPTED_ATTACHMENTS_ROOT}/${thread.id}/${notes.id}/notes.md`;
      expect(turn.messageText).toBe("What is in these?");
      expect(turn.platformNote).toStartWith("[open-agents] The user attached 2 files");
      expect(turn.platformNote).toContain(`- ${shotPath} (image/png,`);
      expect(turn.platformNote).toContain("30×10 px");
      expect(turn.platformNote).toContain(`- ${notesPath} (text/markdown, 13 B)`);
      expect(turn.inputText).toBe(`${turn.platformNote}\n\nWhat is in these?`);
      expect(turn.attachments.map((a) => [a.name, a.kind])).toEqual([["screen shot.png", "image"], ["notes.md", "file"]]);

      const started = await eventually(async () => worker.attachments.get(turn.id), (a) => a !== undefined);
      expect(started?.map((a) => [a.attachmentId, a.path, a.kind, a.sha256])).toEqual([
        [shot.id, shotPath, "image", shot.sha256],
        [notes.id, notesPath, "file", notes.sha256],
      ]);
      expect(worker.inputs.get(thread.id)?.[0]).toBe(turn.inputText);
      const fetched = await worker.fetchBlob(thread.id, shot.sha256);
      expect(fetched.data && sha(fetched.data)).toBe(shot.sha256);

      // Only attachments of its own thread: another thread's or an unsent upload's bytes are refused.
      const other = await newThread("Other");
      expect((await worker.fetchBlob(other.id, shot.sha256)).error).toBe("attachment not found");
      const unsent = (await api.uploadAttachment({ name: "later.txt", data: text("later") })).attachment!;
      expect((await worker.fetchBlob(thread.id, unsent.sha256)).error).toBe("attachment not found");

      // The snapshot keeps the files on the turn; a retry returns the same turn.
      const retry = await api.sendMessage({ threadId: thread.id, text: "What is in these?", clientRequestId: "att-1", attachmentIds: [shot.id, notes.id] });
      expect(retry.turn?.id).toBe(turn.id);
      const updates = await watchUntil(api, thread.id, (u) => u.some((x) => x.change.case === "snapshot"));
      const snapshot = updates.find((u) => u.change.case === "snapshot")?.change.value as ui.ThreadSnapshot;
      expect(snapshot.turns.find((t) => t.id === turn.id)?.attachments.length).toBe(2);
    });

    test("a big file is fetched in chunks", async () => {
      const thread = await newThread("Big");
      const data = new Uint8Array(190_000).map((_, i) => 32 + (i % 90));
      const big = (await api.uploadAttachment({ name: "big.log", data })).attachment!;
      await api.sendMessage({ threadId: thread.id, text: "", clientRequestId: "att-big", attachmentIds: [big.id] });
      const fetched = await worker.fetchBlob(thread.id, big.sha256);
      expect(fetched.data?.length).toBe(190_000);
    });

    test("an attachment goes with one message; count and total are limited", async () => {
      const thread = await newThread("Limits");
      const a = (await api.uploadAttachment({ name: "a.txt", data: text("a") })).attachment!;
      await api.sendMessage({ threadId: thread.id, text: "first", clientRequestId: "lim-1", attachmentIds: [a.id] });
      expect(await failure(api.sendMessage({ threadId: thread.id, text: "again", clientRequestId: "lim-2", attachmentIds: [a.id] }))).toContain("already sent");
      const files = await Promise.all(["1", "2", "3", "4"].map(async (n) => (await api.uploadAttachment({ name: `${n}.txt`, data: text(n) })).attachment!));
      expect(await failure(api.sendMessage({ threadId: thread.id, text: "many", clientRequestId: "lim-3", attachmentIds: files.map((f) => f.id) }))).toContain(
        "up to 3 files",
      );
      const big = await Promise.all(["x", "y"].map(async (n) => (await api.uploadAttachment({ name: `${n}.bin`, data: new Uint8Array(160_000).fill(1) })).attachment!));
      expect(await failure(api.sendMessage({ threadId: thread.id, text: "heavy", clientRequestId: "lim-4", attachmentIds: big.map((f) => f.id) }))).toContain(
        "a message can carry up to",
      );
      expect(await failure(api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: "lim-5", attachmentIds: ["0196f0c1-0000-7000-8000-000000000000"] }))).toContain(
        "unknown attachment",
      );
    });

    test("a steer with attachments runs as the next turn", async () => {
      const thread = await newThread("Steer");
      worker.holdTurns = true;
      const first = await api.sendMessage({ threadId: thread.id, text: "work", clientRequestId: "st-1" });
      await eventually(() => api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "running");
      const file = (await api.uploadAttachment({ name: "more.txt", data: text("more") })).attachment!;
      const steered = await api.sendMessage({ threadId: thread.id, text: "also this", clientRequestId: "st-2", attachmentIds: [file.id], delivery: ui.MessageDelivery.STEER });
      expect(steered.steer).toBeUndefined();
      expect(steered.turn?.status).toBe("queued");
      worker.holdTurns = false;
      worker.finish(thread.id, first.turn!.id);
    });

    test("a new thread's first message can carry attachments", async () => {
      const file = (await api.uploadAttachment({ name: "brief.txt", data: text("the brief") })).attachment!;
      const thread = (
        await api.createThread({ projectId, workspaceId, title: "Brief", provider: Provider.CODEX, initialMessage: "Read the brief", initialAttachmentIds: [file.id], clientRequestId: "ct-att" })
      ).thread!;
      const turnId = await eventually(
        async () => [...worker.attachments.entries()].find(([, list]) => list.some((a) => a.attachmentId === file.id))?.[0],
        (id) => id !== undefined,
      );
      expect(turnId).toBeDefined();
      expect(worker.inputs.get(thread.id)?.[0]).toContain(`${SCRIPTED_ATTACHMENTS_ROOT}/${thread.id}/${file.id}/brief.txt`);
      expect(worker.inputs.get(thread.id)?.[0]).toEndWith("\n\nRead the brief");
    });

    test("a worker that did not report an attachments root cannot take them", async () => {
      const old = await gw.addWorker("old", ["/old"]);
      await gw.connect(old.workerId, old.credential, undefined, { hello: { attachmentsRoot: "" } });
      const ws = (await api.createWorkspace({ projectId, workerId: old.workerId, rootPath: "/old/app", label: "old" })).workspace!;
      const thread = (await api.createThread({ projectId, workspaceId: ws.id, title: "Old", provider: Provider.CODEX })).thread!;
      const file = (await api.uploadAttachment({ name: "x.txt", data: text("x") })).attachment!;
      expect(await failure(api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: "old-1", attachmentIds: [file.id] }))).toContain("cannot take attachments");
    });
  });

  describe("access to bytes", () => {
    test("an attachment is readable only by its owner", async () => {
      const mine = (await api.uploadAttachment({ name: "mine.txt", data: text("mine") })).attachment!;
      expect((await api.getAttachment({ attachmentId: mine.id })).mimeType).toBe("text/plain");
      const otherUser = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));
      const theirs = await gw.runtime.runPromise(
        AttachmentStore.use((s) => s.create({ ownerUserId: otherUser, name: "theirs.txt", mimeType: "text/plain", kind: "file", data: text("theirs"), sha256: sha(text("theirs")) })),
      );
      expect(await failure(api.getAttachment({ attachmentId: theirs.id }))).toContain("not found");
      expect(await failure(api.getAttachment({ attachmentId: "not-a-uuid" }))).toContain("not found");
      // Nor can it be sent by someone else.
      const thread = await newThread("Theft");
      expect(await failure(api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: "steal", attachmentIds: [theirs.id] }))).toContain("unknown attachment");
    });

    test("a preview the worker uploaded is readable through its thread (and its tree), nothing else", async () => {
      const thread = await newThread("Previews");
      const preview = new Uint8Array(await sharp({ create: { width: 300, height: 200, channels: 3, background: "#123456" } }).webp().toBuffer());
      const digest = sha(preview);
      worker.uploadPreview(digest, preview, "image/webp", 1000);
      const turnId = (await api.sendMessage({ threadId: thread.id, text: "look", clientRequestId: "pv-1" })).turn!.id;
      worker.emit(thread.id, turnId, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "img-1",
            status: ItemStatus.COMPLETED,
            content: { case: "image", value: { path: "/repo/app/shot.png", source: "view_image", blob: { sha256: digest, sizeBytes: BigInt(preview.length), mimeType: "image/webp" }, width: 300, height: 200 } },
          },
        },
      });
      const blob = await eventually(
        () => api.getThreadBlob({ threadId: thread.id, sha256: digest }).catch(() => undefined),
        (b) => b !== undefined,
      );
      expect(blob?.mimeType).toBe("image/webp");
      expect(blob && sha(blob.data)).toBe(digest);
      // Not through another thread, not a blob no item points to, not a corrupted upload.
      const other = await newThread("Elsewhere");
      expect(await failure(api.getThreadBlob({ threadId: other.id, sha256: digest }))).toContain("not found");
      const stray = new Uint8Array(await sharp({ create: { width: 5, height: 5, channels: 3, background: "#000" } }).png().toBuffer());
      worker.uploadPreview(sha(stray), stray, "image/png");
      expect(await failure(api.getThreadBlob({ threadId: thread.id, sha256: sha(stray) }))).toContain("not found");
      const forged = sha(text("forged"));
      worker.uploadPreview(forged, stray, "image/png");
      worker.emit(thread.id, turnId, {
        case: "itemCompleted",
        value: { item: { itemId: "img-2", status: ItemStatus.COMPLETED, content: { case: "image", value: { blob: { sha256: forged, sizeBytes: 5n, mimeType: "image/png" } } } } },
      });
      await Bun.sleep(200);
      expect(await failure(api.getThreadBlob({ threadId: thread.id, sha256: forged }))).toContain("not found");
    });
  });
});
