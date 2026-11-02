/**
 * Provider profiles end to end on PostgreSQL (docs/worker-config.md, "Profile dostawców"): the user creates a
 * custom profile with an endpoint key and variables (some secret), the gateway stores secrets encrypted, never
 * returns them to the UI, and sends them to the worker in its configuration; threads run on the profile; a
 * model selection hides models from pickers (a thread on a hidden model keeps working); a profile in use cannot be
 * deleted, only disabled.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toJson } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ProviderProfileKind, ui } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const KEY = "sk-team-secret-4711";
const TOKEN = "tok-secret-value-0815";

let gw: TestGateway;
let projectId = "";
let workspaceId = "";

const query = <A extends object>(text: string, ...params: unknown[]) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.unsafe<A>(text, params as never[]);
    }),
  );
const lastConfig = () => gw.worker.configs.at(-1)!;
const profiles = async () => gw.api.listProviderProfiles({ workerId: gw.workerId });
const visible = (workers: ui.WorkerModels[], profileId: string) =>
  workers[0]!.profiles.find((p) => p.provider === Provider.CODEX && p.profileId === profileId)!.models.filter((m) => !m.hidden).map((m) => m.id);

describe.skipIf(!dockerAvailable)("provider profiles (gateway + scripted worker)", () => {
  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Profiles" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/app", label: "" })).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  test("the built-in device login profile is always listed", async () => {
    const listed = await profiles();
    expect(listed.profiles.map((p) => [p.id, p.builtIn, p.enabled])).toEqual([["native", true, true]]);
    expect(listed.configVersion).toBeGreaterThan(0n);
  });

  test("a custom profile: secrets encrypted at rest, never returned to the UI, sent to the worker", async () => {
    const before = await profiles();
    const saved = await gw.api.saveProviderProfile({
      workerId: gw.workerId,
      displayName: "Team proxy",
      kind: ProviderProfileKind.CLIPROXYAPI,
      providers: [Provider.CODEX],
      baseUrl: "http://127.0.0.1:8317",
      apiKey: KEY,
      env: [
        { name: "PROFILE_PROBE", secret: false, value: "probe-42" },
        { name: "TEAM_TOKEN", secret: true, value: TOKEN },
      ],
      enabled: true,
      expectedConfigVersion: before.configVersion,
    });
    expect(saved.configVersion).toBe(before.configVersion + 1n);
    expect(saved.profile).toMatchObject({ id: "team-proxy", displayName: "Team proxy", apiKeySet: true, enabled: true, builtIn: false });
    expect(saved.profile!.env.map((v) => [v.name, v.secret, v.value])).toEqual([
      ["PROFILE_PROBE", false, "probe-42"],
      ["TEAM_TOKEN", true, ""],
    ]);

    // Nothing the UI gets carries a secret: the save response, the list, the overview.
    const uiJson = JSON.stringify([
      toJson(ui.SaveProviderProfileResponseSchema, saved),
      toJson(ui.ListProviderProfilesResponseSchema, await profiles()),
      toJson(ui.GetOverviewResponseSchema, await gw.api.getOverview({})),
    ]);
    expect(uiJson).not.toContain(KEY);
    expect(uiJson).not.toContain(TOKEN);

    // At rest: references in the configuration and its history, ciphertext in secrets.
    const stored = await query<{ config: unknown }>("SELECT config FROM worker_config_history WHERE worker_id = $1::uuid", gw.workerId);
    expect(JSON.stringify(stored)).not.toContain(KEY);
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    const secrets = await query<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM secrets WHERE name LIKE 'profile-%'");
    expect(secrets).toHaveLength(2);
    for (const s of secrets) expect(Buffer.from(s.ciphertext).toString("utf8")).not.toMatch(/sk-team|tok-secret/);

    // The worker gets them in clear, in its configuration only.
    const config = await eventually(async () => lastConfig(), (c) => c.version === saved.configVersion);
    const team = config.profiles.find((p) => p.id === "team-proxy")!;
    expect(team).toMatchObject({ apiKey: KEY, displayName: "Team proxy", baseUrl: "http://127.0.0.1:8317" });
    expect(team.env.map((v) => [v.name, v.value, v.secret])).toEqual([
      ["PROFILE_PROBE", "probe-42", false],
      ["TEAM_TOKEN", TOKEN, true],
    ]);

    // The worker's report makes it available, under its name.
    const worker = await eventually(
      async () => (await gw.api.getOverview({})).workers[0]!,
      (w) => w.appliedVersion === saved.configVersion,
    );
    expect(worker.profiles.find((p) => p.id === "team-proxy")).toMatchObject({ available: true, displayName: "Team proxy" });
  });

  test("editing: a kept secret stays, a changed one is replaced, the old ciphertext is deleted", async () => {
    const current = await profiles();
    const saved = await gw.api.saveProviderProfile({
      workerId: gw.workerId,
      profileId: "team-proxy",
      displayName: "Team proxy (renamed)",
      kind: ProviderProfileKind.CLIPROXYAPI,
      providers: [Provider.CODEX],
      baseUrl: "http://127.0.0.1:8317",
      // api_key unset: kept
      env: [
        { name: "PROFILE_PROBE", secret: false, value: "probe-43" },
        { name: "TEAM_TOKEN", secret: true }, // value unset: kept
        { name: "OTHER_SECRET", secret: true, value: "other-1" },
      ],
      enabled: true,
      expectedConfigVersion: current.configVersion,
    });
    expect(saved.profile?.id).toBe("team-proxy");
    const config = await eventually(async () => lastConfig(), (c) => c.version === saved.configVersion);
    const team = config.profiles.find((p) => p.id === "team-proxy")!;
    expect(team.apiKey).toBe(KEY);
    expect(team.displayName).toBe("Team proxy (renamed)");
    expect(team.env.map((v) => v.value)).toEqual(["probe-43", TOKEN, "other-1"]);

    // Replace the key: the old secret row is gone, only referenced ones remain.
    const replaced = await gw.api.saveProviderProfile({
      workerId: gw.workerId, profileId: "team-proxy", displayName: "Team proxy", kind: ProviderProfileKind.CLIPROXYAPI, providers: [Provider.CODEX],
      baseUrl: "http://127.0.0.1:8317", apiKey: "sk-rotated", env: [{ name: "PROFILE_PROBE", value: "probe-42" }, { name: "TEAM_TOKEN", secret: true }], enabled: true,
      expectedConfigVersion: saved.configVersion,
    });
    expect((await eventually(async () => lastConfig(), (c) => c.version === replaced.configVersion)).profiles.find((p) => p.id === "team-proxy")!.apiKey).toBe("sk-rotated");
    const left = await query<{ n: string }>("SELECT count(*)::text AS n FROM secrets WHERE name LIKE 'profile-%'");
    expect(left[0]!.n).toBe("2"); // the new key and TEAM_TOKEN
  });

  test("validation: reserved variables, a secret without value, an old version, a disabled built-in", async () => {
    const { configVersion } = await profiles();
    const base = { workerId: gw.workerId, displayName: "X", kind: ProviderProfileKind.NATIVE, providers: [Provider.CODEX], enabled: true };
    expect(await failure(gw.api.saveProviderProfile({ ...base, env: [{ name: "CODEX_HOME", value: "/tmp" }] }))).toContain("controlled by the worker");
    expect(await failure(gw.api.saveProviderProfile({ ...base, env: [{ name: "OPENAGENTS_X_API_KEY", value: "1" }] }))).toContain("reserved");
    expect(await failure(gw.api.saveProviderProfile({ ...base, kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://x", env: [{ name: "ANTHROPIC_BASE_URL", value: "http://y" }] }))).toContain("endpoint");
    expect(await failure(gw.api.saveProviderProfile({ ...base, env: [{ name: "NEW_SECRET", secret: true }] }))).toContain("enter the secret value");
    expect(await failure(gw.api.saveProviderProfile({ ...base, expectedConfigVersion: configVersion - 1n }))).toContain("changed");
    expect(await failure(gw.api.saveProviderProfile({ ...base, profileId: "native", enabled: false }))).toContain("cannot be disabled");
    expect(await failure(gw.api.deleteProviderProfile({ workerId: gw.workerId, profileId: "native" }))).toContain("cannot be deleted");
    expect((await profiles()).configVersion).toBe(configVersion);
  });

  test("threads run on the profile; a model selection hides models from pickers only", async () => {
    const thread = (
      await gw.api.createThread({
        projectId, workspaceId, title: "on team", provider: Provider.CODEX, providerProfileId: "team-proxy", permissionMode: PermissionMode.ASK,
        clientRequestId: "create-team", model: "gpt-6.1-sol",
      })
    ).thread!;
    await gw.api.sendMessage({ threadId: thread.id, text: "hello", clientRequestId: "m1" });
    await eventually(async () => [...gw.worker.turnSettings.values()], (t) => t.length > 0);
    const start = gw.worker.commands.find((c) => c.case === "startTurn");
    expect(start?.case === "startTurn" && start.value.thread?.providerProfileId).toBe("team-proxy");

    const known = ["gpt-6.1-sol", "gpt-5.5"];
    const set = await gw.api.setModelSelection({ workerId: gw.workerId, profileId: "team-proxy", provider: Provider.CODEX, shown: ["gpt-5.5"], known, showNew: false });
    expect(set.selection).toMatchObject({ shown: ["gpt-5.5"], showNew: false });

    // Pickers: hidden; the settings screen: the full catalog; other profiles untouched.
    expect(visible((await gw.api.listModels({ workerId: gw.workerId })).workers, "team-proxy")).toEqual(["gpt-5.5"]);
    expect(visible((await gw.api.listModels({ workerId: gw.workerId, unfiltered: true })).workers, "team-proxy")).toEqual(known);
    expect(visible((await gw.api.listModels({ workerId: gw.workerId })).workers, "native")).toEqual(known);
    // A new model from a later listing follows show_new (here: hidden).
    const [codex] = gw.worker.models;
    gw.worker.models = [{ provider: Provider.CODEX, profileId: "native", models: [...(codex?.models ?? []), { id: "gpt-7", displayName: "GPT-7" }] }];
    expect(visible((await gw.api.listModels({ workerId: gw.workerId, refresh: true })).workers, "team-proxy")).toEqual(["gpt-5.5"]);
    expect(visible((await gw.api.listModels({ workerId: gw.workerId })).workers, "native")).toEqual([...known, "gpt-7"]);

    // The thread on the now hidden model keeps working, with its model.
    await gw.api.sendMessage({ threadId: thread.id, text: "again", clientRequestId: "m2", model: "gpt-6.1-sol" });
    await eventually(async () => [...gw.worker.turnSettings.values()], (t) => t.length > 1);
    expect([...gw.worker.turnSettings.values()].map((t) => t.model)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol"]);
    expect((await profiles()).profiles.find((p) => p.id === "team-proxy")).toMatchObject({ threadCount: 1 });

    await gw.api.setModelSelection({ workerId: gw.workerId, profileId: "team-proxy", provider: Provider.CODEX, showAll: true });
    expect(visible((await gw.api.listModels({ workerId: gw.workerId })).workers, "team-proxy")).toEqual([...known, "gpt-7"]);
  });

  test("a profile in use cannot be deleted, only disabled; an unused one is deleted with its secrets", async () => {
    expect(await failure(gw.api.deleteProviderProfile({ workerId: gw.workerId, profileId: "team-proxy" }))).toContain("disable it instead");
    const team = (await profiles()).profiles.find((p) => p.id === "team-proxy")!;
    const disabled = await gw.api.saveProviderProfile({
      workerId: gw.workerId, profileId: "team-proxy", displayName: team.displayName, kind: team.kind, providers: team.providers, baseUrl: team.baseUrl,
      env: team.env.map((v) => ({ name: v.name, secret: v.secret, ...(!v.secret && { value: v.value }) })), enabled: false,
    });
    await eventually(async () => (await gw.api.getOverview({})).workers[0]!, (w) => w.appliedVersion === disabled.configVersion);
    expect((await profiles()).profiles.find((p) => p.id === "team-proxy")).toMatchObject({ enabled: false, available: false, detail: "disabled", apiKeySet: true });
    // New threads are refused on it.
    expect(
      await failure(gw.api.createThread({ projectId, workspaceId, title: "x", provider: Provider.CODEX, providerProfileId: "team-proxy", permissionMode: PermissionMode.ASK, clientRequestId: "c-x" })),
    ).toContain("team-proxy");

    const spare = await gw.api.saveProviderProfile({
      workerId: gw.workerId, displayName: "Spare", kind: ProviderProfileKind.NATIVE, providers: [Provider.CLAUDE], env: [{ name: "SPARE_SECRET", secret: true, value: "s" }], enabled: true,
    });
    expect(spare.profile?.id).toBe("spare");
    const before = await query<{ n: string }>("SELECT count(*)::text AS n FROM secrets WHERE name LIKE 'profile-%'");
    await gw.api.deleteProviderProfile({ workerId: gw.workerId, profileId: "spare", expectedConfigVersion: spare.configVersion });
    const after = await query<{ n: string }>("SELECT count(*)::text AS n FROM secrets WHERE name LIKE 'profile-%'");
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n) - 1);
    expect((await profiles()).profiles.map((p) => p.id)).toEqual(["native", "team-proxy"]);
  });
});
