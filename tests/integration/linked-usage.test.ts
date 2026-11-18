import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { create, fromJson } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { computerLink as link, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { usageCursor, saveUsagePage } from "../../apps/gateway/src/computers/usage-store.ts";
import { computersServeRemote } from "../../apps/gateway/src/computers/runtime-serving.ts";
import { computersState } from "../../apps/gateway/src/computers/runtime-context.ts";
import { linkedMessage } from "../../apps/gateway/src/computers/remote-policy.ts";
import { USAGE_STATS } from "../../apps/gateway/src/computers/capabilities.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const hour = new Date(new Date().toISOString().slice(0, 13) + ":00:00.000Z");
const since = timestampFromDate(hour);

describe.skipIf(!dockerAvailable)("durable accounting between authenticated computer links", () => {
  let a: TestGateway;
  let b: TestGateway;
  let sa: ComputerStore;
  let sb: ComputerStore;
  let la: ReturnType<typeof linkedComputers>;
  let lb: ReturnType<typeof linkedComputers>;
  let nodeA = "";
  let nodeB = "";

  function attach(gateway: TestGateway, store: ComputerStore, port?: number) {
    const computers = linkedComputers({ store, host: "127.0.0.1", heartbeatMs: 100, ...(port && { port }) });
    gateway.core.computers = computers;
    gateway.core.network = computers.options.network;

    return computers;
  }

  async function setSource(store: ComputerStore, revision: number, input: number) {
    await store.query(
      `INSERT INTO usage_buckets(owner_user_id,bucket_start,provider,model,input_tokens,output_tokens,reports,unknown_cost_reports,revision)
       VALUES($1::uuid,$2,'codex','test-model',$3,4,1,1,$4)
       ON CONFLICT(owner_user_id,bucket_start,provider,model,requested_service_tier,activity_key)
       DO UPDATE SET input_tokens=excluded.input_tokens,revision=excluded.revision`,
      [store.owner, hour, input, revision],
    );
    await store.query(
      `INSERT INTO usage_state(owner_user_id,computer_id,revision)
       SELECT $1::uuid,node_id,$2 FROM computer_identity WHERE owner_user_id=$1::uuid
       ON CONFLICT(owner_user_id) DO UPDATE SET revision=excluded.revision`,
      [store.owner, revision],
    );
  }

  async function imported(store: ComputerStore, node: string) {
    const rows = await store.query<{ payload: Parameters<typeof fromJson>[1] }>(
      "SELECT payload FROM remote_usage_buckets WHERE owner_user_id=$1::uuid AND node_id=$2",
      [store.owner, node],
    );

    return rows.map((row) => fromJson(ui.UsageBucketSchema, row.payload));
  }

  async function waitCursor(store: ComputerStore, node: string, cursor: bigint) {
    expect(
      await eventually(
        () => usageCursor(store, node),
        (value) => value === cursor,
        15_000,
      ),
    ).toBe(cursor);
  }

  async function forceSync() {
    la.usage.connected(nodeB);
    await waitCursor(sa, nodeB, 2n);
  }

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    sa = new ComputerStore(a.runtime, a.userId, randomBytes(32));
    sb = new ComputerStore(b.runtime, b.userId, randomBytes(32));
    la = attach(a, sa);
    lb = attach(b, sb);
    await la.start();
    await lb.start();
    nodeA = la.hello().nodeId;
    nodeB = lb.hello().nodeId;
    await setSource(sb, 1, 10);
    const invitation = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });
    await waitCursor(sa, nodeB, 1n);
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 20_000);

  test("handshake pulls source buckets once and never re-exports imported accounting", async () => {
    expect((await imported(sa, nodeB))[0]?.totals?.inputTokens).toBe(10n);
    expect((await imported(sa, nodeB))[0]?.computerId).toBe(nodeB);
    const response = [];

    for await (const message of la.remote(
      nodeB,
      link.UsageService.method.getUsageBuckets,
      create(link.UsageBucketsRequestSchema, { afterRevision: 1n, limit: 256 }),
      AbortSignal.timeout(5000),
    ))
      response.push(message);
    expect(response).toHaveLength(1);
    expect(response[0]).toMatchObject({ buckets: [], nextRevision: 1n });
    // A has imported B's counters, but its local accounting remains empty.
    const exported = [];

    for await (const message of lb.remote(
      nodeA,
      link.UsageService.method.getUsageBuckets,
      create(link.UsageBucketsRequestSchema, { limit: 256 }),
      AbortSignal.timeout(5000),
    ))
      exported.push(message);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ buckets: [], nextRevision: 0n });
  });

  test("new snapshots replace an hour and replay cannot add it twice", async () => {
    await setSource(sb, 2, 25);
    await forceSync();

    const page = create(link.UsageBucketsResponseSchema, {
      buckets: [
        {
          bucketStart: since,
          provider: "codex",
          model: "test-model",
          revision: 2n,
          totals: { inputTokens: 25n, outputTokens: 4n, reports: 1n, unknownCostReports: 1n },
        },
      ],
      nextRevision: 2n,
      trackingSince: since,
    });

    await saveUsagePage(sa, nodeB, 1n, page, 256);
    await saveUsagePage(sa, nodeB, 1n, page, 256);
    const buckets = await imported(sa, nodeB);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.totals?.inputTokens).toBe(25n);
  });

  test("malformed pages and another owner cannot change a saved checkpoint", async () => {
    const page = create(link.UsageBucketsResponseSchema, {
      buckets: [
        {
          bucketStart: since,
          provider: "codex",
          model: "test-model",
          revision: 3n,
          totals: { inputTokens: 40n, reports: 1n },
        },
      ],
      nextRevision: 3n,
      trackingSince: since,
    });

    const other = new ComputerStore(a.runtime, b.userId, sa.key);
    await expect(saveUsagePage(other, nodeB, 0n, page, 256)).rejects.toThrow();
    page.buckets[0]!.computerId = nodeA;
    await expect(saveUsagePage(sa, nodeB, 2n, page, 256)).rejects.toThrow("Invalid linked usage page");
    page.buckets[0]!.computerId = "";
    page.buckets[0]!.totals!.unknownCostReports = 2n;
    await expect(saveUsagePage(sa, nodeB, 2n, page, 256)).rejects.toThrow("Invalid linked usage page");
    page.buckets[0]!.totals!.unknownCostReports = 0n;
    page.buckets[0]!.requestedServiceTier = "x".repeat(129);
    await expect(saveUsagePage(sa, nodeB, 2n, page, 256)).rejects.toThrow("Invalid linked usage page");
    page.buckets[0]!.requestedServiceTier = "fast\u0000";
    await expect(saveUsagePage(sa, nodeB, 2n, page, 256)).rejects.toThrow("Invalid linked usage page");
    expect(await usageCursor(sa, nodeB)).toBe(2n);
    expect((await imported(sa, nodeB))[0]?.totals?.inputTokens).toBe(25n);
  });

  test("relay envelopes cannot request accounting even from a linked origin", async () => {
    const connection = [...la[computersState].active.get(nodeB)!][0]!;

    const stream = computersServeRemote(
      la,
      nodeB,
      connection,
      link.UsageService.method.getUsageBuckets,
      create(link.UsageBucketsRequestSchema),
      AbortSignal.timeout(5000),
      { targetNodeId: nodeA, originNodeId: nodeB, relayHops: 1 },
    );

    await expect(stream.next()).rejects.toThrow("Usage statistics require a direct link");
    expect(connection.capabilities?.has(USAGE_STATS)).toBe(true);
  });

  test("offline counters and checkpoint survive runtime restart then resume incrementally", async () => {
    const portA = la.options.network.status().port;
    const portB = lb.options.network.status().port;
    await lb.close();
    await la.close();
    la = attach(a, sa, portA);
    await la.start();
    expect(await usageCursor(sa, nodeB)).toBe(2n);
    expect((await imported(sa, nodeB))[0]?.totals?.inputTokens).toBe(25n);
    const cached = await a.api.getUsageStats({ days: 1, computerId: nodeB });

    expect(cached.totals?.inputTokens).toBe(25n);
    expect(cached.sources.find((source) => source.computerId === nodeB)?.online).toBe(false);
    expect(cached.partial).toBe(true);
    await setSource(sb, 3, 40);
    lb = attach(b, sb, portB);
    await lb.start();
    await waitCursor(sa, nodeB, 3n);
    expect((await imported(sa, nodeB))[0]?.totals?.inputTokens).toBe(40n);
  }, 30_000);

  test("large revisions are fetched in bounded pages without skipping changed hours", async () => {
    await sb.query(
      `INSERT INTO usage_buckets(owner_user_id,bucket_start,provider,model,input_tokens,reports,revision)
       SELECT $1::uuid,$2,'codex','page-' || n::text,1,1,n+3 FROM generate_series(1,260) n`,
      [sb.owner, hour],
    );
    await sb.query("UPDATE usage_state SET revision=263 WHERE owner_user_id=$1::uuid", [sb.owner]);

    for await (const message of la.remote(
      nodeB,
      link.UsageService.method.getUsageBuckets,
      create(link.UsageBucketsRequestSchema, { afterRevision: 3n, limit: 256 }),
      AbortSignal.timeout(5000),
    )) {
      const page = linkedMessage(link.UsageBucketsResponseSchema, message);

      expect(page.buckets).toHaveLength(256);
      expect(page.hasMore).toBe(true);
      await saveUsagePage(sa, nodeB, 3n, page, 256);
    }

    expect(
      (
        await sa.query<{ has_more: boolean }>(
          "SELECT has_more FROM remote_usage_state WHERE owner_user_id=$1::uuid AND node_id=$2",
          [sa.owner, nodeB],
        )
      )[0]?.has_more,
    ).toBe(true);
    la.usage.connected(nodeB);
    await waitCursor(sa, nodeB, 263n);
    const buckets = await imported(sa, nodeB);

    expect(
      (
        await sa.query<{ has_more: boolean }>(
          "SELECT has_more FROM remote_usage_state WHERE owner_user_id=$1::uuid AND node_id=$2",
          [sa.owner, nodeB],
        )
      )[0]?.has_more,
    ).toBe(false);
    expect(buckets).toHaveLength(261);
    expect(buckets.reduce((sum, bucket) => sum + bucket.totals!.inputTokens, 0n)).toBe(300n);
    const stats = await a.api.getUsageStats({ days: 1, provider: "codex", computerId: nodeB });

    expect(stats.totals?.inputTokens).toBe(300n);
    expect((await a.api.getUsageStats({ days: 1, provider: "claude", computerId: nodeB })).totals?.inputTokens).toBe(
      0n,
    );
  });

  test("same-hour model buckets preserve requested speeds and native tiers on sync and replay", async () => {
    await sb.query(
      `UPDATE usage_buckets SET input_tokens=45,revision=264 WHERE owner_user_id=$1::uuid
       AND bucket_start=$2 AND provider='codex' AND model='test-model' AND requested_service_tier=''`,
      [sb.owner, hour],
    );
    await sb.query(
      `INSERT INTO usage_buckets(owner_user_id,bucket_start,provider,model,requested_service_tier,input_tokens,reports,revision)
       SELECT $1::uuid,$2,'codex','test-model',tier,tokens,1,revision
       FROM (VALUES('fast',10,265),('ultrafast',20,266),('default',5,267),('priority',30,268)) b(tier,tokens,revision)`,
      [sb.owner, hour],
    );
    await sb.query("UPDATE usage_state SET revision=268 WHERE owner_user_id=$1::uuid", [sb.owner]);
    la.usage.connected(nodeB);
    await waitCursor(sa, nodeB, 268n);

    for await (const message of la.remote(
      nodeB,
      link.UsageService.method.getUsageBuckets,
      create(link.UsageBucketsRequestSchema, { afterRevision: 263n, limit: 256 }),
      AbortSignal.timeout(5000),
    )) {
      const page = linkedMessage(link.UsageBucketsResponseSchema, message);

      expect(page.buckets).toHaveLength(5);
      await saveUsagePage(sa, nodeB, 263n, page, 256);
      await saveUsagePage(sa, nodeB, 263n, page, 256);
    }

    const tiers = (await imported(sa, nodeB)).filter((bucket) => bucket.model === "test-model");

    expect(tiers).toHaveLength(5);
    expect(
      Object.fromEntries(tiers.map((bucket) => [bucket.requestedServiceTier, bucket.totals?.inputTokens])),
    ).toEqual({
      "": 45n,
      fast: 10n,
      ultrafast: 20n,
      default: 5n,
      priority: 30n,
    });
    expect((await a.api.getUsageStats({ days: 1, computerId: nodeB })).totals?.inputTokens).toBe(370n);
    const request = { days: 1, computerId: nodeB, provider: "codex" };

    expect((await a.api.getUsageStats({ ...request, requestedServiceTier: "fast" })).totals?.inputTokens).toBe(10n);
    expect((await a.api.getUsageStats({ ...request, requestedServiceTier: "priority" })).totals?.inputTokens).toBe(30n);
    expect((await a.api.getUsageStats({ ...request, requestedServiceTier: "" })).totals?.inputTokens).toBe(305n);
  });

  test("requested speeds survive offline restart and later fast snapshots replace only fast", async () => {
    const portA = la.options.network.status().port;
    const portB = lb.options.network.status().port;
    await lb.close();
    await la.close();
    la = attach(a, sa, portA);
    await la.start();
    expect(await usageCursor(sa, nodeB)).toBe(268n);
    const cached = await a.api.getUsageStats({ days: 1, computerId: nodeB, requestedServiceTier: "ultrafast" });

    expect(cached.totals?.inputTokens).toBe(20n);
    expect(cached.sources.find((source) => source.computerId === nodeB)?.online).toBe(false);
    expect(cached.partial).toBe(true);
    await sb.query(
      `UPDATE usage_buckets SET input_tokens=100,revision=269 WHERE owner_user_id=$1::uuid
       AND bucket_start=$2 AND provider='codex' AND model='test-model' AND requested_service_tier='fast'`,
      [sb.owner, hour],
    );
    await sb.query("UPDATE usage_state SET revision=269 WHERE owner_user_id=$1::uuid", [sb.owner]);
    lb = attach(b, sb, portB);
    await lb.start();
    await waitCursor(sa, nodeB, 269n);
    const tiers = (await imported(sa, nodeB)).filter((bucket) => bucket.model === "test-model");

    expect(tiers).toHaveLength(5);
    expect(
      Object.fromEntries(tiers.map((bucket) => [bucket.requestedServiceTier, bucket.totals?.inputTokens])),
    ).toEqual({
      "": 45n,
      fast: 100n,
      ultrafast: 20n,
      default: 5n,
      priority: 30n,
    });
    expect((await a.api.getUsageStats({ days: 1, computerId: nodeB })).totals?.inputTokens).toBe(460n);
  }, 30_000);

  test("zero replacement snapshots clear unknown speed when its usage moves to a known tier", async () => {
    await sb.query(
      `UPDATE usage_buckets SET input_tokens=0,output_tokens=0,reports=0,unknown_cost_reports=0,revision=270
       WHERE owner_user_id=$1::uuid AND bucket_start=$2 AND provider='codex' AND model='test-model' AND requested_service_tier=''`,
      [sb.owner, hour],
    );
    await sb.query(
      `UPDATE usage_buckets SET input_tokens=75,output_tokens=4,reports=2,unknown_cost_reports=1,revision=271
       WHERE owner_user_id=$1::uuid AND bucket_start=$2 AND provider='codex' AND model='test-model' AND requested_service_tier='priority'`,
      [sb.owner, hour],
    );
    await sb.query("UPDATE usage_state SET revision=271 WHERE owner_user_id=$1::uuid", [sb.owner]);
    la.usage.connected(nodeB);
    await waitCursor(sa, nodeB, 271n);
    const tiers = (await imported(sa, nodeB)).filter((bucket) => bucket.model === "test-model");

    expect(tiers).toHaveLength(5);
    expect(tiers.find((bucket) => bucket.requestedServiceTier === "")?.totals?.inputTokens).toBe(0n);
    expect(tiers.find((bucket) => bucket.requestedServiceTier === "priority")?.totals?.inputTokens).toBe(75n);
    const request = { days: 1, computerId: nodeB };

    expect((await a.api.getUsageStats(request)).totals?.inputTokens).toBe(460n);
    expect((await a.api.getUsageStats({ ...request, requestedServiceTier: "" })).totals?.inputTokens).toBe(260n);
  });

  test("unlink revokes cached accounting and an in-flight page cannot restore it", async () => {
    await a.api.manageComputer({ nodeId: nodeB, action: "unlink" });
    expect(await usageCursor(sa, nodeB)).toBe(0n);
    expect(await imported(sa, nodeB)).toEqual([]);
    const page = create(link.UsageBucketsResponseSchema, { nextRevision: 271n, trackingSince: since });
    // A response already received before unlink must not recreate the deleted source state.
    await expect(saveUsagePage(sa, nodeB, 271n, page, 256)).rejects.toThrow();
  });
});
