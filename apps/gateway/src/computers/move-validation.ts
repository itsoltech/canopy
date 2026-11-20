import { createHash } from "node:crypto";
import { bots, type computerLink as link } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { Effect, Predicate, Schema } from "effect";
import { harnessOf } from "../store/instance-config.ts";
import { botRowsJson, JsonRow, MAX_FILES, MoveRefused, threadRowJson, type BotRows, type Sql } from "./move-payload.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminalTurns = new Set(["completed", "failed", "interrupted"]);
const terminalApprovals = new Set(["approved", "discarded", "expired"]);
const absent = (value: JsonValue | undefined) => value == null;

function invalidBot(): never {
  throw new MoveRefused("The bot's move contains inconsistent conversation or routine records.");
}

function indexedRows(rows: BotRows["turns"], id = "id") {
  const index = new Map<string, (typeof rows)[number]>();

  for (const row of rows) {
    const key = row[id];

    if (!Predicate.isString(key) || !UUID.test(key) || index.has(key.toLowerCase())) invalidBot();
    index.set(key.toLowerCase(), row);
  }

  return index;
}

function contains(rows: ReturnType<typeof indexedRows>, key: JsonValue | undefined) {
  return Predicate.isString(key) && rows.has(key.toLowerCase());
}

/** Older exporters selected these tables by bot alone, including rows whose channel turns stayed at the source. */
function privateBotRows(moved: link.BotMove, rows: BotRows) {
  const turns = indexedRows(rows.turns);
  const calls = indexedRows(rows.tool_calls);

  const outside = (index: ReturnType<typeof indexedRows>, value: JsonValue | undefined) =>
    Predicate.isString(value) && UUID.test(value) && !contains(index, value);

  const approvals = rows.approvals.filter(
    (row) => !(row["bot_id"] === rows.bot.id && outside(turns, row["turn_id"]) && outside(calls, row["id"])),
  );

  const handoffs = rows.handoff_notes.filter(
    (row) => !(row["bot_id"] === rows.bot.id && outside(turns, row["turn_id"])),
  );

  const wakeups = rows.wakeups.filter((row) => !(row["bot_id"] === rows.bot.id && outside(calls, row["id"])));
  moved.files = moved.files.filter((file) => {
    const row = movedAttachment(file);

    return !(row["bot_id"] === rows.bot.id && outside(turns, row["bot_turn_id"]));
  });

  if (
    approvals.length === rows.approvals.length &&
    handoffs.length === rows.handoff_notes.length &&
    wakeups.length === rows.wakeups.length
  )
    return rows;
  const scoped = { ...rows, approvals, handoff_notes: handoffs, wakeups };
  moved.rowsJson = JSON.stringify(scoped);

  return scoped;
}

/** Validate the relationships even when a row could satisfy a foreign key on the target. */
function checkBotGraph(prepare: link.MovePrepare, rows: BotRows) {
  const bot = prepare.itemId;
  const turns = indexedRows(rows.turns);
  const routines = indexedRows(rows.routines);
  const calls = indexedRows(rows.tool_calls);
  indexedRows(rows.messages);
  indexedRows(rows.approvals);
  indexedRows(rows.handoff_notes, "turn_id");
  indexedRows(rows.wakeups);

  if (
    rows.bot.id !== bot ||
    [...rows.turns, ...rows.routines, ...rows.messages, ...rows.approvals, ...rows.handoff_notes, ...rows.wakeups].some(
      (row) => row["bot_id"] !== bot,
    ) ||
    rows.turns.some(
      (turn) =>
        !terminalTurns.has(String(turn["status"])) ||
        !absent(turn["conversation_id"]) ||
        (!absent(turn["routine_id"]) && !contains(routines, turn["routine_id"])) ||
        (!absent(turn["steer_target_id"]) && !contains(turns, turn["steer_target_id"])),
    ) ||
    [...rows.messages, ...rows.tool_calls, ...rows.approvals, ...rows.handoff_notes].some(
      (row) => !contains(turns, row["turn_id"]),
    ) ||
    rows.approvals.some(
      (row) =>
        !terminalApprovals.has(String(row["status"])) ||
        calls.get(String(row["id"]).toLowerCase())?.["turn_id"] !== row["turn_id"],
    ) ||
    rows.wakeups.some((row) => !contains(calls, row["id"]))
  )
    invalidBot();
}

