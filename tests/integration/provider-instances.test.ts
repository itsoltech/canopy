/**
 * Global provider instances end to end on PostgreSQL (docs/worker-config.md, section 9): an instance defined once in
 * the gateway with an endpoint key and variables is synced only to the workers it is enabled on (as a new version
 * of their configuration), with per-worker overrides merged in; secrets never reach the UI; pickers see per worker
 * only the instances enabled and available there, with the instance's model choices; a thread keeps its instance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJson } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ProviderProfileKind, type WorkerConfig, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, InstanceStore } from "@canopy/gateway/store";
import { ANTIGRAVITY_ACP_CAPABILITY, PROVIDER_SETTINGS_CAPABILITY } from "@canopy/domain/release/protocol";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

const KEY = "sk-team-secret-4711";
const TOKEN = "tok-secret-value-0815";
const KEY_B = "sk-worker-b-0042";
const settingsWorker = { hello: { capabilities: [PROVIDER_SETTINGS_CAPABILITY] } };
const nativeCodex = { harness: Provider.CODEX, id: "native", kind: ProviderProfileKind.NATIVE };

const codexProfile = (config: WorkerConfig | undefined) =>
  config?.profiles.find((p) => p.id === "native" && p.providers.includes(Provider.CODEX));

let gw: TestGateway;
let workerB: ScriptedWorker;
let workerBId = "";
let projectId = "";
let workspaceId = "";

const query = <A extends object>(text: string, ...params: unknown[]) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe<A>(text, params as never[]);
    }),
  );

const instances = async () => (await gw.api.listProviderInstances({})).instances;
const team = async () => (await instances()).find((i) => i.harness === Provider.CODEX && i.id === "team")!;
const workerOf = async (id: string) => (await gw.api.getOverview({})).workers.find((w) => w.id === id)!;

/** What the new-thread picker offers on a worker: instances enabled and available there. */
const pickable = async (id: string) =>
  (await workerOf(id)).providerInstances
    .filter((i) => i.enabled && i.available)
    .map((i) => `${Provider[i.harness]}/${i.id}`);

const visible = (workers: ui.WorkerModels[], profileId: string) =>
  workers[0]!.profiles
    .find((p) => p.provider === Provider.CODEX && p.profileId === profileId)!
    .models.filter((m) => !m.hidden)
    .map((m) => m.id);

