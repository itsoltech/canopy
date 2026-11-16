import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { pruneStorage } from "../../apps/gateway/src/maintenance/storage.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("storage garbage collection on PostgreSQL", () => {
  let gateway: TestGateway;
  let foreignOwner: string;

  const query = <T extends object = Record<string, string>>(text: string, args: readonly unknown[] = []) =>
    gateway.core.linkedAgents.query<T>(text, [...args]);

  const collect = () =>
    gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(pruneStorage(sql, gateway.userId));
      }),
    );

  const blob = async (days = 8, exempt = false) => {
    const data = Buffer.from(crypto.randomUUID());
    const hash = createHash("sha256").update(data).digest("hex");
    await query(
      `INSERT INTO blobs(sha256,size_bytes,data,created_at,retention_exempt)
      VALUES($1,$2,$3,now()-make_interval(days=>$4),$5)`,
      [hash, data.length, data, days, exempt],
    );

    return hash;
  };

  const upload = async (hash: string, owner = gateway.userId, days = 32, thumbnail?: string) => {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO attachments(id,owner_user_id,sha256,thumb_sha256,name,mime_type,kind,size_bytes,created_at)
      VALUES($1::uuid,$2::uuid,$3,$4,'upload.txt','text/plain','file',36,now()-make_interval(days=>$5))`,
      [id, owner, hash, thumbnail ?? null, days],
    );

    return id;
  };

  const exists = async (table: "attachments" | "blobs", id: string) =>
    (await query(`SELECT 1 FROM ${table} WHERE ${table === "blobs" ? "sha256" : "id::text"}=$1`, [id])).length > 0;

  const draft = async (attachment: string) => {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO composer_drafts(id,owner_user_id,device_id,target_key,payload,revision,mutation_id)
      VALUES($1::uuid,$2::uuid,'gc-test','new-thread',''::bytea,1,$1)`,
      [id, gateway.userId],
    );
    await query("INSERT INTO composer_draft_attachments(draft_id,attachment_id) VALUES($1::uuid,$2::uuid)", [
      id,
      attachment,
    ]);

    return id;
  };

  const botDraft = async (payload: Uint8Array) => {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
      VALUES($1::uuid,$2::uuid,$1,'{}','codex','native')`,
      [id, gateway.userId],
    );
    await query("INSERT INTO bot_composer_drafts(bot_id,owner_user_id,payload) VALUES($1::uuid,$2::uuid,$3)", [
      id,
      gateway.userId,
      payload,
    ]);

    return id;
  };

  const encodedDraft = (attachment: string) =>
    toBinary(bots.BotComposerDraftSchema, create(bots.BotComposerDraftSchema, { attachments: [{ id: attachment }] }));

  beforeAll(async () => {
    gateway = await startTestGateway();
    foreignOwner = crypto.randomUUID();
    await query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Foreign owner','user')", [
      foreignOwner,
      `${foreignOwner}@example.test`,
    ]);
  }, 60_000);
  afterAll(async () => gateway?.close());

  test("expires abandoned uploads but preserves shared bytes, thumbnails, recent and foreign uploads", async () => {
    const shared = await blob();
    const thumb = await blob();
    const own = await upload(shared);
    const foreign = await upload(shared, foreignOwner, 32, thumb);
    const recentHash = await blob();
    const recent = await upload(recentHash, gateway.userId, 29);
    const abandonedHash = await blob();
    const abandoned = await upload(abandonedHash);
    const orphan = await blob();
    const freshOrphan = await blob(6);
    const legacy = await blob(90, true);
    await collect();
    expect(await exists("attachments", own)).toBe(false);
    expect(await exists("attachments", abandoned)).toBe(false);
    expect(await exists("blobs", abandonedHash)).toBe(false);
    expect(await exists("blobs", orphan)).toBe(false);

    for (const id of [foreign, recent]) expect(await exists("attachments", id)).toBe(true);

    for (const hash of [shared, thumb, recentHash, freshOrphan, legacy]) expect(await exists("blobs", hash)).toBe(true);
  });

  test("retains composer and decoded bot draft references until their last reference disappears", async () => {
    const composerHash = await blob();
    const composerUpload = await upload(composerHash);
    const composer = await draft(composerUpload);
    const botHash = await blob();
    const botUpload = await upload(botHash);
    const bot = await botDraft(encodedDraft(botUpload));
    await collect();

    for (const id of [composerUpload, botUpload]) expect(await exists("attachments", id)).toBe(true);
    expect(
      (
        await query<{ attachment_ids: string[] }>(
          "SELECT attachment_ids FROM bot_composer_drafts WHERE bot_id=$1::uuid",
          [bot],
        )
      )[0]!.attachment_ids,
    ).toEqual([botUpload]);
    await query("DELETE FROM composer_drafts WHERE id=$1::uuid", [composer]);
    await query("UPDATE bot_composer_drafts SET payload=$2 WHERE bot_id=$1::uuid", [
      bot,
      toBinary(bots.BotComposerDraftSchema, create(bots.BotComposerDraftSchema)),
    ]);
    expect(
      (
        await query<{ attachment_ids: string[] | null }>(
          "SELECT attachment_ids FROM bot_composer_drafts WHERE bot_id=$1::uuid",
          [bot],
        )
      )[0]!.attachment_ids,
    ).toBeNull();
    await collect();

    for (const id of [composerUpload, botUpload]) expect(await exists("attachments", id)).toBe(false);

    for (const hash of [composerHash, botHash]) expect(await exists("blobs", hash)).toBe(false);
  });

  test("malformed legacy drafts protect uploads and back off without starving valid drafts", async () => {
    const hash = await blob();
    const id = await upload(hash);
    const corrupt = await botDraft(Uint8Array.of(255));
    const invalidId = await botDraft(encodedDraft("invalid-attachment-id"));
    const good = await botDraft(toBinary(bots.BotComposerDraftSchema, create(bots.BotComposerDraftSchema)));
    await collect();
    expect(await exists("attachments", id)).toBe(true);
    expect(await exists("blobs", hash)).toBe(true);

    const rows = await query<{ bot_id: string; attachment_ids: string[] | null; deferred: boolean }>(
      "SELECT bot_id,attachment_ids,attachment_index_retry_at>now() AS deferred FROM bot_composer_drafts WHERE bot_id=ANY($1::uuid[])",
      [[corrupt, invalidId, good]],
    );

    for (const bot of [corrupt, invalidId])
      expect(rows.find((row) => row.bot_id === bot)).toMatchObject({ attachment_ids: null, deferred: true });
    expect(rows.find((row) => row.bot_id === good)?.attachment_ids).toEqual([]);
    expect(await collect()).toBe(0);
    await query("DELETE FROM bot_composer_drafts WHERE bot_id=ANY($1::uuid[])", [[corrupt, invalidId, good]]);
    await collect();
    expect(await exists("attachments", id)).toBe(false);
  });

  test("keeps an old upload referenced by a rewind draft until the rewind is removed", async () => {
    const project = (await gateway.api.createProject({ name: "Rewind storage" })).project!.id;
    const thread = crypto.randomUUID();
    const turn = crypto.randomUUID();
    const rewind = crypto.randomUUID();
    const hash = await blob();
    const id = await upload(hash);

    await query(
      `INSERT INTO threads(id,root_thread_id,project_id,owner_user_id,kind,runtime,provider,status)
      VALUES($1::uuid,$1::uuid,$2::uuid,$3::uuid,'main','gateway','openai','idle')`,
      [thread, project, gateway.userId],
    );
    await query(
      `INSERT INTO turns(id,thread_id,ordinal,status,trigger,input,first_seq,last_seq,author_user_id)
      VALUES($1::uuid,$2::uuid,1,'completed','user','{}',1,2,$3::uuid)`,
      [turn, thread, gateway.userId],
    );
    await query(
      `INSERT INTO thread_rewinds(id,thread_id,owner_user_id,turn_id,client_request_id,status,
      source_provider_thread_id,command_id,draft) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$1::text,
      'completed','source-session',$5::uuid,$6::jsonb)`,
      [rewind, thread, gateway.userId, turn, crypto.randomUUID(), JSON.stringify({ attachments: [{ id }] })],
    );
    await collect();
    expect(await exists("attachments", id)).toBe(true);
    expect(await exists("blobs", hash)).toBe(true);
    await query("DELETE FROM thread_rewinds WHERE id=$1::uuid", [rewind]);
    await collect();
    expect(await exists("attachments", id)).toBe(false);
    expect(await exists("blobs", hash)).toBe(false);
  });

  test("skips an upload locked by a draft writer and observes its committed reference on retry", async () => {
    const hash = await blob();
    const id = await upload(hash);
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM attachments WHERE id=${id}::uuid FOR UPDATE`;
            yield* Effect.promise(collect);
            expect(yield* Effect.promise(() => exists("attachments", id))).toBe(true);
            const draftId = crypto.randomUUID();
            yield* sql`INSERT INTO composer_drafts(id,owner_user_id,device_id,target_key,payload,revision,mutation_id)
          VALUES(${draftId}::uuid,${gateway.userId}::uuid,'gc-race','new-thread',''::bytea,1,${draftId})`;
            yield* sql`INSERT INTO composer_draft_attachments(draft_id,attachment_id) VALUES(${draftId}::uuid,${id}::uuid)`;
          }),
        );
      }),
    );
    await collect();
    expect(await exists("attachments", id)).toBe(true);
    expect(await exists("blobs", hash)).toBe(true);
  });
});
