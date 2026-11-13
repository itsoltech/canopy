import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "../src/testing.ts";
import { failure, query, startSchemaDb, stopSchemaDb, world } from "./support/schema.ts";

describe.skipIf(!dockerAvailable)("diagnostics schema bounds and trust cascades", () => {
  beforeAll(startSchemaDb, 60_000);
  afterAll(stopSchemaDb);

  test("bounds blobs and resolutions, and keeps home rollups attached to their owner", async () => {
    const w = await world();
    await query("INSERT INTO diagnostics_state VALUES($1,'home',''::bytea,NULL)", [w.user]);

    const insert = `INSERT INTO diagnostics_rollups(owner_user_id,computer_id,resolution,bucket_start,payload)
      VALUES($1,'home',$2,$3,decode(repeat('00',$4),'hex'))`;

    expect(await failure(insert, [w.user, 5, "2026-11-10T00:00:00Z", 0])).toContain("check");
    expect(await failure(insert, [w.user, 3600, "2026-11-10T00:01:00Z", 0])).toContain("check");
    expect(await failure(insert, [w.user, 60, "2026-11-10T00:00:01Z", 0])).toContain("check");
    expect(await failure(insert, [w.user, 60, "2026-11-10T00:00:00Z", 65537])).toContain("check");
    const foreign = await world();
    expect(await failure(insert, [foreign.user, 60, "2026-11-10T00:00:00Z", 0])).toContain("foreign key");
    await query(insert, [w.user, 60, "2026-11-10T00:00:00Z", 65536]);
    await query("DELETE FROM diagnostics_state WHERE owner_user_id=$1", [w.user]);
    expect(
      (
        await query<{ count: number }>("SELECT count(*)::int count FROM diagnostics_rollups WHERE owner_user_id=$1", [
          w.user,
        ])
      )[0]?.count,
    ).toBe(0);
  });

  test("revoking a relay removes diagnostic grants and cached snapshots with no cross-owner trust", async () => {
    const w = await world();
    const other = await world();
    await query(
      `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
      VALUES($1,'relay','Relay','',''),($1,'origin','Origin','','')`,
      [w.user],
    );
    const grant = "INSERT INTO diagnostics_grants VALUES($1,'origin','relay')";
    expect(await failure(grant, [other.user])).toContain("foreign key");
    await query(grant, [w.user]);
    await query("INSERT INTO diagnostics_peer_cache VALUES($1,'origin',''::bytea,now(),NULL)", [w.user]);
    expect(
      await failure(
        "UPDATE diagnostics_peer_cache SET payload=decode(repeat('00',16385),'hex') WHERE owner_user_id=$1",
        [w.user],
      ),
    ).toContain("check");
    await query("DELETE FROM computer_peers WHERE owner_user_id=$1 AND node_id='relay'", [w.user]);
    expect(
      (
        await query<{ count: number }>("SELECT count(*)::int count FROM diagnostics_grants WHERE owner_user_id=$1", [
          w.user,
        ])
      )[0]?.count,
    ).toBe(0);
    await query("DELETE FROM computer_peers WHERE owner_user_id=$1 AND node_id='origin'", [w.user]);
    expect(
      (
        await query<{ count: number }>(
          "SELECT count(*)::int count FROM diagnostics_peer_cache WHERE owner_user_id=$1",
          [w.user],
        )
      )[0]?.count,
    ).toBe(0);
  });
});