/** Retention may already have removed the bytes of an old image. Only verified files can be linked on the new home. */
function movedBotMessages(moved: link.BotMove, rows: BotRows, from = "") {
  const draft = moved.draft;
  const bot = rows.bot.id;
  const turns = indexedRows(rows.turns);

  if (draft?.botId && draft.botId !== bot) invalidBot();
  const draftIds = new Set(draft?.attachments.map((a) => a.id));

  const files = new Map<string, ReturnType<typeof movedAttachment>>();
  const thumbnails = new Set<string>();

  for (const file of moved.files) {
    const row = movedAttachment(file);
    files.set(row.id, row);

    if (file.thumbnail.length) thumbnails.add(row.id);
  }

  for (const row of files.values()) {
    if (
      !absent(row["thread_id"]) ||
      !absent(row["turn_id"]) ||
      (absent(row["bot_id"])
        ? !absent(row["bot_turn_id"]) || !draftIds.has(row.id)
        : row["bot_id"] !== bot || !contains(turns, row["bot_turn_id"]))
    )
      invalidBot();
  }

  if (draft)
    draft.attachments = draft.attachments.filter((attachment) => {
      const row = files.get(attachment.id);

      if (!row) return false;

      if (!absent(row["bot_id"]) || attachment.sha256 !== row.sha256 || attachment.sizeBytes !== BigInt(row.size_bytes))
        invalidBot();
      attachment.hasThumbnail = thumbnails.has(row.id);

      return true;
    });

  const sender = (id: JsonValue | undefined) =>
    from && Predicate.isString(id) && id !== bot ? qualifyId(id, from) : id;

  return rows.messages.map((message) => {
    const attachments = message["attachments"] ?? [];

    if (!Array.isArray(attachments)) invalidBot();

    const available = attachments.flatMap((value) => {
      const attachment = Schema.decodeUnknownSync(JsonRow)(value);
      const row = files.get(String(attachment["id"]));

      if (!row) return [];

      if (
        row["bot_id"] !== bot ||
        row["bot_turn_id"] !== message["turn_id"] ||
        row.sha256 !== attachment["sha256"] ||
        String(row.size_bytes) !== String(attachment["sizeBytes"])
      )
        invalidBot();

      return [{ ...attachment, hasThumbnail: thumbnails.has(row.id), path: "" }];
    });

    return {
      ...message,
      sender_id: sender(message["sender_id"]),
      recipient_id: sender(message["recipient_id"]),
      exchange_id: null,
      attachments: available,
    };
  });
}

const attachmentRow = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    sha256: Schema.String,
    size_bytes: Schema.Union([Schema.String, Schema.Number]),
    thumb_sha256: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  [JsonRow],
);

export const movedAttachment = (file: link.MovedFile) =>
  Schema.decodeUnknownSync(attachmentRow)(JSON.parse(file.attachmentJson));

const visualRow = Schema.StructWithRest(
  Schema.Struct({
    visual_id: Schema.String,
    version: Schema.Int,
    call_id: Schema.String,
    thread_id: Schema.String,
    spec: Schema.String,
    sha256: Schema.String,
  }),
  [JsonRow],
);

export const movedVisual = (json: string) => Schema.decodeUnknownSync(visualRow)(JSON.parse(json));
const scheduleRow = Schema.StructWithRest(Schema.Struct({ id: Schema.String, thread_id: Schema.String }), [JsonRow]);
export const movedSchedule = (json: string) => Schema.decodeUnknownSync(scheduleRow)(JSON.parse(json));

function verifyHash(claim: JsonValue | undefined, bytes: Uint8Array | string) {
  if (claim !== createHash("sha256").update(bytes).digest("hex"))
    throw new MoveRefused("A file in the move does not match its content hash.");
}

