import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";
import { threadBlobAccess } from "../../../apps/gateway/src/store/thread-blob-access.ts";

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Long enough for MIME base64 to span several lines. */
const bytes = (n: number) => Buffer.from(`synthetic image ${n} `.repeat(12));
const wrapped = (data: Buffer) => data.toString("base64").replace(/.{76}/g, "$&\n");

// The raw provider event shapes the worker records, one per harness.
const session = { threadId: "codex-thread", turnId: "codex-turn" };

const codex = (id: string, data: Buffer, ids?: typeof session) => ({
  method: "rawResponseItem/completed",
  params: {
    ...ids,
    item: {
      type: "function_call_output",
      call_id: id,
      output: [{ type: "input_image", image_url: `data:image/png;base64,${data.toString("base64")}` }],
    },
  },
});

/** What an older worker stored on the item_completed event once the bytes moved out of it. */
const compacted = (id: string, data: Buffer, ids?: typeof session) => ({
  method: "rawResponseItem/completed",
  params: {
    ...ids,
    item: {
      type: "function_call_output",
      call_id: id,
      output: [
        {
          type: "input_image",
          image_url: {
            canopyBlob: { sha256: sha(data), sizeBytes: String(data.length), mimeType: "image/png" },
            dataUrlPrefix: "data:image/png;base64,",
          },
        },
      ],
    },
  },
});

const codexDynamic = (id: string, data: Buffer) => ({
  method: "item/completed",
  params: {
    item: { id, contentItems: [{ type: "inputImage", imageUrl: `data:image/png;base64,${data.toString("base64")}` }] },
  },
});

const claude = (id: string, base64: string) => ({
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }],
      },
    ],
  },
});

const grok = (id: string, data: Buffer) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id.split(":").at(-1),
  content: [{ type: "content", content: { type: "image", data: data.toString("base64"), mimeType: "image/png" } }],
});

interface Case {
  name: string;
  /** The item shows its image either as `image.blob` or among `toolCall.images`. */
  shape: "image" | "images";
  provider?: "claude" | "codex" | "grok";
  owner?: "a" | "b";
  /** The bytes the item's hash stands for. */
  data: Buffer;
  /** What the store actually holds under that hash; absent when another tree already uploaded it. */
  stored?: Buffer | "shared";
  storedSize?: number;
  itemId: string;
  raw: unknown;
  origin?: "worker" | "gateway";
  projection?: boolean;
  /** ToolCall.output as the worker stored it (a serialized MCP result, or plain text). */
  output?: string;
  /** A second, provider_raw event of an older worker, in this server thread or (elsewhere) in another one. */
  companion?: { raw: unknown; elsewhere?: boolean };
  verified: boolean;
}

const shared = bytes(1);

