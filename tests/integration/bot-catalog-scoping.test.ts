import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { SqlClient } from "effect/sql";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bot model catalog ownership", () => {
  let gateway: TestGateway;
  const foreign = Bun.randomUUIDv7();
  const ownWorker = Bun.randomUUIDv7();
  const sharedWorker = Bun.randomUUIDv7();
  const foreignWorker = Bun.randomUUIDv7();

  beforeAll(async () => {
    gateway = await startTestGateway();
    await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql`INSERT INTO users(id,email,display_name,role)
      VALUES(${foreign}::uuid,'foreign@example.invalid','Synthetic','user')`,
      ),
    );

    for (const [id, owner, model] of [
      [ownWorker, gateway.userId, "owned-model"],
      [sharedWorker, null, "shared-model"],
      [foreignWorker, foreign, "foreign-model"],
    ] as const) {
      await gateway.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql`INSERT INTO workers(id,owner_user_id,name,credential_hash,os)
        VALUES(${id}::uuid,${owner}::uuid,'Synthetic','synthetic','linux')`,
        ),
      );
      await gateway.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql`INSERT INTO worker_model_catalogs(worker_id,profiles)
        VALUES(${id}::uuid,jsonb_build_array(
        jsonb_build_object('provider',${Provider.CODEX}::int,'profileId','native','models',jsonb_build_array(jsonb_build_object('id',${model}::text))),
          jsonb_build_object('provider','PROVIDER_GROK','profileId','native','models',jsonb_build_array(jsonb_build_object('id','other-provider'))),
          jsonb_build_object('provider','PROVIDER_CODEX','profileId','other','models',jsonb_build_array(jsonb_build_object('id','other-instance')))))`,
        ),
      );
    }

    await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql`INSERT INTO provider_instances(harness,id,kind,label,created_by,custom_models)
      VALUES('codex','private-foreign','native','Synthetic',${foreign}::uuid,ARRAY['private-model'])`,
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await gateway?.close();
  });

  const models = (worker = "") =>
    gateway.runtime.runPromise(BotStore.use((s) => s.harnessModels(gateway.userId, Provider.CODEX, "native", worker)));

  test("owned and shared workers contribute only the requested provider and instance", async () => {
    const ids = (await models()).map((model) => model.id);
    expect(ids).toContain("owned-model");
    expect(ids).toContain("shared-model");
    expect(ids).not.toContain("foreign-model");
    expect(ids).not.toContain("other-provider");
    expect(ids).not.toContain("other-instance");
    expect((await models(ownWorker)).map((model) => model.id)).toEqual(["owned-model"]);
    expect(await models(foreignWorker)).toEqual([]);
  });

  test("a private instance cannot be enumerated or used by another owner's bot", async () => {
    await expect(
      gateway.runtime.runPromise(
        BotStore.use((s) => s.harnessModels(gateway.userId, Provider.CODEX, "private-foreign")),
      ),
    ).rejects.toThrow("choose an existing provider instance");
    await expect(
      gateway.api.createBot({
        clientRequestId: Bun.randomUUIDv7(),
        configuration: {
          name: "Denied",
          shape: "round",
          color: "#123456",
          provider: Provider.CODEX,
          providerInstance: "private-foreign",
          model: "private-model",
        },
      }),
    ).rejects.toThrow("choose an existing provider instance");
  });
});