/** Runs before staging and again before applying legacy or resumed work. */
export function validateMoveContent(prepare: link.MovePrepare) {
  if (
    !["thread", "bot"].includes(prepare.kind) ||
    (prepare.kind === "thread") !== Boolean(prepare.thread) ||
    (prepare.kind === "bot") !== Boolean(prepare.bot)
  )
    throw new MoveRefused("The move contains an invalid item.");
  const files = prepare.kind === "thread" ? (prepare.thread?.files ?? []) : (prepare.bot?.files ?? []);
  const blobs = prepare.kind === "thread" ? (prepare.thread?.blobs ?? []) : [];
  const total = files.reduce((n, file) => n + file.data.length + file.thumbnail.length, 0);

  if (total + blobs.reduce((n, blob) => n + blob.data.length, 0) > MAX_FILES)
    throw new MoveRefused("The move is too large (over 40 MiB of files).");
  const threadIds = new Set<string>();
  const visualHomes = new Map<string, string>();
  const versions = new Set<string>();
  const calls = new Set<string>();
  const schedules = new Set<string>();

  for (const [index, thread] of (prepare.thread?.threads ?? []).entries()) {
    const row = threadRowJson(thread.rowJson);

    if (
      !UUID.test(row.id) ||
      threadIds.has(row.id) ||
      thread.history?.thread?.id !== row.id ||
      (index === 0
        ? row.id !== prepare.itemId || row.kind !== "main" || row.parent_thread_id !== null
        : row.kind !== "side" || row.parent_thread_id !== prepare.itemId)
    )
      throw new MoveRefused("The move contains an invalid thread family.");
    threadIds.add(row.id);

    for (const visual of thread.visualsJson) {
      const stored = movedVisual(visual);
      const id = stored.visual_id.toLowerCase();
      const call = stored.call_id.toLowerCase();
      const version = `${id}:${stored.version}`;

      if (
        stored.thread_id !== row.id ||
        !UUID.test(id) ||
        !UUID.test(call) ||
        stored.version < 1 ||
        stored.version > 1000 ||
        (visualHomes.has(id) && visualHomes.get(id) !== row.id) ||
        versions.has(version) ||
        calls.has(call)
      )
        throw new MoveRefused("The move contains an invalid visual.");
      verifyHash(stored.sha256, stored.spec);
      visualHomes.set(id, row.id);
      versions.add(version);
      calls.add(call);
    }

    for (const json of thread.schedulesJson) {
      const schedule = movedSchedule(json);
      const id = schedule.id.toLowerCase();

      if (
        !UUID.test(id) ||
        schedules.has(id) ||
        schedule.thread_id !== row.id ||
        schedule["target"] !== "thread" ||
        !["active", "paused"].includes(String(schedule["status"]))
      )
        throw new MoveRefused("The move contains an invalid thread schedule.");
      schedules.add(id);
    }
  }

  if (prepare.thread && !threadIds.size) throw new MoveRefused("The move contains no threads.");
  const attachmentIds = new Set<string>();

  for (const file of files) {
    const row = movedAttachment(file);
    const id = row["id"];
    const size = row["size_bytes"];

    if (!UUID.test(id) || attachmentIds.has(id.toLowerCase()) || String(size) !== String(file.data.length))
      throw new MoveRefused("A file in the move has inconsistent metadata.");

    if (
      prepare.kind === "thread" &&
      (!threadIds.has(String(row["thread_id"])) || !absent(row["bot_id"]) || !absent(row["bot_turn_id"]))
    )
      throw new MoveRefused("A file in the move does not belong to the thread family.");
    attachmentIds.add(id.toLowerCase());
    verifyHash(row["sha256"], file.data);

    // Older sources may advertise a thumbnail whose bytes have already expired.
    if (file.thumbnail.length) verifyHash(row["thumb_sha256"], file.thumbnail);
  }

  for (const blob of blobs) verifyHash(blob.sha256, blob.data);

  if (prepare.bot) {
    const rows = privateBotRows(prepare.bot, botRowsJson(prepare.bot.rowsJson));
    movedBotConfiguration(rows);
    checkBotGraph(prepare, rows);
    movedBotMessages(prepare.bot, rows);
  }
}

function movedBotConfiguration(rows: BotRows) {
  const config = fromJson(bots.BotConfigurationSchema, rows.bot.configuration, { ignoreUnknownFields: true });

  if (harnessOf(config.provider) !== rows.bot.provider || config.providerInstance !== rows.bot.provider_instance)
    throw new MoveRefused("The bot configuration does not match its provider instance.");
  config.workerId = "";
  config.mcpServerIds = [];

  if (config.approvalPolicy !== "always") config.approvalPolicy = "safe";

  if (!["read_only", "ask"].includes(config.threadPermission ?? "")) config.threadPermission = "user_default";

  return toJson(bots.BotConfigurationSchema, config);
}

/** Export and import apply the same limits even when the other computer still uses the previous version. */
export function movedBotRecords(moved: link.BotMove, rows: BotRows, from: string) {
  return {
    ...rows,
    bot: { ...rows.bot, created_by_bot_id: null, configuration: movedBotConfiguration(rows) },
    turns: rows.turns.map((turn) => ({
      ...turn,
      lease_token: null,
      lease_until: null,
      reply_to_bot_id: null,
      remote_recipient_ref: null,
      exchange_id: null,
    })),
    messages: movedBotMessages(moved, rows, from),
    tool_calls: rows.tool_calls.map((call) =>
      ["completed", "interrupted"].includes(String(call["status"]))
        ? call
        : {
            ...call,
            status: "interrupted",
            result: { error: "Action ended at the previous computer." },
          },
    ),
  };
}

/** Admission checked the digest. Correct historical bytes under this key before it grants access here. */
export function insertMovedBlob(sql: Sql, hash: string, data: Uint8Array, mimeType: string) {
  return sql`INSERT INTO blobs(sha256,size_bytes,mime_type,data) VALUES (${hash},${data.length},${mimeType},${data})
    ON CONFLICT (sha256) DO UPDATE SET data=excluded.data, size_bytes=excluded.size_bytes,
      mime_type=excluded.mime_type, storage_url=NULL
    WHERE blobs.data IS DISTINCT FROM excluded.data OR blobs.size_bytes<>excluded.size_bytes`;
}

export function insertMovedFileBytes(sql: Sql, file: link.MovedFile, row: ReturnType<typeof movedAttachment>) {
  return Effect.gen(function* () {
    yield* insertMovedBlob(sql, row.sha256, file.data, file.mimeType);

    if (file.thumbnail.length && row.thumb_sha256)
      yield* insertMovedBlob(sql, row.thumb_sha256, file.thumbnail, file.thumbnailMimeType);
  });
}