const cases: Case[] = [
  {
    name: "codex code mode",
    shape: "image",
    data: shared,
    itemId: "call-1",
    raw: codex("call-1", shared),
    verified: true,
  },
  {
    name: "codex dynamic tool",
    shape: "image",
    data: bytes(2),
    itemId: "dyn-1",
    raw: codexDynamic("dyn-1", bytes(2)),
    verified: true,
  },
  {
    name: "claude tool result, base64 wrapped every 76 characters",
    shape: "images",
    data: bytes(3),
    itemId: "toolu-1",
    raw: claude("toolu-1", wrapped(bytes(3))),
    verified: true,
  },
  {
    name: "grok tool_call_update with a prefixed item id",
    shape: "images",
    provider: "grok",
    data: bytes(4),
    itemId: "turn-1:tc-9",
    raw: grok("turn-1:tc-9", bytes(4)),
    verified: true,
  },
  {
    name: "historical item without a current projection",
    shape: "image",
    data: bytes(5),
    itemId: "call-2",
    raw: codex("call-2", bytes(5)),
    projection: false,
    verified: true,
  },
  // Negatives: nothing here may grant access.
  {
    name: "same public hash in another tree of the owner, no bytes of its own",
    shape: "image",
    data: shared,
    stored: "shared",
    itemId: "call-3",
    raw: { method: "rawResponseItem/completed", params: { item: { call_id: "call-3", output: [] } } },
    verified: false,
  },
  {
    name: "same public hash in another account's tree, no bytes of its own",
    shape: "images",
    owner: "b",
    data: shared,
    stored: "shared",
    itemId: "toolu-2",
    raw: null,
    verified: false,
  },
  {
    name: "compacted raw with only a canopyBlob marker",
    shape: "image",
    data: bytes(6),
    itemId: "call-4",
    raw: compacted("call-4", bytes(6)),
    verified: false,
  },
  {
    name: "inline bytes differ from the referenced hash",
    shape: "image",
    data: bytes(7),
    itemId: "call-5",
    raw: codex("call-5", bytes(8)),
    verified: false,
  },
  {
    name: "corrupted base64",
    shape: "images",
    data: bytes(9),
    itemId: "toolu-3",
    raw: claude("toolu-3", `${bytes(9).toString("base64").slice(0, 20)}!!##`),
    verified: false,
  },
  {
    name: "stored bytes do not match their hash",
    shape: "image",
    data: bytes(10),
    stored: bytes(11),
    itemId: "call-6",
    raw: codex("call-6", bytes(10)),
    verified: false,
  },
  {
    name: "inline bytes belong to another tool call",
    shape: "images",
    data: bytes(12),
    itemId: "toolu-4",
    raw: claude("toolu-other", bytes(12).toString("base64")),
    verified: false,
  },
  {
    name: "gateway-origin event",
    shape: "image",
    data: bytes(13),
    itemId: "call-7",
    raw: codex("call-7", bytes(13)),
    origin: "gateway",
    verified: false,
  },
  // Older Codex workers: item_completed kept a canopyBlob marker, a separate provider_raw event kept the bytes.
  {
    name: "codex compacted item with its provider_raw original in the same thread and session",
    shape: "images",
    provider: "codex",
    data: bytes(14),
    itemId: "call-8",
    raw: compacted("call-8", bytes(14), session),
    companion: { raw: codex("call-8", bytes(14), session) },
    verified: true,
  },
  {
    name: "codex original from another session",
    shape: "images",
    provider: "codex",
    data: bytes(15),
    itemId: "call-9",
    raw: compacted("call-9", bytes(15), session),
    companion: { raw: codex("call-9", bytes(15), { ...session, threadId: "other-codex-thread" }) },
    verified: false,
  },
  {
    name: "codex original from another turn",
    shape: "images",
    provider: "codex",
    data: bytes(16),
    itemId: "call-10",
    raw: compacted("call-10", bytes(16), session),
    companion: { raw: codex("call-10", bytes(16), { ...session, turnId: "other-codex-turn" }) },
    verified: false,
  },
  {
    name: "codex original of another call",
    shape: "images",
    provider: "codex",
    data: bytes(17),
    itemId: "call-11",
    raw: compacted("call-11", bytes(17), session),
    companion: { raw: codex("other-call", bytes(17), session) },
    verified: false,
  },
  {
    name: "codex events with an empty session id",
    shape: "images",
    provider: "codex",
    data: bytes(18),
    itemId: "call-12",
    raw: compacted("call-12", bytes(18), { ...session, threadId: "" }),
    companion: { raw: codex("call-12", bytes(18), { ...session, threadId: "" }) },
    verified: false,
  },
  {
    name: "codex events with an empty turn id",
    shape: "images",
    provider: "codex",
    data: bytes(19),
    itemId: "call-13",
    raw: compacted("call-13", bytes(19), { ...session, turnId: "" }),
    companion: { raw: codex("call-13", bytes(19), { ...session, turnId: "" }) },
    verified: false,
  },
  {
    name: "codex original stored in another server thread",
    shape: "images",
    provider: "codex",
    data: bytes(20),
    itemId: "call-14",
    raw: compacted("call-14", bytes(20), session),
    companion: { raw: codex("call-14", bytes(20), session), elsewhere: true },
    verified: false,
  },
  // toolCall.output of a worker event: MCP image blocks serialized as JSON, with no raw event at all.
  {
    name: "serialized MCP image blocks in toolCall.output",
    shape: "images",
    data: bytes(21),
    itemId: "toolu-5",
    raw: null,
    output: JSON.stringify([{ type: "image", data: bytes(21).toString("base64"), mimeType: "image/png" }]),
    verified: true,
  },
  {
    name: "plain text in toolCall.output",
    shape: "images",
    data: bytes(22),
    itemId: "toolu-6",
    raw: null,
    output: "The tool printed text, not images.",
    verified: false,
  },
  {
    name: "malformed JSON in toolCall.output",
    shape: "images",
    data: bytes(23),
    itemId: "toolu-7",
    raw: null,
    output: `[{"type":"image","data":"${bytes(23).toString("base64").slice(0, 30)}`,
    verified: false,
  },
  {
    name: "Grok MCP result serialized in rawOutput",
    shape: "images",
    provider: "grok",
    data: bytes(24),
    itemId: "turn-1:tc-10",
    raw: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-10",
      rawOutput: JSON.stringify({
        result: { content: [{ type: "image", mimeType: "image/png", data: wrapped(bytes(24)) }] },
      }),
    },
    verified: true,
  },
  {
    name: "stored length is inconsistent with the image",
    shape: "image",
    data: bytes(25),
    storedSize: 1,
    itemId: "call-15",
    raw: codex("call-15", bytes(25)),
    verified: false,
  },
];

const refOf = (c: Case) => ({ sha256: sha(c.data), sizeBytes: String(c.data.length), mimeType: "image/png" });

const itemOf = (c: Case) =>
  c.shape === "image"
    ? { itemId: c.itemId, image: { blob: refOf(c) } }
    : {
        itemId: c.itemId,
        toolCall: { name: "Read", images: [refOf(c)], ...(c.output !== undefined && { output: c.output }) },
      };

