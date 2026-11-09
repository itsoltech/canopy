import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { sharedHost, uiHandlers } from "@canopy/gateway/api";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore, ModelStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let other: GatewayCore;
let otherOwner = "";

const catalogs = (owner: string, workerIds?: readonly string[]) =>
  gw.runtime.runPromise(ModelStore.use((s) => s.catalogs(owner, workerIds)));

async function modelUpdates(
  core: GatewayCore,
  action: () => Promise<ui.ProviderInstance | void>,
): Promise<ui.WorkerModels[]> {
  const subscription = core.hub.subscribeOverview();
  const models: ui.WorkerModels[] = [];

  const collecting = (async () => {
    for await (const update of subscription.updates)
      if (update.change.case === "models") models.push(update.change.value);
  })();

  try {
    await action();
  } finally {
    subscription.close();
    await collecting;
  }

  return models;
}

describe.skipIf(!dockerAvailable)("owner-scoped worker model catalogs", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    otherOwner = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("catalog-other@example.test", "Other owner")),
    );
    other = new GatewayCore({ runtime: gw.runtime, userId: otherOwner, instanceId: "catalog-other" });
    await eventually(
      () => gw.api.listModels({}),
      (response) => response.workers.length === 1,
    );
  }, 60_000);

  afterAll(async () => {
    await other?.stopSweep();
    await other?.bots.stop();
    await other?.link.shutdown();
    await gw?.close();
  });

  test("an owner with no workers gets no catalogs, including unfiltered reads and foreign IDs", async () => {
    expect((await gw.api.listModels({})).workers.map((w) => w.workerId)).toEqual([gw.workerId]);
    expect((await catalogs(gw.userId)).map((w) => w.workerId)).toEqual([gw.workerId]);
    expect(await catalogs(gw.userId, [])).toEqual([]);
    expect(await catalogs(otherOwner)).toEqual([]);
    expect(await catalogs(otherOwner, [gw.workerId])).toEqual([]);
    expect(await other.listModels(create(ui.ListModelsRequestSchema))).toEqual([]);
    expect(await other.listModels(create(ui.ListModelsRequestSchema, { unfiltered: true }))).toEqual([]);
    expect(await failure(other.listModels(create(ui.ListModelsRequestSchema, { workerId: gw.workerId })))).toContain(
      "worker not found",
    );
  });

  test("both provider-change broadcasts publish only the current owner's catalogs", async () => {
    const settings = create(ui.SetInstanceModelsRequestSchema, {
      harness: Provider.CODEX,
      id: "native",
      models: { favorites: ["gpt-5.5"] },
    });

    expect(await modelUpdates(other, () => other.setInstanceModels(settings))).toEqual([]);
    expect(await modelUpdates(other, async () => sharedHost(other, uiHandlers(other)).providersChanged?.([]))).toEqual(
      [],
    );
    expect((await modelUpdates(gw.core, () => gw.core.setInstanceModels(settings))).map((w) => w.workerId)).toEqual([
      gw.workerId,
    ]);
    expect(
      (await modelUpdates(gw.core, async () => sharedHost(gw.core, uiHandlers(gw.core)).providersChanged?.([]))).map(
        (w) => w.workerId,
      ),
    ).toEqual([gw.workerId]);
  });

  test("shared workers stay visible while archived workers and foreign requested IDs stay excluded", async () => {
    const shared = await gw.addWorker("shared-catalog");
    const archived = await gw.addWorker("archived-catalog");
    const profiles = (await catalogs(gw.userId, [gw.workerId]))[0]!.profiles;
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* ModelStore;
        yield* store.save({ workerId: shared.workerId, configVersion: 1n, profiles });
        yield* store.save({ workerId: archived.workerId, configVersion: 1n, profiles });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE workers SET owner_user_id = NULL WHERE id = ${shared.workerId}::uuid`;
        yield* sql`UPDATE workers SET archived_at = now() WHERE id = ${archived.workerId}::uuid`;
      }),
    );

    expect((await catalogs(otherOwner)).map((w) => w.workerId)).toEqual([shared.workerId]);
    expect((await catalogs(otherOwner, [gw.workerId, shared.workerId])).map((w) => w.workerId)).toEqual([
      shared.workerId,
    ]);
    expect(await catalogs(gw.userId, [archived.workerId])).toEqual([]);
    expect(await catalogs(otherOwner, [])).toEqual([]);
    expect((await other.listModels(create(ui.ListModelsRequestSchema))).map((w) => w.workerId)).toEqual([
      shared.workerId,
    ]);
    expect(
      (await modelUpdates(other, async () => sharedHost(other, uiHandlers(other)).providersChanged?.([]))).map(
        (w) => w.workerId,
      ),
    ).toEqual([shared.workerId]);
  });
});