describe.skipIf(!dockerAvailable)("global provider instances (gateway + two scripted workers)", () => {
  beforeAll(async () => {
    gw = await startTestGateway({ worker: settingsWorker });
    const added = await gw.addWorker("desktop", ["/srv"]);
    workerBId = added.workerId;
    workerB = await gw.connect(added.workerId, added.credential);
    projectId = (await gw.api.createProject({ name: "Instances" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app", label: "" }))
      .workspace!.id;
    await eventually(
      () => workerOf(workerBId),
      (w) => w.appliedVersion > 0n,
    );
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("the built-in device logins exist for every harness on every worker", async () => {
    const listed = await instances();
    expect(listed.map((i) => [Provider[i.harness], i.id, i.builtIn, i.allWorkers])).toEqual([
      ["ANTIGRAVITY", "native", true, true],
      ["CLAUDE", "native", true, true],
      ["CODEX", "native", true, true],
      ["GROK", "native", true, true],
    ]);
    expect(gw.worker.configs.at(-1)?.antigravity).toBeUndefined();
    expect(gw.worker.configs.at(-1)?.profiles.some((p) => p.providers.includes(Provider.ANTIGRAVITY))).toBe(false);
    // Claude is not installed on the scripted workers: only Codex is pickable.
    expect(await pickable(gw.workerId)).toEqual(["CODEX/native"]);
  });

  test("an instance enabled on worker A only: synced to A with its secrets, absent on B, never in clear for the UI", async () => {
    const versionB = (await workerOf(workerBId)).configVersion;

    const saved = await gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "team",
      create: true,
      label: "Team proxy",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8317",
      apiKey: KEY,
      env: [
        { name: "PROFILE_PROBE", secret: false, value: "probe-42" },
        { name: "TEAM_TOKEN", secret: true, value: TOKEN },
      ],
      runtime: { launchArgs: ["-c", 'model_verbosity="low"'] },
      accentColor: "#7C3AED",
      workerIds: [gw.workerId],
    });

    expect(saved.instance).toMatchObject({
      id: "team",
      label: "Team proxy",
      apiKeySet: true,
      accentColor: "#7c3aed",
      allWorkers: false,
    });

    const config = await eventually(
      async () => gw.worker.configs.at(-1)!,
      (c) => c.profiles.some((p) => p.id === "team"),
    );

    const profile = config.profiles.find((p) => p.id === "team")!;
    expect(profile).toMatchObject({
      apiKey: KEY,
      displayName: "Team proxy",
      baseUrl: "http://127.0.0.1:8317",
      providers: [Provider.CODEX],
      launchArgs: ["-c", 'model_verbosity="low"'],
    });
    expect(profile.env.map((v) => [v.name, v.value, v.secret])).toEqual([
      ["PROFILE_PROBE", "probe-42", false],
      ["TEAM_TOKEN", TOKEN, true],
    ]);
    // B got no new version and nothing of the instance.
    expect((await workerOf(workerBId)).configVersion).toBe(versionB);
    expect(workerB.configs.flatMap((c) => c.profiles).some((p) => p.id === "team")).toBe(false);

    await eventually(
      () => pickable(gw.workerId),
      (p) => p.includes("CODEX/team"),
    );
    expect(await pickable(gw.workerId)).toEqual(["CODEX/native", "CODEX/team"]);
    expect(await pickable(workerBId)).toEqual(["CODEX/native"]);
    const onA = (await team()).workers.find((w) => w.workerId === gw.workerId)!;
    expect(onA).toMatchObject({
      enabled: true,
      reported: true,
      available: true,
      auth: "endpoint key",
      authenticated: true,
      version: "0.164.0",
      synced: true,
    });

    const uiJson = JSON.stringify([
      toJson(ui.SaveProviderInstanceResponseSchema, saved),
      toJson(ui.ListProviderInstancesResponseSchema, await gw.api.listProviderInstances({})),
      toJson(ui.GetOverviewResponseSchema, await gw.api.getOverview({})),
    ]);

    expect(uiJson).not.toContain(KEY);
    expect(uiJson).not.toContain(TOKEN);
    // At rest: references only, also in the configuration history.
    const history = await query<{ config: unknown }>("SELECT config FROM worker_config_history");
    expect(JSON.stringify(history)).not.toContain(KEY);
    expect(JSON.stringify(await query("SELECT env::text, api_key::text FROM provider_instances"))).not.toContain(TOKEN);
  });

  test("enabled on B with overrides: B runs global ⊕ its own endpoint, key and variables", async () => {
    const enabled = await gw.api.setInstanceWorker({
      harness: Provider.CODEX,
      id: "team",
      workerId: workerBId,
      enabled: true,
      overrides: {
        baseUrl: "http://10.0.0.5:8317",
        apiKey: KEY_B,
        env: [{ name: "PROFILE_PROBE", value: "probe-b" }],
        launchArgsSet: true,
        launchArgs: [],
        binaryPath: "/opt/codex/bin/codex",
      },
    });

    const onB = enabled.instance!.workers.find((w) => w.workerId === workerBId)!;
    expect(onB).toMatchObject({
      enabled: true,
      explicit: true,
      overrides: {
        baseUrl: "http://10.0.0.5:8317",
        apiKeySet: true,
        launchArgsSet: true,
        binaryPath: "/opt/codex/bin/codex",
      },
    });
    expect(JSON.stringify(toJson(ui.SetInstanceWorkerResponseSchema, enabled))).not.toContain(KEY_B);

    const config = await eventually(
      async () => workerB.configs.at(-1)!,
      (c) => c.profiles.some((p) => p.id === "team"),
    );

    const profile = config.profiles.find((p) => p.id === "team")!;
    expect(profile).toMatchObject({
      apiKey: KEY_B,
      baseUrl: "http://10.0.0.5:8317",
      launchArgs: [],
      executablePath: "/opt/codex/bin/codex",
    });
    expect(profile.env.map((v) => [v.name, v.value])).toEqual([
      ["PROFILE_PROBE", "probe-b"],
      ["TEAM_TOKEN", TOKEN],
    ]);
    // A is unchanged.
    expect(gw.worker.configs.at(-1)!.profiles.find((p) => p.id === "team")).toMatchObject({
      apiKey: KEY,
      baseUrl: "http://127.0.0.1:8317",
    });
  });

  test("validation: ids, reserved variables, a secret without value, an old revision, the built-in", async () => {
    const base = { harness: Provider.CODEX, label: "X", kind: ProviderProfileKind.NATIVE, create: true };
    expect(await failure(gw.api.saveProviderInstance({ ...base, id: "Bad Id" }))).toContain("lowercase");
    expect(await failure(gw.api.saveProviderInstance({ ...base, id: "team" }))).toContain("already has");
    expect(
      await failure(gw.api.saveProviderInstance({ ...base, id: "x", env: [{ name: "CODEX_HOME", value: "/tmp" }] })),
    ).toContain("Change the home or CLI path in Runtime instead.");
    expect(
      await failure(gw.api.saveProviderInstance({ ...base, id: "x", env: [{ name: "NEW_SECRET", secret: true }] })),
    ).toContain("Enter the secret value.");
    expect(await failure(gw.api.saveProviderInstance({ ...base, id: "x", accentColor: "red" }))).toContain("#rrggbb");
    const current = await team();
    expect(
      await failure(
        gw.api.saveProviderInstance({
          harness: Provider.CODEX,
          id: "team",
          label: "Y",
          kind: current.kind,
          baseUrl: current.baseUrl,
          expectedRevision: current.revision + 1n,
        }),
      ),
    ).toContain("changed");
    expect(await failure(gw.api.deleteProviderInstance({ harness: Provider.CODEX, id: "native" }))).toContain(
      "cannot be deleted",
    );
  });

  test("threads run on the instance; model choices change pickers only; a thread on a hidden model keeps working", async () => {
    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title: "on team",
        provider: Provider.CODEX,
        providerProfileId: "team",
        permissionMode: PermissionMode.ASK,
        clientRequestId: "c-team",
        model: "gpt-6.1-sol",
      })
    ).thread!;

    await gw.api.sendMessage({ threadId: thread.id, text: "hello", clientRequestId: "m1" });
    await eventually(
      async () => [...gw.worker.turnSettings.values()],
      (t) => t.length > 0,
    );
    const start = gw.worker.commands.find((c) => c.case === "startTurn");
    expect(start?.case === "startTurn" && start.value.thread?.providerProfileId).toBe("team");

    await gw.api.setInstanceModels({
      harness: Provider.CODEX,
      id: "team",
      models: { favorites: ["gpt-5.5"], hidden: ["gpt-6.1-sol"], custom: ["my-fine-tune"] },
    });
    expect(visible((await gw.api.listModels({ workerId: gw.workerId })).workers, "team")).toEqual([
      "gpt-5.5",
      "my-fine-tune",
    ]);
    expect(visible((await gw.api.listModels({ workerId: gw.workerId, unfiltered: true })).workers, "team")).toEqual([
      "gpt-6.1-sol",
      "gpt-5.5",
    ]);
    expect(visible((await gw.api.listModels({ workerId: gw.workerId })).workers, "native")).toEqual([
      "gpt-6.1-sol",
      "gpt-5.5",
    ]);
    expect((await workerOf(gw.workerId)).providerInstances.find((i) => i.id === "team")!.favorites).toEqual([
      "gpt-5.5",
    ]);

    // The hidden model still runs; a custom model is accepted although the catalog does not list it.
    await gw.api.sendMessage({ threadId: thread.id, text: "again", clientRequestId: "m2", model: "gpt-6.1-sol" });
    await gw.api.sendMessage({ threadId: thread.id, text: "custom", clientRequestId: "m3", model: "my-fine-tune" });
    await eventually(
      async () => [...gw.worker.turnSettings.values()],
      (t) => t.length > 2,
    );
    expect([...gw.worker.turnSettings.values()].map((t) => t.model)).toEqual([
      "gpt-6.1-sol",
      "gpt-6.1-sol",
      "my-fine-tune",
    ]);
  });

  test("turned off on A: gone from A's picker, new threads refused, the thread says why; in use it cannot be deleted", async () => {
    expect(await failure(gw.api.deleteProviderInstance({ harness: Provider.CODEX, id: "team" }))).toContain(
      "turn it off instead",
    );
    await gw.api.setInstanceWorker({ harness: Provider.CODEX, id: "team", workerId: gw.workerId, enabled: false });

    // A keeps a stub without secrets for its thread; the worker reports it disabled.
    const config = await eventually(
      async () => gw.worker.configs.at(-1)!,
      (c) => c.profiles.find((p) => p.id === "team")?.disabled === true,
    );

    expect(config.profiles.find((p) => p.id === "team")).toMatchObject({ disabled: true, apiKey: "", env: [] });
    await eventually(
      () => pickable(gw.workerId),
      (p) => !p.includes("CODEX/team"),
    );
    expect(await pickable(gw.workerId)).toEqual(["CODEX/native"]);
    expect(await pickable(workerBId)).toEqual(["CODEX/native", "CODEX/team"]);
    expect(
      await failure(
        gw.api.createThread({
          projectId,
          workspaceId,
          title: "x",
          provider: Provider.CODEX,
          providerProfileId: "team",
          permissionMode: PermissionMode.ASK,
          clientRequestId: "c-x",
        }),
      ),
    ).toContain("turned off");
  });

  test("all workers, and an unused instance is deleted with its secrets", async () => {
    const spare = await gw.api.saveProviderInstance({
      harness: Provider.CLAUDE,
      id: "spare",
      create: true,
      label: "Spare",
      kind: ProviderProfileKind.NATIVE,
      env: [{ name: "SPARE_SECRET", secret: true, value: "s" }],
      allWorkers: true,
    });

    expect(spare.instance!.workers.every((w) => w.enabled)).toBe(true);
    await eventually(
      async () => workerB.configs.at(-1)!,
      (c) => c.profiles.some((p) => p.id === "spare"),
    );

    const count = async () =>
      Number(
        (await query<{ n: string }>("SELECT count(*)::text AS n FROM secrets WHERE name LIKE 'instance-%'"))[0]!.n,
      );

    const before = await count();
    await gw.api.deleteProviderInstance({
      harness: Provider.CLAUDE,
      id: "spare",
      expectedRevision: spare.instance!.revision,
    });
    expect(await count()).toBe(before - 1);
    await eventually(
      async () => workerB.configs.at(-1)!,
      (c) => !c.profiles.some((p) => p.id === "spare"),
    );
    expect((await instances()).map((i) => `${Provider[i.harness]}/${i.id}`)).toEqual([
      "ANTIGRAVITY/native",
      "CLAUDE/native",
      "CODEX/native",
      "CODEX/team",
      "GROK/native",
    ]);
  });

  test("CLI settings preserve exact text and apply scoped version changes, including explicit clears", async () => {
    const shared = '# Keep this comment\nmodel_verbosity = "low"\n\n';
    const local = '  model_verbosity = "high" # This worker only\n';
    const worker = { ...nativeCodex, workerId: gw.workerId };
    const saved = await gw.api.saveProviderInstance({ ...nativeCodex, runtime: { settingsText: shared } });
    expect(saved.instance?.runtime?.settingsText).toBe(shared);

    const delivered = await eventually(
      async () => codexProfile(gw.worker.configs.at(-1)),
      (p) => p?.settingsText === shared,
    );

    expect(delivered).toMatchObject({ settingsText: shared, settingsOverrideText: "", disabled: false });

    const onLegacy = await eventually(
      async () => codexProfile(workerB.configs.at(-1)),
      (p) => p?.disabled === true,
    );

    expect(onLegacy?.disabled).toBe(true);

    const preserved = await gw.api.saveProviderInstance({ ...nativeCodex, runtime: {} });
    expect(preserved.instance?.runtime?.settingsText).toBe(shared);
    expect(preserved.instance?.revision).toBe(saved.instance!.revision + 1n);
    expect(
      await failure(
        gw.api.saveProviderInstance({
          ...nativeCodex,
          expectedRevision: saved.instance!.revision,
          runtime: { settingsText: "" },
        }),
      ),
    ).toContain("changed");
    expect(
      await failure(gw.api.saveProviderInstance({ ...nativeCodex, runtime: { settingsText: "invalid [" } })),
    ).toContain("Check the TOML syntax");

    const versionB = (await workerOf(workerBId)).configVersion;
    await gw.api.setInstanceWorker({ ...worker, overrides: { settingsText: local } });

    const overridden = await eventually(
      async () => codexProfile(gw.worker.configs.at(-1)),
      (p) => p?.settingsOverrideText === local,
    );

    expect(overridden).toMatchObject({ settingsText: shared, settingsOverrideText: local });
    expect((await workerOf(workerBId)).configVersion).toBe(versionB);
    await gw.api.setInstanceWorker({ ...worker, overrides: {} });
    expect(
      await failure(gw.api.setInstanceWorker({ ...worker, overrides: { settingsText: 'api_key = "invalid"' } })),
    ).toContain("Check the supported keys");
    const read = await gw.api.getInstanceWorker(worker);
    expect(read.inheritedRuntime?.settingsText).toBe(shared);
    expect(read.worker?.overrides?.settingsText).toBe(local);
    expect((await instances()).find((i) => i.harness === Provider.CODEX && i.id === "native")?.revision).toBe(
      preserved.instance!.revision,
    );

    await gw.api.setInstanceWorker({ ...worker, overrides: { settingsText: "" } });
    expect((await gw.api.getInstanceWorker(worker)).worker?.overrides?.settingsText).toBeUndefined();

    const inherited = await eventually(
      async () => codexProfile(gw.worker.configs.at(-1)),
      (p) => p?.settingsOverrideText === "",
    );

    expect(inherited).toMatchObject({ settingsText: shared, settingsOverrideText: "" });

    const cleared = await gw.api.saveProviderInstance({ ...nativeCodex, runtime: { settingsText: " \t\n" } });
    expect(cleared.instance?.runtime?.settingsText).toBeUndefined();

    const legacyRestored = await eventually(
      async () => codexProfile(workerB.configs.at(-1)),
      (p) => p?.disabled === false && p.settingsText === "",
    );

    expect(legacyRestored).toMatchObject({ settingsText: "", disabled: false });
  });

  test("Grok receives shared and worker TOML without accepting connection or permission settings", async () => {
    const nativeGrok = { ...nativeCodex, harness: Provider.GROK };
    const worker = { ...nativeGrok, workerId: gw.workerId };
    const shared = '[models]\ndefault_reasoning_effort = "high"\n';
    const local = "[session]\nauto_compact_threshold_percent = 75\n";

    const grokProfile = () =>
      gw.worker.configs.at(-1)?.profiles.find((p) => p.id === "native" && p.providers.includes(Provider.GROK));

    const saved = await gw.api.saveProviderInstance({ ...nativeGrok, runtime: { settingsText: shared } });
    await gw.api.setInstanceWorker({ ...worker, overrides: { settingsText: local } });

    const delivered = await eventually(
      async () => grokProfile(),
      (p) => p?.settingsOverrideText === local,
    );

    expect(delivered).toMatchObject({ settingsText: shared, settingsOverrideText: local, disabled: false });
    expect(
      await failure(
        gw.api.saveProviderInstance({
          ...nativeGrok,
          expectedRevision: saved.instance!.revision,
          runtime: {
            settingsText: '[models]\ndefault_reasoning_effort = "low"\nextra_headers = { Authorization = "fixture" }',
          },
        }),
      ),
    ).toContain("Check the supported keys");
    expect(
      await failure(
        gw.api.setInstanceWorker({ ...worker, overrides: { settingsText: '[ui]\npermission_mode = "auto"' } }),
      ),
    ).toContain("Check the supported keys");
    const read = await gw.api.getInstanceWorker(worker);

    expect(read.inheritedRuntime?.settingsText).toBe(shared);
    expect(read.worker?.overrides?.settingsText).toBe(local);
  });

  test("an older worker blocks its configured instance, then reuses the same revision after updating", async () => {
    const added = await gw.addWorker("upgrading worker");
    const legacy = await gw.connect(added.workerId, added.credential);
    const worker = { ...nativeCodex, workerId: added.workerId };
    const settingsText = 'model_verbosity = "medium"\n';
    const status = async () => (await gw.api.getInstanceWorker(worker)).worker;
    await gw.api.setInstanceWorker({ ...worker, overrides: { settingsText } });

    const blocked = await eventually(status, (p) => p?.detail.includes("Update this worker") ?? false);
    expect(blocked).toMatchObject({ enabled: true, available: false, reported: true, synced: true });
    const config = legacy.configs.at(-1)!;
    expect(codexProfile(config)?.disabled).toBe(true);
    expect(config.profiles.find((p) => p.id === "native" && p.providers.includes(Provider.CLAUDE))?.disabled).toBe(
      false,
    );
    expect(codexProfile(gw.worker.configs.at(-1))).toMatchObject({ disabled: false, settingsOverrideText: "" });

    const upgraded = await gw.connect(added.workerId, added.credential, undefined, {
      hello: { capabilities: [PROVIDER_SETTINGS_CAPABILITY], configVersion: config.version },
    });

    const ready = await eventually(status, (p) => p?.available === true);
    expect(ready).toMatchObject({ enabled: true, available: true, synced: true });
    expect(upgraded.configs.at(-1)?.version).toBe(config.version);
    expect(codexProfile(upgraded.configs.at(-1))).toMatchObject({
      disabled: false,
      settingsOverrideText: settingsText,
    });
  });

  test("a native Antigravity instance reaches only a capable worker and can spawn another Antigravity thread", async () => {
    const provider = Provider.ANTIGRAVITY;
    const added = await gw.addWorker("agy studio", ["/studio"]);
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          added.workerId,
          {
            allowedRoots: ["/studio"],
            antigravity: { enabled: true },
          },
          gw.userId,
        ),
      ),
    );
    await gw.runtime.runPromise(InstanceStore.use((s) => s.sync(gw.userId, [added.workerId])));

    const studio = await gw.connect(added.workerId, added.credential, undefined, {
      antigravity: true,
      hello: { capabilities: [ANTIGRAVITY_ACP_CAPABILITY] },
    });

    const named = {
      harness: provider,
      id: "studio-agy",
      label: "Studio",
      create: true,
      kind: ProviderProfileKind.NATIVE,
    };

    expect(await failure(gw.api.saveProviderInstance({ ...named, kind: ProviderProfileKind.CLIPROXYAPI }))).toContain(
      "native connection",
    );
    expect(await failure(gw.api.saveProviderInstance({ ...named, runtime: { ownLogin: true } }))).toContain(
      "device login",
    );

    const saved = await gw.api.saveProviderInstance({
      ...named,
      workerIds: [gw.workerId, added.workerId],
      env: [{ name: "GEMINI_API_KEY", value: TOKEN }],
      runtime: { binaryPath: "/tools/agy", shadowHomePath: "/studio/skills" },
    });

    expect(saved.instance?.env).toMatchObject([{ name: "GEMINI_API_KEY", secret: true, value: "" }]);
    expect(JSON.stringify(await query("SELECT env FROM provider_instances WHERE harness='antigravity'"))).not.toContain(
      TOKEN,
    );
    expect(
      await eventually(
        () => pickable(added.workerId),
        (p) => p.includes("ANTIGRAVITY/studio-agy"),
      ),
    ).toContain("ANTIGRAVITY/studio-agy");
    const config = studio.configs.at(-1)!;
    expect(config.antigravity?.enabled).toBe(true);
    expect(config.profiles.find((p) => p.id === named.id)).toMatchObject({
      providers: [provider],
      env: [{ name: "GEMINI_API_KEY", secret: true, value: TOKEN }],
      executablePath: "/tools/agy",
      shadowHomePath: "/studio/skills",
    });
    expect(gw.worker.configs.flatMap((c) => c.profiles).some((p) => p.id === named.id)).toBe(false);

    const studioWorkspace = (
      await gw.api.createWorkspace({ projectId, workerId: added.workerId, rootPath: "/studio/project" })
    ).workspace!;

    const request = {
      projectId,
      workspaceId: studioWorkspace.id,
      provider,
      providerProfileId: named.id,
      title: "ACP thread",
    };

    expect(await failure(gw.api.createThread({ ...request, workspaceId }))).toContain("Update this worker");
    expect(await failure(gw.api.createThread({ ...request, permissionMode: PermissionMode.FULL_AUTO }))).toContain(
      "Choose Ask",
    );
    const thread = (await gw.api.createThread(request)).thread!;
    expect(await studio.createdThread(thread.id)).toMatchObject({
      provider,
      providerProfileId: named.id,
      permissionMode: PermissionMode.ASK,
    });
    expect(await failure(gw.api.setGoal({ threadId: thread.id, action: "set", objective: "finish" }))).toContain(
      "native goals",
    );
    const listed = await studio.callTool({ threadId: thread.id, tool: "list_agents", args: {} });
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain("antigravity/studio-agy");

    const spawned = await studio.callTool({
      threadId: thread.id,
      tool: "spawn_thread",
      args: {
        title: "Child",
        prompt: "read the file",
        provider: "antigravity/native",
        permission_mode: "read_only",
      },
    });

    expect(spawned.isError).toBe(false);
    const [child] = await query<{ id: string }>("SELECT id FROM threads WHERE parent_thread_id=$1::uuid", thread.id);
    expect(await studio.createdThread(child!.id)).toMatchObject({
      provider,
      providerProfileId: "",
      permissionMode: PermissionMode.READ_ONLY,
    });
  }, 30_000);
});
