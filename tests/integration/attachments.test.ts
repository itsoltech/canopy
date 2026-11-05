/**
 * Attachments end to end on PostgreSQL (docs/ui-api.md, "Załączniki"; docs/protocol.md, "Załączniki"):
 * upload (limits, type from the content, images cleaned) -> a message -> the platform note with worker paths ->
 * StartTurn with the files -> the worker fetches the bytes (only its own threads') -> previews the worker uploads
 * -> the owner reads them through the thread.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Client } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { ItemStatus, MentionKind, MentionSchema, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AttachmentStore, GatewayStore } from "@canopy/gateway/store";
import sharp from "sharp";
import {
  eventually,
  failure,
  SCRIPTED_ATTACHMENTS_ROOT,
  startTestGateway,
  watchUntil,
  type ScriptedWorker,
  type TestGateway,
} from "./support/gateway.ts";

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
    workspaceId = (await api.createWorkspace({ projectId, workerId, rootPath: "/repo/app", label: "laptop" }))
      .workspace!.id;
    // The worker reported its attachments root in Hello.
    await eventually(
      () => gw.runtime.runPromise(AttachmentStore.use((s) => s.workerRoot(workerId))),
      (r) => r.root !== "",
    );
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  const newThread = async (title: string) => {
    const thread = (await api.createThread({ projectId, workspaceId, title, provider: Provider.CODEX })).thread!;
    await eventually(
      () => api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );

    return thread;
  };

  describe("upload: limits and the type from the content", () => {
    test("a PNG named .txt is an image; it gets a thumbnail and its dimensions", async () => {
      const png = new Uint8Array(
        await sharp({ create: { width: 64, height: 32, channels: 4, background: "#ff000080" } })
          .png()
          .toBuffer(),
      );

      const { attachment } = await api.uploadAttachment({ name: "notes.txt", data: png });
      expect(attachment).toMatchObject({
        kind: "image",
        mimeType: "image/png",
        width: 64,
        height: 32,
        hasThumbnail: true,
        name: "notes.txt",
      });
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

      const svg = await api.uploadAttachment({
        name: "logo.svg",
        data: text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      });

      expect(svg.attachment).toMatchObject({ kind: "file", mimeType: "image/svg+xml", hasThumbnail: false });
    });

    test("programs, empty files and files over the limit are refused with a reason", async () => {
      expect(
        await failure(api.uploadAttachment({ name: "tool", data: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]) })),
      ).toContain("program");
      expect(await failure(api.uploadAttachment({ name: "setup.pdf", data: text("MZ\x90\0\x03") }))).toContain(
        "program",
      );
      expect(await failure(api.uploadAttachment({ name: "empty.txt", data: new Uint8Array() }))).toContain("empty");
      expect(
        await failure(api.uploadAttachment({ name: "big.txt", data: new Uint8Array(200_001).fill(65) })),
      ).toContain("up to 195.3 KB");
    });

    test("names lose directories and control characters", async () => {
      const { attachment } = await api.uploadAttachment({ name: "../../etc/pass\u0000wd", data: text("x") });
      expect(attachment?.name).toBe("passwd");
    });

    test("the limits are part of the settings the UI reads", async () => {
      const settings = await api.getSettings({});
      expect(settings.attachmentLimits).toMatchObject({
        maxFileBytes: 200_000n,
        maxMessageBytes: 300_000n,
        maxFiles: 3,
      });
    });
  });

  describe("a message with attachments", () => {
    test("the agent gets the platform note with each file's path on its worker; the worker fetches the bytes", async () => {
      const thread = await newThread("Look at this");

      const image = new Uint8Array(
        await sharp({ create: { width: 30, height: 10, channels: 3, background: "#00ff00" } })
          .png()
          .toBuffer(),
      );

      const shot = (await api.uploadAttachment({ name: "screen shot.png", data: image })).attachment!;
      const notes = (await api.uploadAttachment({ name: "notes.md", data: text("# Notes\nhello") })).attachment!;

      const sent = await api.sendMessage({
        threadId: thread.id,
        text: "What is in these?",
        clientRequestId: "att-1",
        attachmentIds: [shot.id, notes.id],
      });

      const turn = sent.turn!;
      const shotPath = `${SCRIPTED_ATTACHMENTS_ROOT}/${thread.id}/${shot.id}/screen shot.png`;
      const notesPath = `${SCRIPTED_ATTACHMENTS_ROOT}/${thread.id}/${notes.id}/notes.md`;
      expect(turn.messageText).toBe("What is in these?");
      expect(turn.platformNote).toStartWith("[canopy] The user attached 2 files");
      expect(turn.platformNote).toContain(`- ${shotPath} (image/png,`);
      expect(turn.platformNote).toContain("30×10 px");
      expect(turn.platformNote).toContain(`- ${notesPath} (text/markdown, 13 B)`);
      expect(turn.inputText).toBe(`${turn.platformNote}\n\nWhat is in these?`);
      expect(turn.attachments.map((a) => [a.name, a.kind])).toEqual([
        ["screen shot.png", "image"],
        ["notes.md", "file"],
      ]);

      const started = await eventually(
        async () => worker.attachments.get(turn.id),
        (a) => a !== undefined,
      );

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
      const retry = await api.sendMessage({
        threadId: thread.id,
        text: "What is in these?",
        clientRequestId: "att-1",
        attachmentIds: [shot.id, notes.id],
      });

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
      expect(
        await failure(
          api.sendMessage({ threadId: thread.id, text: "again", clientRequestId: "lim-2", attachmentIds: [a.id] }),
        ),
      ).toContain("already sent");

      const files = await Promise.all(
        ["1", "2", "3", "4"].map(
          async (n) => (await api.uploadAttachment({ name: `${n}.txt`, data: text(n) })).attachment!,
        ),
      );

      expect(
        await failure(
          api.sendMessage({
            threadId: thread.id,
            text: "many",
            clientRequestId: "lim-3",
            attachmentIds: files.map((f) => f.id),
          }),
        ),
      ).toContain("up to 3 files");

      const big = await Promise.all(
        ["x", "y"].map(
          async (n) =>
            (await api.uploadAttachment({ name: `${n}.bin`, data: new Uint8Array(160_000).fill(1) })).attachment!,
        ),
      );

      expect(
        await failure(
          api.sendMessage({
            threadId: thread.id,
            text: "heavy",
            clientRequestId: "lim-4",
            attachmentIds: big.map((f) => f.id),
          }),
        ),
      ).toContain("a message can carry up to");
      expect(
        await failure(
          api.sendMessage({
            threadId: thread.id,
            text: "x",
            clientRequestId: "lim-5",
            attachmentIds: ["0196f0c1-0000-7000-8000-000000000000"],
          }),
        ),
      ).toContain("unknown attachment");
    });

    test("a steer with attachments runs as the next turn", async () => {
      const thread = await newThread("Steer");
      worker.holdTurns = true;
      const first = await api.sendMessage({ threadId: thread.id, text: "work", clientRequestId: "st-1" });
      await eventually(
        () => api.getThread({ threadId: thread.id }),
        (r) => r.thread?.status === "running",
      );
      const file = (await api.uploadAttachment({ name: "more.txt", data: text("more") })).attachment!;

      const steered = await api.sendMessage({
        threadId: thread.id,
        text: "also this",
        clientRequestId: "st-2",
        attachmentIds: [file.id],
        delivery: ui.MessageDelivery.STEER,
      });

      expect(steered.steer).toBeUndefined();
      expect(steered.turn?.status).toBe("queued");
      worker.holdTurns = false;
      worker.finish(thread.id, first.turn!.id);
    });

    test("a new thread's first message can carry attachments", async () => {
      const file = (await api.uploadAttachment({ name: "brief.txt", data: text("the brief") })).attachment!;

      const thread = (
        await api.createThread({
          projectId,
          workspaceId,
          title: "Brief",
          provider: Provider.CODEX,
          initialMessage: "Read the brief",
          initialAttachmentIds: [file.id],
          clientRequestId: "ct-att",
        })
      ).thread!;

      const turnId = await eventually(
        async () =>
          [...worker.attachments.entries()].find(([, list]) => list.some((a) => a.attachmentId === file.id))?.[0],
        (id) => id !== undefined,
      );

      expect(turnId).toBeDefined();
      expect(worker.inputs.get(thread.id)?.[0]).toContain(
        `${SCRIPTED_ATTACHMENTS_ROOT}/${thread.id}/${file.id}/brief.txt`,
      );
      expect(worker.inputs.get(thread.id)?.[0]).toEndWith("\n\nRead the brief");
    });

    test("a worker that did not report an attachments root cannot take them", async () => {
      const old = await gw.addWorker("old", ["/old"]);
      await gw.connect(old.workerId, old.credential, undefined, { hello: { attachmentsRoot: "" } });

      const ws = (await api.createWorkspace({ projectId, workerId: old.workerId, rootPath: "/old/app", label: "old" }))
        .workspace!;

      const thread = (await api.createThread({ projectId, workspaceId: ws.id, title: "Old", provider: Provider.CODEX }))
        .thread!;

      const file = (await api.uploadAttachment({ name: "x.txt", data: text("x") })).attachment!;
      expect(
        await failure(
          api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: "old-1", attachmentIds: [file.id] }),
        ),
      ).toContain("cannot take attachments");
    });
  });

  describe("access to bytes", () => {
    test("an attachment is readable only by its owner", async () => {
      const mine = (await api.uploadAttachment({ name: "mine.txt", data: text("mine") })).attachment!;
      expect((await api.getAttachment({ attachmentId: mine.id })).mimeType).toBe("text/plain");
      const otherUser = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));

      const theirs = await gw.runtime.runPromise(
        AttachmentStore.use((s) =>
          s.create({
            ownerUserId: otherUser,
            name: "theirs.txt",
            mimeType: "text/plain",
            kind: "file",
            data: text("theirs"),
            sha256: sha(text("theirs")),
          }),
        ),
      );

      expect(await failure(api.getAttachment({ attachmentId: theirs.id }))).toContain("not found");
      expect(await failure(api.getAttachment({ attachmentId: "not-a-uuid" }))).toContain("not found");
      // Nor can it be sent by someone else.
      const thread = await newThread("Theft");
      expect(
        await failure(
          api.sendMessage({ threadId: thread.id, text: "x", clientRequestId: "steal", attachmentIds: [theirs.id] }),
        ),
      ).toContain("unknown attachment");
    });

    test("a preview the worker uploaded is readable through its thread (and its tree), nothing else", async () => {
      const thread = await newThread("Previews");

      const preview = new Uint8Array(
        await sharp({ create: { width: 300, height: 200, channels: 3, background: "#123456" } })
          .webp()
          .toBuffer(),
      );

      const digest = sha(preview);
      worker.uploadPreview(digest, preview, "image/webp", 1000);
      const turnId = (await api.sendMessage({ threadId: thread.id, text: "look", clientRequestId: "pv-1" })).turn!.id;
      worker.emit(thread.id, turnId, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "img-1",
            status: ItemStatus.COMPLETED,
            content: {
              case: "image",
              value: {
                path: "/repo/app/shot.png",
                source: "view_image",
                blob: { sha256: digest, sizeBytes: BigInt(preview.length), mimeType: "image/webp" },
                width: 300,
                height: 200,
              },
            },
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

      const stray = new Uint8Array(
        await sharp({ create: { width: 5, height: 5, channels: 3, background: "#000" } })
          .png()
          .toBuffer(),
      );

      worker.uploadPreview(sha(stray), stray, "image/png");
      expect(await failure(api.getThreadBlob({ threadId: thread.id, sha256: sha(stray) }))).toContain("not found");
      const forged = sha(text("forged"));
      worker.uploadPreview(forged, stray, "image/png");
      worker.emit(thread.id, turnId, {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "img-2",
            status: ItemStatus.COMPLETED,
            content: { case: "image", value: { blob: { sha256: forged, sizeBytes: 5n, mimeType: "image/png" } } },
          },
        },
      });
      await Bun.sleep(200);
      expect(await failure(api.getThreadBlob({ threadId: thread.id, sha256: forged }))).toContain("not found");
    });
  });
  describe('placed in the text (docs/ui-api.md, "Załączniki w tekście")', () => {
    /** A badge: the placeholder "[name]" at `start` of `text`. */
    const badge = (text: string, id: string, name: string) => {
      const start = text.indexOf(`[${name}]`);

      return create(MentionSchema, {
        kind: MentionKind.ATTACHMENT,
        name: id,
        label: name,
        start,
        end: start + name.length + 2,
      });
    };

    const snapshotOf = async (threadId: string) => {
      const updates = await watchUntil(api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));

      return updates.find((u) => u.change.case === "snapshot")?.change.value as ui.ThreadSnapshot;
    };

    test("the agent gets numbered markers where the user put the files; the turn keeps the positions", async () => {
      const thread = await newThread("Inline");
      const loose = (await api.uploadAttachment({ name: "loose.txt", data: text("loose") })).attachment!;
      const plik = (await api.uploadAttachment({ name: "plik.txt", data: text("hello") })).attachment!;

      const png = new Uint8Array(
        await sharp({ create: { width: 8, height: 4, channels: 3, background: "#ff0000" } })
          .png()
          .toBuffer(),
      );

      const image = (await api.uploadAttachment({ name: "obrazek.png", data: png })).attachment!;
      const message = "hey, the file: [plik.txt] and the image: [obrazek.png], analyse them";

      const turn = (
        await api.sendMessage({
          threadId: thread.id,
          text: message,
          clientRequestId: "inline-1",
          attachmentIds: [loose.id, image.id, plik.id],
          mentions: [badge(message, image.id, "obrazek.png"), badge(message, plik.id, "plik.txt")],
        })
      ).turn!;

      // The user's message and its badges as written; placed files first, in their order, then the rest.
      expect(turn.messageText).toBe(message);
      expect(turn.mentions.map((m) => [m.kind, m.name, m.source, message.slice(m.start, m.end)])).toEqual([
        [MentionKind.ATTACHMENT, plik.id, "file", "[plik.txt]"],
        [MentionKind.ATTACHMENT, image.id, "image", "[obrazek.png]"],
      ]);
      expect(turn.attachments.map((a) => a.name)).toEqual(["plik.txt", "obrazek.png", "loose.txt"]);
      const path = (id: string, name: string) => `${SCRIPTED_ATTACHMENTS_ROOT}/${thread.id}/${id}/${name}`;
      expect(turn.platformNote).toContain(
        "Each [Attachment N: name] in the message marks where the user put that file",
      );
      expect(turn.platformNote).toContain(`- Attachment 1: ${path(plik.id, "plik.txt")} (text/plain, 5 B)`);
      expect(turn.platformNote).toContain(`- Attachment 2: ${path(image.id, "obrazek.png")} (image/png,`);
      expect(turn.platformNote).toContain(`- Attachment 3: ${path(loose.id, "loose.txt")} (text/plain, 5 B)`);

      const delivered =
        "hey, the file: [Attachment 1: plik.txt] and the image: [Attachment 2: obrazek.png], analyse them";

      expect(turn.inputText).toBe(`${turn.platformNote}\n\n${delivered}`);

      // The worker gets the same text, the files in the note's order and the markers' ranges.
      const started = await eventually(
        async () => worker.started.get(turn.id),
        (input) => input !== undefined,
      );

      expect(started!.text).toBe(turn.inputText);
      expect(started!.attachments.map((a) => a.attachmentId)).toEqual([plik.id, image.id, loose.id]);
      expect(started!.mentions.map((m) => [m.name, started!.text.slice(m.start, m.end)])).toEqual([
        [plik.id, "[Attachment 1: plik.txt]"],
        [image.id, "[Attachment 2: obrazek.png]"],
      ]);

      // A reload (snapshot) and a fork at this turn keep the positions.
      await eventually(
        async () => (await snapshotOf(thread.id)).turns.find((t) => t.id === turn.id)?.status,
        (status) => status === "completed",
      );
      const reloaded = (await snapshotOf(thread.id)).turns.find((t) => t.id === turn.id)!;
      expect(reloaded.mentions).toEqual(turn.mentions);
      expect(reloaded.attachments.map((a) => a.id)).toEqual([plik.id, image.id, loose.id]);
      const fork = (await api.createThread({ forkThreadId: thread.id, forkAtTurnId: turn.id })).thread!;
      const inherited = (await snapshotOf(fork.id)).turns.find((t) => t.id === turn.id)!;
      expect([inherited.messageText, inherited.mentions, inherited.inputText]).toEqual([
        message,
        turn.mentions,
        turn.inputText,
      ]);
    });

    test("a message without positions keeps the note as it always was", async () => {
      const thread = await newThread("Old format");
      const file = (await api.uploadAttachment({ name: "old.txt", data: text("old") })).attachment!;

      const turn = (
        await api.sendMessage({
          threadId: thread.id,
          text: "[old.txt] as text",
          clientRequestId: "inline-old",
          attachmentIds: [file.id],
        })
      ).turn!;

      expect(turn.mentions).toEqual([]);
      expect(turn.platformNote).not.toContain("Attachment 1");
      expect(turn.platformNote).toContain(
        `- ${SCRIPTED_ATTACHMENTS_ROOT}/${thread.id}/${file.id}/old.txt (text/plain, 3 B)`,
      );
      expect(turn.inputText).toEndWith("\n\n[old.txt] as text");
    });

    test("a badge names only a file of its own message, once; never another user's file", async () => {
      const thread = await newThread("Badges");
      const mine = (await api.uploadAttachment({ name: "mine.txt", data: text("mine") })).attachment!;
      const unsent = (await api.uploadAttachment({ name: "other.txt", data: text("other") })).attachment!;
      const otherUser = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("badges@localhost", "B")));

      const theirs = await gw.runtime.runPromise(
        AttachmentStore.use((s) =>
          s.create({
            ownerUserId: otherUser,
            name: "theirs.txt",
            mimeType: "text/plain",
            kind: "file",
            data: text("theirs"),
            sha256: sha(text("theirs")),
          }),
        ),
      );

      const send = (id: string, mentions: ReturnType<typeof badge>[], attachmentIds = [mine.id]) =>
        failure(
          api.sendMessage({
            threadId: thread.id,
            text: "see [mine.txt] and [x]",
            clientRequestId: id,
            attachmentIds,
            mentions,
          }),
        );

      const message = "see [mine.txt] and [x]";

      const other = (id: string) =>
        create(MentionSchema, { kind: MentionKind.ATTACHMENT, name: id, label: "x", start: 19, end: 22 });

      expect(await send("b-1", [badge(message, mine.id, "mine.txt"), other(unsent.id)])).toContain(
        "not attached to it",
      );
      expect(await send("b-2", [badge(message, mine.id, "mine.txt"), other(theirs.id)])).toContain(
        "not attached to it",
      );
      expect(await send("b-3", [badge(message, mine.id, "mine.txt"), other(mine.id)])).toContain("more than once");
      expect(await send("b-4", [other(theirs.id)], [theirs.id])).toContain("unknown attachment");
      // The worker never got another user's file.
      expect([...worker.attachments.values()].flat().some((a) => a.attachmentId === theirs.id)).toBe(false);
    });

    test("editing a queued message: a file lives with its badge", async () => {
      const thread = await newThread("Queue edit");
      worker.holdTurns = true;
      const first = (await api.sendMessage({ threadId: thread.id, text: "work", clientRequestId: "qe-1" })).turn!;
      const a = (await api.uploadAttachment({ name: "a.txt", data: text("a") })).attachment!;
      const b = (await api.uploadAttachment({ name: "b.txt", data: text("b") })).attachment!;
      const message = "[a.txt] then [b.txt]";

      const queued = (
        await api.sendMessage({
          threadId: thread.id,
          text: message,
          clientRequestId: "qe-2",
          attachmentIds: [a.id, b.id],
          mentions: [badge(message, a.id, "a.txt"), badge(message, b.id, "b.txt")],
        })
      ).turn!;

      // b's badge moves to the front, a's goes: a leaves the message, b is Attachment 1 now.
      const edited = "[b.txt] only";

      const { turn } = await api.editQueuedTurn({
        turnId: queued.id,
        text: edited,
        expectedRevision: queued.revision,
        mentions: [badge(edited, b.id, "b.txt")],
      });

      expect(turn!.attachments.map((x) => x.id)).toEqual([b.id]);
      expect(turn!.mentions.map((m) => [m.name, edited.slice(m.start, m.end)])).toEqual([[b.id, "[b.txt]"]]);
      expect(turn!.inputText).toEndWith("\n\n[Attachment 1: b.txt] only");
      expect(turn!.platformNote).toContain(`- Attachment 1: ${SCRIPTED_ATTACHMENTS_ROOT}/${thread.id}/${b.id}/b.txt`);
      expect(turn!.platformNote).not.toContain("a.txt");
      worker.holdTurns = false;
      worker.finish(thread.id, first.id);
    });

    test("a queue edit with structured positions keeps, reorders and drops placed files", async () => {
      const thread = await newThread("Queue positions");
      worker.holdTurns = true;
      const first = (await api.sendMessage({ threadId: thread.id, text: "work", clientRequestId: "qp-1" })).turn!;

      const [a, b, c] = await Promise.all(
        ["a.txt", "b.txt", "c.txt"].map(
          async (name) => (await api.uploadAttachment({ name, data: text(name) })).attachment!,
        ),
      );

      const message = "[a.txt] [b.txt] [c.txt]";

      const queued = (
        await api.sendMessage({
          threadId: thread.id,
          text: message,
          clientRequestId: "qp-2",
          attachmentIds: [a!.id, b!.id, c!.id],
          mentions: [badge(message, a!.id, "a.txt"), badge(message, b!.id, "b.txt"), badge(message, c!.id, "c.txt")],
        })
      ).turn!;

      // c moves to the front, a stays after it, b's badge is gone: the order follows the text, b leaves.
      const edited = "first [c.txt], then [a.txt]";

      const { turn } = await api.editQueuedTurn({
        turnId: queued.id,
        text: edited,
        expectedRevision: queued.revision,
        mentions: [badge(edited, c!.id, "c.txt"), badge(edited, a!.id, "a.txt")],
        mentionsComplete: true,
      });

      expect(turn!.attachments.map((x) => x.name)).toEqual(["c.txt", "a.txt"]);
      expect(turn!.mentions.map((m) => [m.name, edited.slice(m.start, m.end)])).toEqual([
        [c!.id, "[c.txt]"],
        [a!.id, "[a.txt]"],
      ]);
      expect(turn!.inputText).toEndWith("\n\nfirst [Attachment 1: c.txt], then [Attachment 2: a.txt]");

      // Every badge removed, in the editor's whole set: the placed files leave, the text alone stays.
      const { turn: bare } = await api.editQueuedTurn({
        turnId: queued.id,
        text: "just text",
        expectedRevision: turn!.revision,
        mentions: [],
        mentionsComplete: true,
      });

      expect([bare!.attachments.length, bare!.mentions.length, bare!.platformNote]).toEqual([0, 0, ""]);
      worker.holdTurns = false;
      worker.finish(thread.id, first.id);
    });

    test("an older client's plain-text queue edit keeps the badges it left in the text", async () => {
      const thread = await newThread("Queue plain text");
      worker.holdTurns = true;
      const first = (await api.sendMessage({ threadId: thread.id, text: "work", clientRequestId: "qo-1" })).turn!;
      const a = (await api.uploadAttachment({ name: "a.txt", data: text("a") })).attachment!;
      const b = (await api.uploadAttachment({ name: "b.txt", data: text("b") })).attachment!;
      const message = "[a.txt] and [b.txt]";

      const queued = (
        await api.sendMessage({
          threadId: thread.id,
          text: message,
          clientRequestId: "qo-2",
          attachmentIds: [a.id, b.id],
          mentions: [badge(message, a.id, "a.txt"), badge(message, b.id, "b.txt")],
        })
      ).turn!;

      // No mentions and no flag: the gateway finds the badges' markers again; "[a.txt]" was deleted as text.
      const { turn } = await api.editQueuedTurn({
        turnId: queued.id,
        text: "only [b.txt] now",
        expectedRevision: queued.revision,
      });

      expect(turn!.mentions.map((m) => [m.name, m.start, m.end])).toEqual([[b.id, 5, 12]]);
      expect(turn!.attachments.map((x) => x.name)).toEqual(["b.txt"]);
      worker.holdTurns = false;
      worker.finish(thread.id, first.id);
    });
  });
});
