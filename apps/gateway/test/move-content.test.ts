import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { botRowsJson } from "../src/computers/move-payload.ts";
import { movedBotRecords, validateMoveContent } from "../src/computers/move-validation.ts";

const hash = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
const id = () => crypto.randomUUID();

function image(parent: { thread_id?: string; bot_id?: string; bot_turn_id?: string }) {
  const data = Uint8Array.of(1, 2, 3);
  const thumbnail = Uint8Array.of(4, 5);
  const row = { id: id(), sha256: hash(data), size_bytes: data.length, thumb_sha256: hash(thumbnail), ...parent };
  const file = create(link.MovedFileSchema, { attachmentJson: JSON.stringify(row), data, thumbnail });

  return { file, row, attachment: { id: row.id, sha256: row.sha256, sizeBytes: data.length } };
}

function botMove() {
  const bot = id();
  const turn = id();
  const call = id();
  const routine = id();
  const bound = image({ bot_id: bot, bot_turn_id: turn });
  const draft = image({});

  const rows = {
    bot: {
      id: bot,
      provider: "codex",
      provider_instance: "native",
      last_read_seq: 1,
      configuration: {
        name: "Moving bot",
        provider: "PROVIDER_CODEX",
        providerInstance: "native",
        approvalPolicy: "always",
        threadPermission: "read_only",
      },
    },
    turns: [{ id: turn, bot_id: bot, routine_id: routine, status: "completed" }],
    messages: [{ id: id(), seq: 1, bot_id: bot, turn_id: turn, attachments: [bound.attachment] }],
    tool_calls: [{ id: call, turn_id: turn, status: "completed" }],
    approvals: [{ id: call, bot_id: bot, turn_id: turn, status: "approved" }],
    handoff_notes: [],
    routines: [{ id: routine, bot_id: bot }],
    wakeups: [],
    grants: [],
    mcp: [],
  };

  const move = create(link.MovePrepareSchema, {
    kind: "bot",
    itemId: bot,
    moveId: id(),
    bot: {
      rowsJson: JSON.stringify(rows),
      files: [bound.file, draft.file],
      draft: { botId: bot, attachments: [{ ...draft.attachment, sizeBytes: BigInt(draft.attachment.sizeBytes) }] },
    },
  });

  return { move, rows };
}

test("a private bot conversation, draft and routine keep their own records and restrictive settings", () => {
  const { move, rows } = botMove();
  validateMoveContent(move);
  const moved = move.bot!;
  const records = movedBotRecords(moved, botRowsJson(moved.rowsJson), "a".repeat(64));
  expect(records.wakeups).toHaveLength(0);
  expect(records.routines).toEqual(rows.routines);
  expect(records.bot.configuration).toMatchObject({ approvalPolicy: "always", threadPermission: "read_only" });
  expect(records.messages[0]?.attachments).toMatchObject(rows.messages[0]!.attachments);
  expect(moved.draft?.attachments).toHaveLength(1);

  moved.files = [];
  validateMoveContent(move);
  expect(moved.draft?.attachments).toEqual([]);
  expect(movedBotRecords(moved, botRowsJson(moved.rowsJson), "a".repeat(64)).messages[0]?.attachments).toEqual([]);
});

test("move admission requires a consistent private bot turn, card and attachment graph", () => {
  for (const field of ["turn", "approval", "attachment"] as const) {
    const { move, rows } = botMove();

    if (field === "turn") rows.messages[0]!.turn_id = id();

    if (field === "approval") rows.approvals[0]!.status = "pending";

    if (field === "attachment") rows.messages[0]!.attachments[0]!.sizeBytes++;
    move.bot!.rowsJson = JSON.stringify(rows);
    expect(() => validateMoveContent(move)).toThrow("inconsistent");
  }
});

test("a legacy export keeps private history when older versions included channel cards and files without their turns", () => {
  const { move, rows } = botMove();
  const moved = move.bot!;
  const otherTurn = id();
  const card = { id: id(), bot_id: move.itemId, turn_id: otherTurn, status: "approved" };
  moved.rowsJson = JSON.stringify({ ...rows, approvals: [...rows.approvals, card] });
  moved.files.push(image({ bot_id: move.itemId, bot_turn_id: otherTurn }).file);
  validateMoveContent(move);
  expect(botRowsJson(moved.rowsJson).approvals).toEqual(rows.approvals);
  expect(moved.files).toHaveLength(2);
});

function threadMove() {
  const thread = id();
  const { file } = image({ thread_id: thread });
  const transcript = Uint8Array.of(6);
  const spec = '{"schema_version":1}';
  const visual = { thread_id: thread, visual_id: id(), call_id: id(), version: 1, spec, sha256: hash(spec) };

  const row = {
    id: thread,
    kind: "main",
    parent_thread_id: null,
    title: "History",
    title_source: "user",
    provider: "codex",
    provider_profile_id: null,
    settings: {},
    cwd: null,
    created_at: "2026-01-01T00:00:00Z",
    archived_at: null,
    runtime: "worker",
    project_id: id(),
    remote_parent_ref: null,
    remote_parent_kind: null,
    last_seq: 1,
  };

  const move = create(link.MovePrepareSchema, {
    kind: "thread",
    itemId: thread,
    moveId: id(),
    thread: {
      files: [file],
      blobs: [{ data: transcript, sha256: hash(transcript) }],
      threads: [
        { rowJson: JSON.stringify(row), history: { thread: { id: thread } }, visualsJson: [JSON.stringify(visual)] },
      ],
    },
  });

  return { move, visual };
}

test("file bytes, thumbnails, transcript blobs and visual specifications use their own content hashes", () => {
  for (const part of ["file", "thumbnail", "blob", "visual"] as const) {
    const { move, visual } = threadMove();
    validateMoveContent(move);
    const thread = move.thread!;

    if (part === "file") thread.files[0]!.data = Uint8Array.of(1, 2, 4);

    if (part === "thumbnail") thread.files[0]!.thumbnail = Uint8Array.of(4, 6);

    if (part === "blob") thread.blobs[0]!.data = Uint8Array.of(7);

    if (part === "visual") thread.threads[0]!.visualsJson = [JSON.stringify({ ...visual, spec: visual.spec + "\n" })];
    expect(() => validateMoveContent(move)).toThrow("content hash");
  }
});
