import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { isBigInt } from "@canopy/testing";
import { createServer, type AddressInfo } from "node:net";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { qualifyId, REMOTE_THREADS, SHARED_CONFIG, sharedKey, THREAD_MIRROR } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, sharedHost, uiHandlers } from "@canopy/gateway/api";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { decryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import { eventually as poll, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const port = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const p = (server.address() as AddressInfo).port;
      server.close(() => resolve(p));
    });
  });

const eventually = async (predicate: () => Promise<boolean>) =>
  expect(await poll(predicate, Boolean, 20_000)).toBe(true);

const KEY = "sk-shared-config-key-a1b2c3d4e5f6";
const KEY_A2 = "sk-changed-on-a-offline-777";
const KEY_B2 = "sk-changed-on-b-offline-888";
const ORG_TOKEN = "org-token-secret-424242";
const INSTANCE = sharedKey.instance("codex", "team");
const APPEARANCE = sharedKey.settings("appearance");

describe.skipIf(!dockerAvailable)("shared configuration between two linked gateways", () => {
  let a: TestGateway;
  let b: TestGateway;
  let sa: ComputerStore;
  let sb: ComputerStore;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  let aPort: number;
  let bPort: number;
  let nodeA: string;
  let nodeB: string;
  const printed: string[] = [];

  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    }),
  );

  const start = (gateway: TestGateway, store: ComputerStore, linkPort: number, capabilities?: string[]) => {
    const own = uiHandlers(gateway.core);

    const computers = linkedComputers({
      store,
      host: "127.0.0.1",
      port: linkPort,
      heartbeatMs: 100,
      serve: remoteServe(own),
      shared: sharedHost(gateway.core, own),
      // Keep coverage of the retained 0050 protocol until the final configuration migration.
      capabilities: capabilities ?? ["presence", "unlink", REMOTE_THREADS, THREAD_MIRROR, SHARED_CONFIG],
    });

    gateway.core.computers = computers;

    gateway.core.network = computers.options.network;

    return computers;
  };

  const op = (computers: LinkedComputers, action: string, key: string, nodeId = "") =>
    computers.shared!.manage(create(ui.SharedConfigOperationSchema, { action, key, nodeId }));

  const online = () =>
    eventually(async () => la.shared!.peers.ready().includes(nodeB) && lb.shared!.peers.ready().includes(nodeA));

  async function offline() {
    await la.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
    );
    await lb.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
    );
    await eventually(async () => !la.reachable().length && !lb.reachable().length);
  }

  async function reconnect() {
    await la.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
    );
    await lb.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
    );
    await online();
  }

  const settings = async (gateway: TestGateway) => (await gateway.api.getSettings({})).user!;

  const updateSettings = async (
    gateway: TestGateway,
    change: Omit<MessageInitShape<typeof ui.UpdateUserSettingsRequestSchema>, "expectedVersion">,
  ) =>
    gateway.api.updateUserSettings(
      create(ui.UpdateUserSettingsRequestSchema, {
        ...change,
        expectedVersion: (await settings(gateway)).version,
      } as MessageInitShape<typeof ui.UpdateUserSettingsRequestSchema>),
    );

  const instance = async (gateway: TestGateway, id = "team") =>
    (await gateway.api.listProviderInstances({})).instances.find((i) => i.harness === Provider.CODEX && i.id === id);

  const conflicts = async (computers: LinkedComputers) => (await computers.shared!.snapshot()).conflicts;

  const item = async (computers: LinkedComputers, key: string) =>
    (await computers.shared!.snapshot()).items.find((i) => i.key === key);

  const apiKeyOf = async (gateway: TestGateway, key: Buffer) => {
    const row = (
      await (gateway === a ? sa : sb).query<{
        ciphertext: Uint8Array;
      }>(`SELECT s.ciphertext FROM provider_instances i JOIN secrets s ON s.id::text=i.api_key->>'secretRef'
      WHERE i.harness='codex' AND i.id='team'`)
    )[0]!;

    return { ciphertext: Buffer.from(row.ciphertext).toString("hex"), plain: decryptSecret(key, row.ciphertext) };
  };

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    // Each computer has its own CANOPY_SECRETS_KEY, as in production.
    sa = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    sb = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    aPort = await port();
    bPort = await port();
    la = start(a, sa, aPort);
    lb = start(b, sb, bPort);
    await la.start();
    await lb.start();
    nodeA = la.hello().nodeId;
    nodeB = lb.hello().nodeId;
    const pairing = await la.createPairing();
    await lb.pair(la.addresses[0]!, pairing.code);
    await online();
  }, 90_000);
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 20_000);

  test("a shared instance arrives with its API key re-encrypted under B's key, without A's local paths", async () => {
    await a.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "team",
      create: true,
      label: "Team proxy",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8317",
      apiKey: KEY,
      accentColor: "#7c3aed",
      allWorkers: true,
      env: [
        { name: "PROFILE_PROBE", secret: false, value: "probe-42" },
        { name: "ORG_TOKEN", secret: true, value: ORG_TOKEN },
      ],
      runtime: { binaryPath: "/opt/laptop-a/codex", launchArgs: ["--a-only"] },
    });
    // Not shared yet: nothing crosses.
    await Bun.sleep(500);
    expect(await instance(b)).toBeUndefined();

    await op(la, "share", INSTANCE);
    await eventually(
      async () => Boolean((await instance(b))?.apiKeySet) && Boolean((await item(lb, INSTANCE))?.shared),
    );
    const onB = (await instance(b))!;
    expect(onB).toMatchObject({
      label: "Team proxy",
      baseUrl: "http://127.0.0.1:8317",
      accentColor: "#7c3aed",
      allWorkers: true,
    });
    expect(onB.runtime).toMatchObject({ binaryPath: "", launchArgs: [] });
    expect(onB.env.map((v) => [v.name, v.secret, v.value])).toEqual([
      ["PROFILE_PROBE", false, "probe-42"],
      ["ORG_TOKEN", true, ""],
    ]);

    // Usable: B's worker receives the profile with the key.
    const config = await poll(
      async () => b.worker.configs.at(-1)!,
      (c) => c.profiles.some((p) => p.id === "team"),
      20_000,
    );

    expect(config.profiles.find((p) => p.id === "team")).toMatchObject({
      apiKey: KEY,
      baseUrl: "http://127.0.0.1:8317",
    });
    expect(config.profiles.find((p) => p.id === "team")!.env.find((v) => v.name === "ORG_TOKEN")?.value).toBe(
      ORG_TOKEN,
    );

    // Stored again with B's own key: different ciphertext, B decrypts, A's key does not.
    const [ka, kb] = [await apiKeyOf(a, a.secretsKey), await apiKeyOf(b, b.secretsKey)];
    expect(kb.plain).toBe(KEY);
    expect(kb.ciphertext).not.toBe(ka.ciphertext);
    expect(() => decryptSecret(a.secretsKey, Buffer.from(kb.ciphertext, "hex"))).toThrow();

    const shared = (await item(lb, INSTANCE))!;
    expect(shared).toMatchObject({ shared: true, changedByNodeId: nodeA });
    expect(await item(la, INSTANCE)).toMatchObject({ shared: true, changedByNodeId: "" });

    // Never to a browser or a log.
    const visible = JSON.stringify(
      [
        await b.api.listProviderInstances({}),
        await b.api.getSharedConfig({}),
        await a.api.getSharedConfig({}),
        await b.api.getOverview({}),
      ],
      (_k, v) => (isBigInt(v) ? v.toString() : v),
    );

    for (const secret of [KEY, ORG_TOKEN]) {
      expect(visible).not.toContain(secret);
      expect(printed.join("\n")).not.toContain(secret);
    }
  }, 40_000);

  test("favourites, settings and projects follow; workspaces, layout and unshared items stay local", async () => {
    await a.api.setInstanceModels({
      harness: Provider.CODEX,
      id: "native",
      models: { favorites: ["gpt-5-codex"], hidden: ["old-model"] },
    });
    await op(la, "share", sharedKey.models("codex", "native"));
    await updateSettings(a, {
      appearance: {
        colorScheme: ui.ColorScheme.DARK,
        accent: ui.AccentTheme.IRIS,
        lightTheme: ui.ColorTheme.FERN,
        darkTheme: ui.ColorTheme.HEATHER,
        chatWidth: ui.ChatWidth.WIDE,
        sidebarWidth: 333,
      },
    });
    await updateSettings(b, { appearance: { colorScheme: ui.ColorScheme.LIGHT, sidebarWidth: 280 } });
    // B has its own look already: sharing asks instead of overwriting it.
    await op(la, "share", APPEARANCE);
    await eventually(async () => (await conflicts(lb)).some((c) => c.key === APPEARANCE));
    const question = (await conflicts(lb)).find((c) => c.key === APPEARANCE)!;
    expect(question.nodeId).toBe(nodeA);
    expect(question.fields.find((f) => f.name === "Color scheme")).toMatchObject({ local: "Light", remote: "Dark" });
    expect(question.fields.find((f) => f.name === "Light theme")).toMatchObject({ local: "Default", remote: "Fern" });
    expect(question.fields.find((f) => f.name === "Dark theme")).toMatchObject({ local: "Default", remote: "Heather" });
    await op(lb, "keep_remote", APPEARANCE, nodeA);

    const project = (await a.api.createProject({ name: "Shared app" })).project!;

    const workspace = (
      await a.api.createWorkspace({ projectId: project.id, workerId: a.workerId, rootPath: "/repo/shared-app" })
    ).workspace!;

    await updateSettings(a, {
      threadDefaults: {
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ACCEPT_EDITS,
      },
      timezone: "Europe/Warsaw",
    });

    for (const key of [
      sharedKey.settings("thread_defaults"),
      sharedKey.settings("timezone"),
      sharedKey.project(project.id),
    ])
      await op(la, "share", key);
    await a.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "private",
      create: true,
      label: "Only on A",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:9",
      apiKey: "sk-private",
    });

    await eventually(async () => {
      const user = await settings(b);
      const own = (await b.api.getOverview({})).projects.find((p) => p.id === project.id && !p.nodeId);

      return (
        user.appearance?.colorScheme === ui.ColorScheme.DARK &&
        user.timezone === "Europe/Warsaw" &&
        user.threadDefaults?.permissionMode === PermissionMode.ACCEPT_EDITS &&
        Boolean(own) &&
        ((await instance(b, "native"))?.models?.favorites.includes("gpt-5-codex") ?? false)
      );
    });
    const user = await settings(b);
    expect(user.appearance).toMatchObject({
      accent: ui.AccentTheme.IRIS,
      lightTheme: ui.ColorTheme.FERN,
      darkTheme: ui.ColorTheme.HEATHER,
      chatWidth: ui.ChatWidth.WIDE,
      sidebarWidth: 280,
    });
    expect(user.threadDefaults?.workspaceId).toBe("");
    expect((await instance(b, "native"))!.models?.hidden).toEqual(["old-model"]);
    expect(await instance(b, "private")).toBeUndefined();
    // B already had the default thread settings: equal values still name the computer that shared them.
    expect((await item(lb, sharedKey.settings("thread_defaults")))?.changedByNodeId).toBe(nodeA);
    expect(await conflicts(la)).toEqual([]);
    expect(await conflicts(lb)).toEqual([]);

    // One project identity: listed once on B with A's workspace, and a thread on A's worker from B keeps the id.
    const overview = await b.api.getOverview({});
    const listed = overview.projects.filter((p) => p.id === project.id || p.id === qualifyId(project.id, nodeA));
    expect(listed).toHaveLength(1);
    expect(listed[0]!.workspaces.map((w) => w.id)).toEqual([qualifyId(workspace.id, nodeA)]);
    expect((await sb.query("SELECT 1 FROM project_workspaces WHERE project_id=$1::uuid", [project.id])).length).toBe(0);

    const created = (
      await b.api.createThread({
        projectId: project.id,
        workspaceId: qualifyId(workspace.id, nodeA),
        title: "From B",
        provider: Provider.CODEX,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    expect(created.projectId).toBe(project.id);
    expect(created.nodeId).toBe(nodeA);
    expect((await sa.query("SELECT 1 FROM threads WHERE id=$1::uuid", [created.id.split("~")[0]])).length).toBe(1);
    expect((await b.api.listThreads({ projectId: project.id })).threads.map((t) => t.id)).toContain(created.id);

    await a.api.renameProject({ projectId: project.id, name: "Shared app v2" });
    await eventually(async () =>
      (await b.api.getOverview({})).projects.some((p) => p.id === project.id && p.name === "Shared app v2"),
    );
  }, 60_000);

  test("offline edits of the same item ask on both computers, and either answer settles both", async () => {
    await offline();
    await updateSettings(a, { appearance: { colorScheme: ui.ColorScheme.DARK, accent: ui.AccentTheme.OCEAN } });
    await updateSettings(b, { appearance: { colorScheme: ui.ColorScheme.DARK, accent: ui.AccentTheme.ROSE } });
    await a.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "team",
      label: "Team proxy",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8317",
      apiKey: KEY_A2,
      env: [
        { name: "PROFILE_PROBE", secret: false, value: "probe-42" },
        { name: "ORG_TOKEN", secret: true },
      ],
    });
    await b.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "team",
      label: "Team proxy",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8317",
      apiKey: KEY_B2,
      env: [
        { name: "PROFILE_PROBE", secret: false, value: "probe-42" },
        { name: "ORG_TOKEN", secret: true },
      ],
    });
    await la.configChanged();
    await lb.configChanged();
    await reconnect();
    await eventually(async () => (await conflicts(la)).length === 2 && (await conflicts(lb)).length === 2);
    // No silent last-writer-wins: both computers keep their own value until answered.
    expect((await settings(a)).appearance?.accent).toBe(ui.AccentTheme.OCEAN);
    expect((await settings(b)).appearance?.accent).toBe(ui.AccentTheme.ROSE);
    const keyQuestion = (await conflicts(lb)).find((c) => c.key === INSTANCE)!;
    expect(keyQuestion.fields.find((f) => f.name === "API key")).toMatchObject({
      local: "Set",
      remote: "A different key",
    });
    expect(JSON.stringify(keyQuestion.fields)).not.toContain(KEY_A2);

    // Keep this computer's (A): B takes A's appearance and its question disappears.
    await op(la, "keep_local", APPEARANCE, nodeB);
    // Keep Laptop A's (on B): B uses A's key, decrypted from B's sealed copy of the question.
    await op(lb, "keep_remote", INSTANCE, nodeA);
    await eventually(async () => !(await conflicts(la)).length && !(await conflicts(lb)).length);
    await eventually(async () => (await settings(b)).appearance?.accent === ui.AccentTheme.OCEAN);
    expect((await apiKeyOf(b, b.secretsKey)).plain).toBe(KEY_A2);
    expect((await apiKeyOf(a, a.secretsKey)).plain).toBe(KEY_A2);
    expect(printed.join("\n")).not.toContain(KEY_B2);
  }, 60_000);

  test("non-conflicting offline edits merge in both directions", async () => {
    const project = (await a.api.getOverview({})).projects.find((p) => p.name === "Shared app v2")!;
    await offline();
    await updateSettings(a, { timezone: "America/New_York" });
    await b.api.renameProject({ projectId: project.id, name: "Renamed on B" });
    await reconnect();
    await eventually(
      async () =>
        (await settings(b)).timezone === "America/New_York" &&
        (await a.api.getOverview({})).projects.some((p) => p.id === project.id && p.name === "Renamed on B"),
    );
    expect(await conflicts(la)).toEqual([]);
    expect(await conflicts(lb)).toEqual([]);
    expect((await item(la, sharedKey.project(project.id)))?.changedByNodeId).toBe(nodeB);
  }, 40_000);

  test("a pending question survives a restart of both link runtimes and can be answered afterwards", async () => {
    await offline();
    await updateSettings(a, { appearance: { colorScheme: ui.ColorScheme.LIGHT } });
    await updateSettings(b, { appearance: { colorScheme: ui.ColorScheme.SYSTEM, accent: ui.AccentTheme.ROSE } });
    await reconnect();
    await eventually(async () => (await conflicts(la)).length === 1 && (await conflicts(lb)).length === 1);
    await Promise.all([la.close(), lb.close()]);
    la = start(a, sa, aPort);
    lb = start(b, sb, bPort);
    await la.start();
    await lb.start();
    expect((await conflicts(la)).map((c) => c.key)).toEqual([APPEARANCE]);
    await online();
    await op(lb, "keep_local", APPEARANCE, nodeA);
    await eventually(
      async () =>
        !(await conflicts(la)).length &&
        !(await conflicts(lb)).length &&
        (await settings(a)).appearance?.accent === ui.AccentTheme.ROSE,
    );
  }, 90_000);

  test("unsharing or deleting keeps a local copy on the other computer", async () => {
    await op(la, "unshare", INSTANCE);
    await eventually(async () => (await item(lb, INSTANCE))?.shared === false);
    expect(await item(lb, INSTANCE)).toMatchObject({ note: "unshared", noteNodeId: nodeA });
    expect((await instance(b))?.apiKeySet).toBe(true);
    await a.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "team",
      label: "Renamed after unsharing",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8317",
      env: [
        { name: "PROFILE_PROBE", secret: false, value: "probe-42" },
        { name: "ORG_TOKEN", secret: true },
      ],
    });
    await Bun.sleep(600);
    expect((await instance(b))?.label).toBe("Team proxy");

    const project = (await a.api.createProject({ name: "Archived later" })).project!;
    await op(la, "share", sharedKey.project(project.id));
    await eventually(async () => (await b.api.getOverview({})).projects.some((p) => p.id === project.id));
    await a.api.archiveProject({ projectId: project.id });
    await eventually(async () => (await item(lb, sharedKey.project(project.id)))?.note === "deleted");
    expect((await b.api.getOverview({})).projects.some((p) => p.id === project.id && !p.archivedAt)).toBe(true);
  }, 40_000);

  test("a computer without the capability keeps stages 1–3 and is reported as needing an update", async () => {
    await lb.close();
    lb = start(b, sb, bPort, ["presence", "unlink", REMOTE_THREADS, THREAD_MIRROR]);
    await lb.start();
    await eventually(async () => la.reachable().includes(nodeB));
    expect(la.shared!.peers.ready()).toEqual([]);
    expect((await la.shared!.snapshot()).needsUpdateNodeIds).toEqual([nodeB]);
    expect(lb.hello().capabilities).not.toContain(SHARED_CONFIG);
    await updateSettings(a, { timezone: "Asia/Tokyo" });
    await Bun.sleep(600);
    expect((await settings(b)).timezone).not.toBe("Asia/Tokyo");
    // Threads still work across the link.
    expect((await b.api.getOverview({})).workers.some((w) => w.nodeId === nodeA)).toBe(true);
    await lb.close();
    lb = start(b, sb, bPort);
    await lb.start();
    await online();
    await eventually(async () => (await settings(b)).timezone === "Asia/Tokyo");
  }, 60_000);

  test("unlinking removes acknowledgements and pending questions; values stay where they are", async () => {
    await offline();
    await updateSettings(a, { appearance: { colorScheme: ui.ColorScheme.DARK, accent: ui.AccentTheme.OCEAN } });
    await updateSettings(b, { appearance: { colorScheme: ui.ColorScheme.DARK, accent: ui.AccentTheme.IRIS } });
    await reconnect();
    await eventually(async () => (await conflicts(lb)).length === 1);
    await la.manage(create(ui.ComputerOperationRequestSchema, { action: "unlink", nodeId: nodeB }));
    await eventually(async () => !(await lb.store.peers()).length);

    for (const [store, owner] of [
      [sa, a.userId],
      [sb, b.userId],
    ] as const) {
      expect(await store.query("SELECT 1 FROM computer_shared_acks WHERE owner_user_id=$1::uuid", [owner])).toEqual([]);
      expect(
        await store.query("SELECT 1 FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid", [owner]),
      ).toEqual([]);
    }

    expect(await conflicts(lb)).toEqual([]);
    expect((await settings(b)).appearance?.accent).toBe(ui.AccentTheme.IRIS);
    expect((await settings(a)).timezone).toBe("Asia/Tokyo");
    expect(await failure(op(lb, "keep_remote", APPEARANCE, nodeA))).toContain("already answered");
  }, 40_000);
});
