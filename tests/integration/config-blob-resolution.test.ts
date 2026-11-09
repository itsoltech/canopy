import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { dockerAvailable } from "@canopy/db/testing";
import { missingBlobs, localBlob } from "../../apps/gateway/src/config-sync/environment-blobs.ts";
import { applyWaitingEnvironment } from "../../apps/gateway/src/config-sync/environment-sync.ts";
import { configLock, emptyRecord, type ConfigRow } from "../../apps/gateway/src/config-sync/persistence.ts";
import { WAITING } from "../../apps/gateway/src/config-sync/environment-support.ts";
import { librarySkill, skillFiles } from "./support/agent-skills.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("owner-scoped configuration content resolution", () => {
  let gateway: TestGateway;

  const save = (row: ConfigRow) =>
    gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) =>
          sql`INSERT INTO config_items(owner_user_id,kind,global_id,local_id,home_node_id,fields,deleted,revision,unsupported)
      VALUES(${gateway.userId}::uuid,${row.kind},${row.global_id},${row.local_id},${row.home_node_id},
        ${JSON.stringify(row.fields)}::jsonb,${JSON.stringify(row.deleted)}::jsonb,1,${row.unsupported})`,
      ),
    );

  const field = (value: ConfigRow["deleted"]["value"]) => ({ value, hlc: "1.0.synthetic", prev: "" });

  const missing = (owner = gateway.userId) =>
    gateway.runtime.runPromise(SqlClient.SqlClient.use((sql) => missingBlobs(sql, owner)));

  beforeAll(async () => {
    gateway = await startTestGateway();
    gateway.core.secrets.stop();
  }, 60_000);

  afterAll(async () => {
    await gateway?.close();
  });

  test("partial tombstones remain live and catalog hashes require a valid catalog shape", async () => {
    const partial = emptyRecord("skill", Bun.randomUUIDv7());
    partial.deleted = field(true);
    partial.fields[`version.${"a".repeat(64)}`] = field({ commit: "", checksum: "" });
    partial.fields[`version.${"b".repeat(63)}`] = field({ commit: "", checksum: "" });
    await save(partial);
    const deleted = emptyRecord("skill", Bun.randomUUIDv7());
    deleted.deleted = field(true);
    await save(deleted);
    const catalog = emptyRecord("marketplace", Bun.randomUUIDv7());
    catalog.fields["catalog"] = field({ hash: "c".repeat(64), commit: "" });
    await save(catalog);
    const invalid = emptyRecord("marketplace", Bun.randomUUIDv7());
    invalid.fields["catalog"] = field({ hash: "d".repeat(64), commit: 42 });
    await save(invalid);
    const remote = emptyRecord("skill", Bun.randomUUIDv7(), "remote");
    remote.fields[`version.${"e".repeat(64)}`] = field({ commit: "", checksum: "" });
    await save(remote);
    expect(await missing()).toEqual(["a".repeat(64), "c".repeat(64)]);
    expect(await missing(Bun.randomUUIDv7())).toEqual([]);
  });

  test("a waiting version reuses owner content and a supplied hash retries a previously applied record", async () => {
    const snapshot = await gateway.api.getAgentEnvironment({});

    const uploaded = await gateway.api.saveLibrarySkill({
      skill: librarySkill(),
      files: skillFiles(),
      expectedRevision: snapshot.revision,
    });

    const source = uploaded.skills[0]!;

    const stored = await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) =>
          sql<{ content_hash: string }>`SELECT content_hash FROM agent_skill_versions
        WHERE skill_id=${source.id}::uuid AND owner_user_id=${gateway.userId}::uuid`,
      ),
    );

    const hash = stored[0]!.content_hash;
    const row = emptyRecord("skill", Bun.randomUUIDv7());
    row.unsupported = WAITING;
    row.deleted = field(true);
    row.fields = {
      name: field("Reused content"),
      selected: field(hash),
      harnesses: field(["claude"]),
      selector: field({ everyone: true }),
      platformHome: field(true),
      [`version.${hash}`]: field({ commit: "", checksum: source.artifact!.checksum }),
    };
    await save(row);

    const apply = (blobs = new Map<string, Uint8Array>()) =>
      gateway.runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            Effect.andThen(configLock(sql, gateway.userId), applyWaitingEnvironment(sql, gateway.userId, blobs)),
          ),
        ),
      );

    expect(await apply()).toBe(true);
    expect(
      (await gateway.api.getAgentEnvironment({})).skills.find((s) => s.id === row.local_id)?.artifact?.checksum,
    ).toBe(source.artifact!.checksum);

    const bytes = await gateway.runtime.runPromise(
      SqlClient.SqlClient.use((sql) => localBlob(sql, gateway.userId, hash)),
    );

    expect(
      await gateway.runtime.runPromise(SqlClient.SqlClient.use((sql) => localBlob(sql, Bun.randomUUIDv7(), hash))),
    ).toBeUndefined();
    row.fields["name"] = field("Retried content");
    await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql`UPDATE config_items
      SET fields=${JSON.stringify(row.fields)}::jsonb WHERE owner_user_id=${gateway.userId}::uuid
        AND kind='skill' AND global_id=${row.global_id}`,
      ),
    );
    expect(await apply()).toBe(false);
    expect(await apply(new Map([[hash, bytes!]]))).toBe(true);
    expect((await gateway.api.getAgentEnvironment({})).skills.find((s) => s.id === row.local_id)?.name).toBe(
      "Retried content",
    );
  });
});