function seed(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const accounts: Record<string, { owner: string; worker: string; project: string; workspace: string }> = {};

    for (const label of ["a", "b"]) {
      const row = {
        owner: Bun.randomUUIDv7(),
        worker: Bun.randomUUIDv7(),
        project: Bun.randomUUIDv7(),
        workspace: Bun.randomUUIDv7(),
      };

      accounts[label] = row;
      yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${row.owner}::uuid,${`${label}@example.test`},${label},'user')`;
      yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES(${row.worker}::uuid,${row.owner}::uuid,${label},'fixture')`;
      yield* sql`INSERT INTO projects(id,owner_user_id,name,slug) VALUES(${row.project}::uuid,${row.owner}::uuid,${label},${label})`;
      yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES(${row.workspace}::uuid,${row.project}::uuid,${row.worker}::uuid,'/repo')`;
    }

    // Blobs as the store has them before the upgrade; the public image was uploaded once, by the first tree.
    for (const c of cases) {
      if (c.stored === "shared") continue;
      const data = c.stored ?? c.data;
      yield* sql`INSERT INTO blobs(sha256,size_bytes,mime_type,data,created_at,retention_exempt)
        VALUES(${sha(c.data)},${c.storedSize ?? data.length},'image/png',${data},now()-interval '60 days',true)`;
    }

    const threads = new Map<string, string>();

    const thread = (c: Case) =>
      Effect.gen(function* () {
        const account = accounts[c.owner ?? "a"]!;
        const id = Bun.randomUUIDv7();
        yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd)
          VALUES(${id}::uuid,${account.project}::uuid,${account.owner}::uuid,'main',${id}::uuid,'worker',${c.provider ?? (c.shape === "image" ? "codex" : "claude")},${account.worker}::uuid,${account.workspace}::uuid,'/repo')`;

        return id;
      });

    for (const c of cases) {
      const id = yield* thread(c);
      threads.set(c.name, id);
      const item = JSON.stringify(itemOf(c));

      if (c.projection !== false)
        yield* sql`INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
          VALUES(${id}::uuid,${c.itemId},${c.shape === "image" ? "image" : "tool_call"},'completed',${item}::jsonb,1,1)`;
      yield* sql`INSERT INTO thread_events(thread_id,seq,event_id,origin,kind,item_id,payload,raw,occurred_at)
        VALUES(${id}::uuid,1,${Bun.randomUUIDv7()}::uuid,${c.origin ?? "worker"},'item_completed',${c.itemId},
          ${`{"itemCompleted":{"item":${item}}}`}::jsonb,${c.raw === null ? null : JSON.stringify(c.raw)}::jsonb,now())`;
      // What an older gateway recorded: a hash-only link with no proof of who supplied the bytes.
      yield* sql`INSERT INTO thread_blobs(thread_id,sha256) VALUES(${id}::uuid,${sha(c.data)})`;

      if (c.companion) {
        const target = c.companion.elsewhere ? yield* thread(c) : id;
        yield* sql`INSERT INTO thread_events(thread_id,seq,event_id,origin,kind,payload,raw,occurred_at)
          VALUES(${target}::uuid,${c.companion.elsewhere ? 1 : 2},${Bun.randomUUIDv7()}::uuid,'worker','provider_raw',
            '{}'::jsonb,${JSON.stringify(c.companion.raw)}::jsonb,now())`;
      }
    }

    return { threads, owners: { a: accounts["a"]!.owner, b: accounts["b"]!.owner } };
  });
}

test.skipIf(!dockerAvailable)(
  "inline images in historical worker events verify only their own thread's matching bytes",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: migrations.pipe(Effect.map((entries) => entries.filter(([id]) => id < 180))),
          table: "schema_migrations",
        }),
      );
      const { threads, owners } = await runtime.runPromise(SqlClient.SqlClient.use(seed));
      // This test covers 0183 itself: 0184 deliberately keeps access to valid old images that carry no raw copy.
      await runtime.runPromise(
        Migrator.make({})({
          loader: migrations.pipe(Effect.map((entries) => entries.filter(([id]) => id <= 183))),
          table: "schema_migrations",
        }),
      );

      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            for (const c of cases) {
              const id = threads.get(c.name)!;
              const hash = sha(c.data);

              const [link] = yield* sql<{ verified: boolean }>`
                SELECT verified FROM thread_blobs WHERE thread_id=${id}::uuid AND sha256=${hash}`;

              // The public read path: owner, tree and the verified proof, then the stored bytes.
              const read = yield* sql<{ data: Uint8Array }>`SELECT b.data FROM blobs b
                WHERE b.sha256=${hash} AND ${threadBlobAccess(sql, id, hash, owners[c.owner ?? "a"])}`;

              expect({ case: c.name, verified: link?.verified, readable: read.length }).toEqual({
                case: c.name,
                verified: c.verified,
                readable: c.verified ? 1 : 0,
              });

              if (c.verified) expect(Buffer.from(read[0]!.data).equals(c.data)).toBe(true);
            }
          }),
        ),
      );
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
