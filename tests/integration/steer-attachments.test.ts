import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MentionKind, Provider, ui, type BlobChunk } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AttachmentStore, GatewayStore } from "@canopy/gateway/store";
import sharp from "sharp";
import { eventually, failure } from "./support/gateway.ts";
import { startInstanceFixture, type InstanceFixture } from "./support/instance-fixture.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe.skipIf(!dockerAvailable)("attachment steers through the worker and harness", () => {
  let f: InstanceFixture;
  let png: Uint8Array;

  beforeAll(async () => {
    f = await startInstanceFixture();
    png = new Uint8Array(
      await sharp({ create: { width: 16, height: 8, channels: 3, background: "#123456" } })
        .png()
        .toBuffer(),
    );
    await f.save(Provider.CODEX, "steer-codex");
    await f.save(Provider.CLAUDE, "steer-claude");
    await f.save(Provider.GROK, "steer-grok");
  }, 60_000);

  afterAll(async () => {
    await f?.close();
  });

  async function running(provider: Provider, label: string) {
    const thread = await f.thread(provider);
    const turn = await f.send(thread.id, `HOLD:${label}`);
    expect(await eventually(async () => f.host.runningTurns().some((t) => t.turnId === turn.id), Boolean)).toBe(true);

    return { thread, turn };
  }

  async function files() {
    const image = (await f.gw.api.uploadAttachment({ name: "shot.png", data: png })).attachment!;
    const file = (await f.gw.api.uploadAttachment({ name: "notes.txt", data: bytes("file content") })).attachment!;

    return [image, file];
  }

  const steers = (threadId: string) =>
    f.query<{ id: string; status: string; queued_turn_id: string; reason: string }>(
      "SELECT id,status,queued_turn_id,reason FROM turn_steers WHERE thread_id=$1 ORDER BY created_at",
      [threadId],
    );

  function holdFiles() {
    const chunks: BlobChunk[] = [];
    const original = f.host.handleBlobChunk.bind(f.host);
    const mocked = spyOn(f.host, "handleBlobChunk").mockImplementation((chunk) => chunks.push(chunk));

    return {
      chunks,
      restore: () => mocked.mockRestore(),
      release: () => {
        mocked.mockRestore();

        for (const chunk of chunks) original(chunk);
      },
    };
  }

  for (const provider of [Provider.CLAUDE, Provider.CODEX]) {
    test(`${Provider[provider]} receives file paths only after the bytes are written`, async () => {
      const name = Provider[provider]!.toLowerCase();
      const { thread, turn } = await running(provider, `${name}-files`);
      const attachments = await files();
      const message = `Inspect [shot.png] and [notes.txt] for ${name}`;
      const gate = holdFiles();

      try {
        const request = {
          threadId: thread.id,
          text: message,
          clientRequestId: crypto.randomUUID(),
          delivery: ui.MessageDelivery.STEER,
          attachmentIds: attachments.map((a) => a.id),
          mentions: attachments.map((a) => ({
            kind: MentionKind.ATTACHMENT,
            name: a.id,
            label: a.name,
            start: message.indexOf(`[${a.name}]`),
            end: message.indexOf(`[${a.name}]`) + a.name.length + 2,
          })),
          quotes: [{ text: "quoted context" }],
        };

        const sent = await f.gw.api.sendMessage(request);
        expect(sent.steer?.attachments.map((a) => a.id)).toEqual(request.attachmentIds);
        expect(await eventually(async () => gate.chunks.length > 0, Boolean)).toBe(true);
        expect(f.inputs().some((r) => r.parts.some((p) => p.text?.includes(`for ${name}`)))).toBe(false);
        gate.release();

        const input = await eventually(
          async () => f.inputs().find((r) => r.parts.some((p) => p.text?.includes(`for ${name}`))),
          Boolean,
        );

        const text = input?.parts.map((p) => p.text ?? "").join("\n") ?? "";
        expect(text).toContain("quoted context");

        for (const attachment of attachments) {
          const path = join(f.host.attachmentsRoot, thread.id, attachment.id, attachment.name);
          expect(text).toContain(path);
          expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(attachment.sha256);
        }

        if (provider === Provider.CODEX) expect(input?.parts.some((p) => p.type === "localImage")).toBe(true);
        expect((await f.gw.api.sendMessage(request)).steer?.id).toBe(sent.steer?.id);
        expect(
          await eventually(
            () => steers(thread.id),
            (s) => s[0]?.status === "delivered",
          ),
        ).toHaveLength(1);
      } finally {
        gate.release();
        await f.release(`${name}-files`);
        await f.finished(thread.id, turn.id);
      }
    }, 25_000);
  }

  test("queue steer delivers its files into the running turn", async () => {
    const { thread, turn } = await running(Provider.CODEX, "queued-files");
    const attachments = await files();

    const queued = (
      await f.gw.api.sendMessage({
        threadId: thread.id,
        text: "queued files",
        clientRequestId: crypto.randomUUID(),
        attachmentIds: attachments.map((a) => a.id),
      })
    ).turn!;

    const sent = await f.gw.api.steerQueuedTurn({ turnId: queued.id });
    expect(sent.steer?.attachments).toHaveLength(2);
    expect(
      await eventually(
        () => steers(thread.id),
        (s) => s[0]?.status === "delivered",
      ),
    ).toHaveLength(1);
    await f.release("queued-files");
    await f.finished(thread.id, turn.id);
  }, 20_000);

  test("a turn ending during file delivery queues the message exactly once with the same files", async () => {
    const { thread, turn } = await running(Provider.CODEX, "files-race");
    const attachments = await files();

    const request = {
      threadId: thread.id,
      text: "after the race",
      clientRequestId: crypto.randomUUID(),
      attachmentIds: attachments.map((a) => a.id),
      delivery: ui.MessageDelivery.STEER,
    };

    const gate = holdFiles();

    try {
      const sent = await f.gw.api.sendMessage(request);
      expect(await eventually(async () => gate.chunks.length > 0, Boolean)).toBe(true);
      await f.release("files-race");
      await f.finished(thread.id, turn.id);
      gate.release();

      const fallback = await eventually(
        () => steers(thread.id),
        (s) => s[0]?.status === "queued",
      );

      expect(fallback[0]?.reason).toContain("turn ended");
      expect((await f.gw.api.sendMessage(request)).steer?.id).toBe(sent.steer?.id);
      await f.finished(thread.id, fallback[0]!.queued_turn_id);
      expect(await f.query("SELECT id FROM turns WHERE thread_id=$1", [thread.id])).toHaveLength(2);
      expect(await f.query("SELECT id FROM attachments WHERE turn_id=$1", [fallback[0]!.queued_turn_id])).toHaveLength(
        2,
      );
      expect(f.inputs().filter((r) => r.parts.some((p) => p.text?.includes("after the race")))).toHaveLength(1);
    } finally {
      gate.release();
    }
  }, 25_000);

  for (const restart of [false, true]) {
    test(`file delivery survives worker ${restart ? "restart" : "disconnect"}`, async () => {
      const label = restart ? "files-restart" : "files-reconnect";
      const { thread, turn } = await running(Provider.CODEX, label);
      const attachments = await files();
      const gate = holdFiles();

      const sent = await f.gw.api.sendMessage({
        threadId: thread.id,
        text: label,
        clientRequestId: crypto.randomUUID(),
        attachmentIds: attachments.map((a) => a.id),
        delivery: ui.MessageDelivery.STEER,
      });

      expect(await eventually(async () => gate.chunks.length > 0, Boolean)).toBe(true);
      gate.restore();
      await f.disconnect();

      if (restart) await f.restartWorker();
      else await f.reconnect();

      const rows = await eventually(
        () => steers(thread.id),
        (s) => ["delivered", "queued"].includes(s[0]?.status ?? ""),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(sent.steer?.id);
      expect(rows[0]?.status).toBe(restart ? "queued" : "delivered");

      if (restart) await f.finished(thread.id, rows[0]!.queued_turn_id);
      else {
        await f.release(label);
        await f.finished(thread.id, turn.id);
      }

      for (const a of attachments) expect(existsSync(join(f.host.attachmentsRoot, thread.id, a.id, a.name))).toBe(true);
    }, 30_000);
  }

  test("Grok refuses steer and runs the files in the next turn", async () => {
    const { thread, turn } = await running(Provider.GROK, "grok-files");
    const attachments = await files();

    const queued = (
      await f.gw.api.sendMessage({
        threadId: thread.id,
        text: "grok file fallback",
        clientRequestId: crypto.randomUUID(),
        attachmentIds: attachments.map((a) => a.id),
      })
    ).turn!;

    await f.gw.api.steerQueuedTurn({ turnId: queued.id });

    const rows = await eventually(
      () => steers(thread.id),
      (s) => s[0]?.status === "queued",
    );

    expect(rows[0]?.queued_turn_id).toBe(queued.id);
    expect(rows[0]?.reason).toContain("Grok");
    await f.release("grok-files");
    await f.finished(thread.id, turn.id);
    await f.finished(thread.id, queued.id);
    const input = f.inputs().find((r) => r.parts.some((p) => p.text?.includes("grok file fallback")));
    expect(input?.parts.some((p) => p.type === "image")).toBe(true);
    expect(input?.parts.map((p) => p.text ?? "").join("\n")).toContain("/notes.txt");
  }, 20_000);

  test("steering cannot claim another owner's upload or expose another thread's bytes", async () => {
    const { thread, turn } = await running(Provider.CODEX, "file-scope");
    const otherUser = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));
    const data = bytes("private file");

    const foreign = await f.gw.runtime.runPromise(
      AttachmentStore.use((s) =>
        s.create({
          ownerUserId: otherUser,
          name: "private.txt",
          mimeType: "text/plain",
          kind: "file",
          data,
          sha256: createHash("sha256").update(data).digest("hex"),
        }),
      ),
    );

    expect(
      await failure(
        f.gw.api.sendMessage({
          threadId: thread.id,
          text: "read",
          clientRequestId: crypto.randomUUID(),
          delivery: ui.MessageDelivery.STEER,
          attachmentIds: [foreign.id],
        }),
      ),
    ).toContain("unknown attachment");
    expect(await steers(thread.id)).toHaveLength(0);
    expect(
      await failure(
        f.gw.runtime.runPromise(AttachmentStore.use((s) => s.workerBlob(f.workerId, thread.id, foreign.sha256))),
      ),
    ).toContain("not found");
    await f.release("file-scope");
    await f.finished(thread.id, turn.id);
  }, 20_000);
});
