/**
 * Global provider instances end to end on PostgreSQL (docs/worker-config.md, section 9): an instance defined once in
 * the gateway with an endpoint key and variables is synced only to the workers it is enabled on (as a new version
 * of their configuration), with per-worker overrides merged in; secrets never reach the UI; pickers see per worker
 * only the instances enabled and available there, with the instance's model choices; a thread keeps its instance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJson } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ProviderProfileKind, ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

const KEY = "sk-team-secret-4711";
const TOKEN = "tok-secret-value-0815";
const KEY_B = "sk-worker-b-0042";

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
  (await workerOf(id)).providerInstances.filter((i) => i.enabled && i.available).map((i) => `${Provider[i.harness]}/${i.id}`);
const visible = (workers: ui.WorkerModels[], profileId: string) =>
  workers[0]!.profiles.find((p) => p.provider === Provider.CODEX && p.profileId === profileId)!.models.filter((m) => !m.hidden).map((m) => m.id);

describe.skipIf(!dockerAvailable)("global provider instances (gateway + two scripted workers)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    const added = await gw.addWorker("desktop", ["/srv"]);
    workerBId = added.workerId;
    workerB = await gw.connect(added.workerId, added.credential);
    projectId = (await gw.api.createProject({ name: "Instances" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app", label: "" })).workspace!.id;
    await eventually(() => workerOf(workerBId), (w) => w.appliedVersion > 0n);
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("the built-in device logins exist for every harness on every worker", async () => {
    const listed = await instances();
    expect(listed.map((i) => [Provider[i.harness], i.id, i.builtIn, i.allWorkers])).toEqual([
      ["CLAUDE", "native", true, true],
      ["CODEX", "native", true, true],
      ["GROK", "native", true, true],
    ]);
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
      runtime: { launchArgs: ["-c", "model_verbosity=\"low\""] },
      accentColor: "#7C3AED",
      workerIds: [gw.workerId],
    });
    expect(saved.instance).toMatchObject({ id: "team", label: "Team proxy", apiKeySet: true, accentColor: "#7c3aed", allWorkers: false });

    const config = await eventually(async () => gw.worker.configs.at(-1)!, (c) => c.profiles.some((p) => p.id === "team"));
    const profile = config.profiles.find((p) => p.id === "team")!;
    expect(profile).toMatchObject({ apiKey: KEY, displayName: "Team proxy", baseUrl: "http://127.0.0.1:8317", providers: [Provider.CODEX], launchArgs: ["-c", "model_verbosity=\"low\""] });
    expect(profile.env.map((v) => [v.name, v.value, v.secret])).toEqual([
      ["PROFILE_PROBE", "probe-42", false],
      ["TEAM_TOKEN", TOKEN, true],
    ]);
    // B got no new version and nothing of the instance.
    expect((await workerOf(workerBId)).configVersion).toBe(versionB);
    expect(workerB.configs.flatMap((c) => c.profiles).some((p) => p.id === "team")).toBe(false);

    await eventually(() => pickable(gw.workerId), (p) => p.includes("CODEX/team"));
    expect(await pickable(gw.workerId)).toEqual(["CODEX/native", "CODEX/team"]);
    expect(await pickable(workerBId)).toEqual(["CODEX/native"]);
    const onA = (await team()).workers.find((w) => w.workerId === gw.workerId)!;
    expect(onA).toMatchObject({ enabled: true, reported: true, available: true, auth: "endpoint key", authenticated: true, version: "0.164.0", synced: true });

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
      overrides: { baseUrl: "http://10.0.0.5:8317", apiKey: KEY_B, env: [{ name: "PROFILE_PROBE", value: "probe-b" }], launchArgsSet: true, launchArgs: [], binaryPath: "/opt/codex/bin/codex" },
    });
    const onB = enabled.instance!.workers.find((w) => w.workerId === workerBId)!;
    expect(onB).toMatchObject({ enabled: true, explicit: true, overrides: { baseUrl: "http://10.0.0.5:8317", apiKeySet: true, launchArgsSet: true, binaryPath: "/opt/codex/bin/codex" } });
    expect(JSON.stringify(toJson(ui.SetInstanceWorkerResponseSchema, enabled))).not.toContain(KEY_B);

    const config = await eventually(async () => workerB.configs.at(-1)!, (c) => c.profiles.some((p) => p.id === "team"));
    const profile = config.profiles.find((p) => p.id === "team")!;
    expect(profile).toMatchObject({ apiKey: KEY_B, baseUrl: "http://10.0.0.5:8317", launchArgs: [], executablePath: "/opt/codex/bin/codex" });
    expect(profile.env.map((v) => [v.name, v.value])).toEqual([
      ["PROFILE_PROBE", "probe-b"],
      ["TEAM_TOKEN", TOKEN],
    ]);
    // A is unchanged.
    expect(gw.worker.configs.at(-1)!.profiles.find((p) => p.id === "team")).toMatchObject({ apiKey: KEY, baseUrl: "http://127.0.0.1:8317" });
  });

  test("validation: ids, reserved variables, a secret without value, an old revision, the built-in", async () => {
    const base = { harness: Provider.CODEX, label: "X", kind: ProviderProfileKind.NATIVE, create: true };
    expect(await failure(gw.api.saveProviderInstance({ ...base, id: "Bad Id" }))).toContain("lowercase");
    expect(await failure(gw.api.saveProviderInstance({ ...base, id: "team" }))).toContain("already has");
    expect(await failure(gw.api.saveProviderInstance({ ...base, id: "x", env: [{ name: "CODEX_HOME", value: "/tmp" }] }))).toContain("controlled by the worker");
    expect(await failure(gw.api.saveProviderInstance({ ...base, id: "x", env: [{ name: "NEW_SECRET", secret: true }] }))).toContain("enter the secret value");
    expect(await failure(gw.api.saveProviderInstance({ ...base, id: "x", accentColor: "red" }))).toContain("#rrggbb");
    const current = await team();
    expect(await failure(gw.api.saveProviderInstance({ harness: Provider.CODEX, id: "team", label: "Y", kind: current.kind, baseUrl: current.baseUrl, expectedRevision: current.revision + 1n }))).toContain("changed");
    expect(await failure(gw.api.deleteProviderInstance({ harness: Provider.CODEX, id: "native" }))).toContain("cannot be deleted");
  });

  test("threads run on the instance; model choices change pickers only; a thread on a hidden model keeps working", async () => {
    const thread = (
      await gw.api.createThread({
        projectId, workspaceId, title: "on team", provider: Provider.CODEX, providerProfileId: "team", permissionMode: PermissionMode.ASK, clientRequestId: "c-team", model: "gpt-6.1-sol",
      })
    ).thread!;
    await gw.api.sendMessage({ threadId: thread.id, text: "hello", clientRequestId: "m1" });
    await eventually(async () => [...gw.worker.turnSettings.values()], (t) => t.length > 0);
    const start = gw.worker.commands.find((c) => c.case === "startTurn");
    expect(start?.case === "startTurn" && start.value.thread?.providerProfileId).toBe("team");

    await gw.api.setInstanceModels({ harness: Provider.CODEX, id: "team", models: { favorites: ["gpt-5.5"], hidden: ["gpt-6.1-sol"], custom: ["my-fine-tune"] } });
    expect(visible((await gw.api.listModels({ workerId: gw.workerId })).workers, "team")).toEqual(["gpt-5.5", "my-fine-tune"]);
    expect(visible((await gw.api.listModels({ workerId: gw.workerId, unfiltered: true })).workers, "team")).toEqual(["gpt-6.1-sol", "gpt-5.5"]);
    expect(visible((await gw.api.listModels({ workerId: gw.workerId })).workers, "native")).toEqual(["gpt-6.1-sol", "gpt-5.5"]);
    expect((await workerOf(gw.workerId)).providerInstances.find((i) => i.id === "team")!.favorites).toEqual(["gpt-5.5"]);

    // The hidden model still runs; a custom model is accepted although the catalog does not list it.
    await gw.api.sendMessage({ threadId: thread.id, text: "again", clientRequestId: "m2", model: "gpt-6.1-sol" });
    await gw.api.sendMessage({ threadId: thread.id, text: "custom", clientRequestId: "m3", model: "my-fine-tune" });
    await eventually(async () => [...gw.worker.turnSettings.values()], (t) => t.length > 2);
    expect([...gw.worker.turnSettings.values()].map((t) => t.model)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol", "my-fine-tune"]);
  });

  test("turned off on A: gone from A's picker, new threads refused, the thread says why; in use it cannot be deleted", async () => {
    expect(await failure(gw.api.deleteProviderInstance({ harness: Provider.CODEX, id: "team" }))).toContain("turn it off instead");
    await gw.api.setInstanceWorker({ harness: Provider.CODEX, id: "team", workerId: gw.workerId, enabled: false });
    // A keeps a stub without secrets for its thread; the worker reports it disabled.
    const config = await eventually(async () => gw.worker.configs.at(-1)!, (c) => c.profiles.find((p) => p.id === "team")?.disabled === true);
    expect(config.profiles.find((p) => p.id === "team")).toMatchObject({ disabled: true, apiKey: "", env: [] });
    await eventually(() => pickable(gw.workerId), (p) => !p.includes("CODEX/team"));
    expect(await pickable(gw.workerId)).toEqual(["CODEX/native"]);
    expect(await pickable(workerBId)).toEqual(["CODEX/native", "CODEX/team"]);
    expect(
      await failure(gw.api.createThread({ projectId, workspaceId, title: "x", provider: Provider.CODEX, providerProfileId: "team", permissionMode: PermissionMode.ASK, clientRequestId: "c-x" })),
    ).toContain("turned off");
  });

  test("all workers, and an unused instance is deleted with its secrets", async () => {
    const spare = await gw.api.saveProviderInstance({
      harness: Provider.CLAUDE, id: "spare", create: true, label: "Spare", kind: ProviderProfileKind.NATIVE, env: [{ name: "SPARE_SECRET", secret: true, value: "s" }], allWorkers: true,
    });
    expect(spare.instance!.workers.every((w) => w.enabled)).toBe(true);
    await eventually(async () => workerB.configs.at(-1)!, (c) => c.profiles.some((p) => p.id === "spare"));
    const count = async () => Number((await query<{ n: string }>("SELECT count(*)::text AS n FROM secrets WHERE name LIKE 'instance-%'"))[0]!.n);
    const before = await count();
    await gw.api.deleteProviderInstance({ harness: Provider.CLAUDE, id: "spare", expectedRevision: spare.instance!.revision });
    expect(await count()).toBe(before - 1);
    await eventually(async () => workerB.configs.at(-1)!, (c) => !c.profiles.some((p) => p.id === "spare"));
    expect((await instances()).map((i) => `${Provider[i.harness]}/${i.id}`)).toEqual(["CLAUDE/native", "CODEX/native", "CODEX/team", "GROK/native"]);
  });
});
