import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, fromJson, toJson, type MessageInitShape } from "@bufbuild/protobuf";
import {
  ConfigAppliedSchema,
  Provider,
  ProviderConfigurationMode,
  ProviderProfileKind,
  ProviderUserConfigurationSchema,
  ui,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { CLAUDE_USER_CONFIGURATION_CAPABILITY, CODEX_CLI_HOME_CAPABILITY } from "@canopy/domain/release/protocol";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

const local = {
  mode: ProviderConfigurationMode.LOCAL,
  sourcePath: "/configuration/team",
  instructions: true,
  skills: true,
  hooks: false,
};

const shared = { ...local, mode: ProviderConfigurationMode.SHARED, sourcePath: "/configuration/worker", hooks: true };

const isolated = {
  ...local,
  mode: ProviderConfigurationMode.ISOLATED,
  sourcePath: "",
  instructions: false,
  skills: false,
};

const instance = {
  harness: Provider.CLAUDE,
  id: "configured",
  label: "Configured Claude",
  kind: ProviderProfileKind.NATIVE,
};

const capableWorker = { hello: { capabilities: [CLAUDE_USER_CONFIGURATION_CAPABILITY, CODEX_CLI_HOME_CAPABILITY] } };

describe.skipIf(!dockerAvailable)("Provider configuration policy persistence and WorkerLink", () => {
  let gateway: TestGateway;
  let workerB: ScriptedWorker;
  let workerBId: string;

  const listed = async () =>
    (await gateway.api.listProviderInstances({})).instances.find(
      (i) => i.harness === instance.harness && i.id === instance.id,
    )!;

  const delivered = (worker: ScriptedWorker, expected: typeof local) =>
    eventually(
      async () => worker.configs.at(-1)?.profiles.find((p) => p.id === instance.id)?.userConfiguration,
      (policy) =>
        policy?.mode === expected.mode && policy.sourcePath === expected.sourcePath && policy.hooks === expected.hooks,
    );

  beforeAll(async () => {
    gateway = await startTestGateway({ worker: capableWorker });
    const added = await gateway.addWorker("second worker");
    workerBId = added.workerId;
    workerB = await gateway.connect(added.workerId, added.credential, undefined, capableWorker);
  }, 60_000);

  afterAll(async () => {
    await gateway?.close();
  });

  test("old runtime JSON keeps the absent policy through a gateway restart", async () => {
    expect(gateway.worker.configs.at(-1)?.profiles.every((profile) => !profile.userConfiguration)).toBe(true);
    expect((await gateway.api.listProviderInstances({})).instances.every((i) => !i.runtime?.userConfiguration)).toBe(
      true,
    );

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ storage, worker: capableWorker });
    expect(gateway.worker.configs.at(-1)?.profiles.every((profile) => !profile.userConfiguration)).toBe(true);
    const added = await gateway.addWorker("second worker after restart");
    workerBId = added.workerId;
    workerB = await gateway.connect(added.workerId, added.credential, undefined, capableWorker);
  });

  test("policy roundtrips through numeric runtime JSON and protobuf JSON to both workers", async () => {
    const saved = await gateway.api.saveProviderInstance({
      ...instance,
      create: true,
      allWorkers: true,
      runtime: { userConfiguration: { ...local, sourcePath: `  ${local.sourcePath}  ` } },
    });

    expect(saved.instance?.runtime?.userConfiguration).toMatchObject(local);
    expect(await delivered(gateway.worker, local)).toMatchObject(local);
    expect(await delivered(workerB, local)).toMatchObject(local);

    const stored = await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) =>
          sql<{
            runtime: { userConfiguration: typeof local };
          }>`SELECT runtime FROM provider_instances WHERE harness='claude' AND id=${instance.id}`,
      ),
    );

    expect(stored[0]?.runtime.userConfiguration).toEqual(local);

    const modes = await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql<{ policy: { mode: string } }>`
      SELECT p->'userConfiguration' AS policy FROM worker_configs c, jsonb_array_elements(c.config->'profiles') p
      WHERE c.worker_id=${gateway.workerId}::uuid AND p->>'id'=${instance.id}`,
      ),
    );

    expect(modes[0]?.policy.mode).toBe("PROVIDER_CONFIGURATION_MODE_LOCAL");
  });

  test("a worker replaces the entire policy, including false switches, and absence restores inheritance", async () => {
    const changed = await gateway.api.setInstanceWorker({
      ...instance,
      workerId: workerBId,
      overrides: { userConfiguration: isolated },
    });

    expect(changed.instance?.workers.find((w) => w.workerId === workerBId)?.overrides?.userConfiguration).toMatchObject(
      isolated,
    );
    expect(await delivered(workerB, isolated)).toMatchObject(isolated);
    const inherited = await gateway.api.getInstanceWorker({ ...instance, workerId: workerBId });
    expect(inherited.inheritedRuntime?.userConfiguration).toMatchObject(local);
    expect(inherited.worker?.overrides?.userConfiguration).toMatchObject(isolated);
    expect(gateway.worker.configs.at(-1)?.profiles.find((p) => p.id === instance.id)?.userConfiguration).toMatchObject(
      local,
    );

    await gateway.api.setInstanceWorker({ ...instance, workerId: workerBId, overrides: { userConfiguration: shared } });
    expect(await delivered(workerB, shared)).toMatchObject(shared);
    await gateway.api.setInstanceWorker({ ...instance, workerId: workerBId, overrides: { userConfiguration: {} } });
    expect(await delivered(workerB, isolated)).toMatchObject(isolated);
    await gateway.api.setInstanceWorker({ ...instance, workerId: workerBId, overrides: {} });
    expect(
      (await listed()).workers.find((w) => w.workerId === workerBId)?.overrides?.userConfiguration,
    ).toBeUndefined();
    expect(await delivered(workerB, local)).toMatchObject(local);
  });

  test("restart preserves a saved policy and restores its worker delivery", async () => {
    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ storage, worker: capableWorker });
    expect((await listed()).runtime?.userConfiguration).toMatchObject(local);
    expect(await delivered(gateway.worker, local)).toMatchObject(local);
  });

  test("invalid modes and source paths are rejected for definitions and worker overrides", async () => {
    const invalid = fromJson(ProviderUserConfigurationSchema, { mode: 99 });

    const cases: { value: MessageInitShape<typeof ProviderUserConfigurationSchema>; message: string }[] = [
      { value: invalid, message: "Choose an isolated, local, or shared" },
      { value: { ...local, sourcePath: "relative/path" }, message: "absolute directory path" },
      { value: { ...local, sourcePath: "~another-user/.claude" }, message: "absolute directory path" },
      { value: { ...local, sourcePath: "/configuration/\0" }, message: "absolute directory path" },
      { value: { ...local, sourcePath: `/${"x".repeat(1024)}` }, message: "absolute directory path" },
    ];

    for (const { value, message } of cases) {
      expect(
        await failure(gateway.api.saveProviderInstance({ ...instance, runtime: { userConfiguration: value } })),
      ).toContain(message);
      expect(
        await failure(
          gateway.api.setInstanceWorker({
            ...instance,
            workerId: gateway.workerId,
            overrides: { userConfiguration: value },
          }),
        ),
      ).toContain(message);
    }

    const unsupported = [
      { harness: Provider.GROK, value: shared, message: "isolated configuration for Grok" },
      { harness: Provider.CODEX, value: local, message: "Choose Isolated or Use CLI home" },
      ...[{ sourcePath: "~/other" }, { instructions: true }, { skills: true }, { hooks: true }].map((field) => ({
        harness: Provider.CODEX,
        value: { mode: ProviderConfigurationMode.SHARED, ...field },
        message: "Clear the Claude configuration options",
      })),
    ];

    for (const { harness, value, message } of unsupported) {
      expect(
        await failure(
          gateway.api.saveProviderInstance({
            ...instance,
            harness,
            id: "native",
            runtime: { userConfiguration: value },
          }),
        ),
      ).toContain(message);
      expect(
        await failure(
          gateway.api.setInstanceWorker({
            harness,
            id: "native",
            workerId: gateway.workerId,
            overrides: { userConfiguration: value },
          }),
        ),
      ).toContain(message);
    }

    expect((await listed()).runtime?.userConfiguration).toMatchObject(local);
  });

  test("built-in Codex keeps its implicit home until a definition or worker selects a home", async () => {
    const codex = { harness: Provider.CODEX, id: "native", kind: ProviderProfileKind.NATIVE };
    const target = { ...codex, workerId: gateway.workerId };
    const path = "/worker/codex-home";

    const deliveredMode = async (expected: ProviderConfigurationMode | undefined) => {
      const profile = await eventually(
        async () =>
          gateway.worker.configs
            .at(-1)
            ?.profiles.find((p) => p.id === "native" && p.providers.includes(Provider.CODEX)),
        (p) => p?.homePath === path && p.userConfiguration?.mode === expected,
      );

      expect(profile?.homePath).toBe(path);
      expect(profile?.userConfiguration?.mode).toBe(expected);
    };

    const saved = await gateway.api.saveProviderInstance({ ...codex, runtime: { homePath: path } });
    expect(saved.instance?.runtime?.userConfiguration).toBeUndefined();
    await deliveredMode(undefined);

    await gateway.api.setInstanceWorker({ ...target, overrides: { userConfiguration: isolated } });
    await deliveredMode(ProviderConfigurationMode.ISOLATED);
    const detail = await gateway.api.getInstanceWorker(target);
    expect(detail.inheritedRuntime?.userConfiguration).toBeUndefined();
    expect(detail.worker?.overrides?.userConfiguration).toMatchObject(isolated);

    await gateway.api.setInstanceWorker({ ...target, overrides: {} });
    await deliveredMode(undefined);
    await gateway.api.saveProviderInstance({ ...codex, runtime: { homePath: path, userConfiguration: isolated } });
    const inherited = await gateway.api.setInstanceWorker({ ...target, overrides: { userConfiguration: {} } });
    expect(
      inherited.instance?.workers.find((w) => w.workerId === target.workerId)?.overrides?.userConfiguration,
    ).toBeUndefined();
    await deliveredMode(ProviderConfigurationMode.ISOLATED);

    const reset = await gateway.api.saveProviderInstance({
      ...codex,
      runtime: { homePath: path, userConfiguration: {} },
    });

    expect(reset.instance?.runtime?.userConfiguration).toBeUndefined();
    await deliveredMode(undefined);

    const stored = await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql<{ definition: boolean; override: boolean }>`
        SELECT i.runtime ? 'userConfiguration' AS definition, w.overrides ? 'userConfiguration' AS override
        FROM provider_instances i JOIN provider_instance_workers w ON w.harness = i.harness AND w.instance_id = i.id
        WHERE i.harness = 'codex' AND i.id = 'native' AND w.worker_id = ${target.workerId}::uuid`,
      ),
    );

    expect(stored).toEqual([{ definition: false, override: false }]);
  });

  test("old isolated Codex records discard unused Claude fields when read and sent to a worker", async () => {
    const codex = {
      harness: Provider.CODEX,
      id: "legacy-isolated",
      label: "Legacy Codex",
      kind: ProviderProfileKind.NATIVE,
    };

    await gateway.api.saveProviderInstance({ ...codex, create: true, allWorkers: true });
    const legacy = { userConfiguration: { ...shared, mode: ProviderConfigurationMode.ISOLATED } };

    await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) =>
          sql`UPDATE provider_instances SET runtime = ${JSON.stringify(legacy)}::jsonb WHERE harness='codex' AND id=${codex.id}`,
      ),
    );
    const record = (await gateway.api.listProviderInstances({})).instances.find((i) => i.id === codex.id);

    expect(record?.runtime?.userConfiguration).toMatchObject(isolated);
    await gateway.api.saveProviderInstance({ ...codex, runtime: { binaryPath: "/worker/codex" } });

    const profile = await eventually(
      async () => gateway.worker.configs.at(-1)?.profiles.find((p) => p.id === codex.id),
      (p) => p?.executablePath === "/worker/codex",
    );

    expect(profile?.userConfiguration).toMatchObject(isolated);
  });

  test("Codex CLI home follows native definitions and worker overrides and stays dormant for own login and proxy", async () => {
    const codex = { harness: Provider.CODEX, id: "cli-home", label: "CLI home", kind: ProviderProfileKind.NATIVE };
    const userConfiguration = { mode: ProviderConfigurationMode.SHARED };
    const homePath = "/custom/codex";

    const expectProfile = async (
      expected: Partial<{
        ownLogin: boolean;
        homePath: string;
        mode: ProviderConfigurationMode;
        kind: ProviderProfileKind;
      }>,
    ) => {
      const match = await eventually(
        async () => {
          const profile = gateway.worker.configs.at(-1)?.profiles.find((p) => p.id === codex.id);

          return (
            !!profile &&
            profile.userConfiguration?.mode === expected.mode &&
            profile.kind === (expected.kind ?? codex.kind) &&
            profile.ownLogin === (expected.ownLogin ?? false) &&
            profile.homePath === (expected.homePath ?? homePath)
          );
        },
        (matched) => matched,
      );

      expect(match).toBe(true);
    };

    const saved = await gateway.api.saveProviderInstance({
      ...codex,
      create: true,
      allWorkers: true,
      runtime: { homePath, userConfiguration },
    });

    expect(saved.instance?.runtime?.userConfiguration).toMatchObject({ ...isolated, ...userConfiguration });
    await expectProfile(userConfiguration);
    const override = { ...codex, workerId: gateway.workerId };
    await gateway.api.setInstanceWorker({
      ...override,
      overrides: { userConfiguration: isolated, homePath: "/alternate/codex" },
    });
    await expectProfile({ mode: ProviderConfigurationMode.ISOLATED, homePath: "/alternate/codex" });
    await gateway.api.setInstanceWorker({ ...override, overrides: {} });
    await expectProfile(userConfiguration);

    // Older clients omit the policy when editing a runtime.
    const own = await gateway.api.saveProviderInstance({ ...codex, runtime: { ownLogin: true, homePath } });
    expect(own.instance?.runtime?.userConfiguration?.mode).toBe(ProviderConfigurationMode.SHARED);
    await expectProfile({ ownLogin: true });
    await gateway.api.saveProviderInstance({
      ...codex,
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8888",
    });
    await expectProfile({ kind: ProviderProfileKind.CLIPROXYAPI, ownLogin: true });
    await gateway.api.saveProviderInstance({ ...codex, runtime: { homePath } });
    await expectProfile(userConfiguration);
    await gateway.api.saveProviderInstance({
      ...codex,
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8888",
    });
    await expectProfile({ kind: ProviderProfileKind.CLIPROXYAPI });
  });

  test("home-relative source paths remain literal in storage and WorkerLink for worker expansion", async () => {
    const sources = ["~", "~/.claude/team", "~\\.claude\\team"];

    for (const sourcePath of sources) {
      const relative = { ...local, sourcePath };

      const saved = await gateway.api.saveProviderInstance({
        ...instance,
        allWorkers: true,
        runtime: { userConfiguration: relative },
      });

      expect(saved.instance?.runtime?.userConfiguration).toMatchObject(relative);
      expect(await delivered(gateway.worker, relative)).toMatchObject(relative);

      const runtime = await gateway.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql<{ source: string }>`
      SELECT runtime->'userConfiguration'->>'sourcePath' AS source FROM provider_instances
      WHERE harness='claude' AND id=${instance.id}`,
        ),
      );

      expect(runtime[0]?.source).toBe(sourcePath);
    }

    for (const sourcePath of sources) {
      const overridden = { ...shared, sourcePath };
      await gateway.api.setInstanceWorker({
        ...instance,
        workerId: gateway.workerId,
        overrides: { userConfiguration: overridden },
      });
      expect(await delivered(gateway.worker, overridden)).toMatchObject(overridden);
    }
  });

  test("effective paths roundtrip from WorkerLink to list and worker detail without inferring missing paths", async () => {
    const config = gateway.worker.configs.at(-1);

    if (!config) throw new Error("The worker has not received its configuration.");

    const paths = {
      loginHomePath: "/reported/login",
      configurationHomePath: "/reported/configuration",
      sessionHomePath: "/reported/sessions",
      privateHomePath: "/reported/private",
    };

    const profile = { id: instance.id, providers: [Provider.CLAUDE], kind: instance.kind, available: true };

    gateway.worker.link.send({
      case: "configApplied",
      value: { version: config.version, applied: true, profiles: [{ ...profile, ...paths }] },
    });

    const status = await eventually(
      async () => (await listed()).workers.find((w) => w.workerId === gateway.workerId),
      (value) => value?.sessionHomePath === paths.sessionHomePath,
    );

    expect(status).toMatchObject({ reported: true, ...paths });
    expect((await gateway.api.getInstanceWorker({ ...instance, workerId: gateway.workerId })).worker).toMatchObject(
      paths,
    );

    gateway.worker.link.send({
      case: "configApplied",
      value: { version: config.version, applied: true, profiles: [profile] },
    });

    const olderReport = await eventually(
      async () => (await listed()).workers.find((w) => w.workerId === gateway.workerId),
      (value) => value?.sessionHomePath === "",
    );

    expect(olderReport).toMatchObject({
      reported: true,
      loginHomePath: "",
      configurationHomePath: "",
      sessionHomePath: "",
      privateHomePath: "",
    });
  });

  test("legacy workers disable only enabled local/shared profiles and explain the required update", async () => {
    const added = await gateway.addWorker("legacy worker");
    const legacy = await gateway.connect(added.workerId, added.credential);

    const configured = await eventually(
      async () => legacy.configs.at(-1)?.profiles.find((p) => p.id === instance.id),
      (value) => value !== undefined,
    );

    expect(configured?.disabled).toBe(true);

    const status = await eventually(
      async () => (await listed()).workers.find((w) => w.workerId === added.workerId),
      (value) => value?.detail.includes("Update this worker") ?? false,
    );

    expect(status?.available).toBe(false);
    expect((await listed()).runtime?.userConfiguration?.mode).toBe(ProviderConfigurationMode.LOCAL);
    await gateway.api.setInstanceWorker({
      ...instance,
      workerId: added.workerId,
      overrides: { userConfiguration: isolated },
    });
    await delivered(legacy, isolated);
    expect(legacy.configs.at(-1)?.profiles.find((p) => p.id === instance.id)?.disabled).toBe(false);
    expect(legacy.configs.at(-1)?.profiles.find((p) => p.providers.includes(Provider.CODEX))?.disabled).toBe(false);
  });

  test("another owner's worker hides its reported paths and rejects policy overrides", async () => {
    const owner = crypto.randomUUID();
    const worker = crypto.randomUUID();
    await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql`
      INSERT INTO users (id,email,display_name,role) VALUES (${owner}::uuid,${`${owner}@example.test`},'Other owner','user')`,
      ),
    );
    await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql`
      INSERT INTO workers (id,owner_user_id,name,credential_hash) VALUES (${worker}::uuid,${owner}::uuid,'Other worker','fixture')`,
      ),
    );

    const foreignReport = toJson(
      ConfigAppliedSchema,
      create(ConfigAppliedSchema, {
        profiles: [
          {
            id: instance.id,
            providers: [Provider.CLAUDE],
            loginHomePath: "/other-owner/login",
            configurationHomePath: "/other-owner/configuration",
            sessionHomePath: "/other-owner/sessions",
            privateHomePath: "/other-owner/private",
          },
        ],
      }),
    );

    await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql`
      INSERT INTO worker_configs (worker_id,version,config,updated_by,apply_report)
      VALUES (${worker}::uuid,1,'{}'::jsonb,${owner}::uuid,${JSON.stringify(foreignReport)}::jsonb)`,
      ),
    );
    const visible = await gateway.api.listProviderInstances({});

    expect(visible.instances.every((i) => i.workers.every((w) => w.workerId !== worker))).toBe(true);
    expect(JSON.stringify(toJson(ui.ListProviderInstancesResponseSchema, visible))).not.toContain("/other-owner/");
    await expect(gateway.api.getInstanceWorker({ ...instance, workerId: worker })).rejects.toThrow();
    expect(
      await failure(
        gateway.api.setInstanceWorker({ ...instance, workerId: worker, overrides: { userConfiguration: shared } }),
      ),
    ).toContain("not found");

    const assignments = await gateway.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql`
      SELECT 1 FROM provider_instance_workers WHERE worker_id=${worker}::uuid`,
      ),
    );

    expect(assignments).toHaveLength(0);
  });
});
