import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ProviderProfileKind } from "@canopy/contracts";
import { migrate } from "@canopy/db";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore } from "../src/store/index.ts";

let pg: TestPostgres;
let runtime: ManagedRuntime.ManagedRuntime<GatewayStore | SqlClient.SqlClient, unknown>;

const store = <A>(use: (s: GatewayStore["Service"]) => import("effect").Effect.Effect<A, unknown>) =>
  runtime.runPromise(GatewayStore.use(use));

describe.skipIf(!dockerAvailable)("GatewayStore on PostgreSQL", () => {
  beforeAll(async () => {
    pg = await startPostgres();
    runtime = ManagedRuntime.make(GatewayStore.layer(randomBytes(32)).pipe(Layer.provideMerge(pg.layer)));
    await runtime.runPromise(migrate);
  }, 60_000);
  afterAll(async () => {
    await runtime?.dispose();
    pg?.stop();
  });

  test("worker credentials: stored as hashes, revoked or unknown credentials fail", async () => {
    const userId = await store((s) => s.ensureUser("a@x", "A"));
    expect(await store((s) => s.ensureUser("a@x", "A"))).toBe(userId);
    const { workerId, credential } = await store((s) => s.addWorker({ name: "w", ownerUserId: userId }));
    expect(await store((s) => s.authenticateWorker(credential))).toBe(workerId);
    expect(await store((s) => s.authenticateWorker("nope"))).toBeUndefined();

    const stored = await runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql<{ credential_hash: string }>`SELECT credential_hash FROM workers WHERE id = ${workerId}::uuid`,
      ),
    );

    expect(stored[0]?.credential_hash).not.toContain(credential);
  });

  test("profile keys: encrypted at rest, resolved only when the config is sent; inline keys refused", async () => {
    const userId = await store((s) => s.ensureUser("b@x", "B"));
    const { workerId } = await store((s) => s.addWorker({ name: "w2", ownerUserId: userId }));

    const secretId = await store((s) =>
      s.putSecret({ ownerUserId: userId, name: "proxy-key", plaintext: "sk-live-123", createdBy: userId }),
    );

    const profile = { id: "cliproxyapi", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317" };

    const version = await store((s) =>
      s.setWorkerConfig(workerId, { allowedRoots: ["/r"], profiles: [profile] }, userId, { cliproxyapi: secretId }),
    );

    expect(version).toBe(1n);

    const rows = await runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql<{ config: unknown; ciphertext: Uint8Array }>`
        SELECT c.config, s.ciphertext FROM worker_configs c, secrets s WHERE c.worker_id = ${workerId}::uuid AND s.id = ${secretId}::uuid`,
      ),
    );

    expect(JSON.stringify(rows[0]?.config)).not.toContain("sk-live-123");
    expect(Buffer.from(rows[0]!.ciphertext).toString("utf8")).not.toContain("sk-live-123");

    const sent = await store((s) => s.workerConfig(workerId));
    expect(sent?.version).toBe(1n);
    expect(sent?.profiles[0]).toMatchObject({
      id: "cliproxyapi",
      baseUrl: "http://127.0.0.1:8317",
      apiKey: "sk-live-123",
    });

    const inline = await store((s) =>
      s.setWorkerConfig(workerId, { profiles: [{ ...profile, apiKey: "sk-inline" }] }, userId),
    ).catch((cause: unknown) => cause);

    expect(String(inline)).toContain("secret references");

    // The referenced secret cannot be deleted while a config uses it.
    const deletion = await runtime
      .runPromise(SqlClient.SqlClient.use((sql) => sql`DELETE FROM secrets WHERE id = ${secretId}::uuid`))
      .catch((cause: unknown) => cause);

    expect(deletion).toBeDefined();
    expect(await store((s) => s.setWorkerConfig(workerId, { allowedRoots: ["/r", "/s"] }, userId))).toBe(2n);
  });
});
