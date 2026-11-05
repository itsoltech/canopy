import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink, PermissionMode, Provider, ui } from "@canopy/contracts";
import { isBigInt, tempDir } from "@canopy/testing";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { wireItem } from "../../apps/gateway/src/config-sync/merge.ts";
import type { ConfigRow } from "../../apps/gateway/src/config-sync/persistence.ts";
import { versionKey } from "../../apps/gateway/src/config-sync/secrets.ts";
import { decryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import { SourceDatabase } from "../../apps/gateway/src/agent-environment/source-database.ts";
import { fakeConnector } from "./support/connector.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually, failure } from "./support/gateway.ts";
import { sourceRepository } from "./support/skill-sources.ts";
import { librarySkill } from "./support/agent-skills.ts";

const root = tempDir("canopy-shared-connector-sources-");
const repo = sourceRepository(root, "shared-source");
const sources = { fixtureRepo: (url: string) => (url === "https://example.test/shared.git" ? repo.bare : undefined) };

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

const accounts = async (c: ConfigComputer) => (await c.gateway.api.listConnectors({})).accounts;
const account = async (c: ConfigComputer, id: string) => (await accounts(c)).find((a) => a.id === id);
const json = <T>(value: T) => JSON.stringify(value, (_name, v) => (isBigInt(v) ? v.toString() : v));

async function signIn(c: ConfigComputer, fake: ReturnType<typeof fakeConnector>, name: string) {
  const saved = (
    await c.gateway.api.saveConnectorAccount({ connectorType: "notion", name, url: fake.url, authKind: "oauth" })
  ).account!;

  const binding = crypto.randomUUID().replaceAll("-", "");

  const begin = await c.gateway.api.beginConnectorOAuth({
    accountId: saved.id,
    browserBinding: binding,
    redirectUri: "http://127.0.0.1:19119/api/connectors/oauth/callback",
  });

  const response = await fetch(begin.authorizationUrl, { redirect: "manual" });
  const callback = new URL(response.headers.get("location")!);

  const complete = await c.gateway.api.completeConnectorOAuth({
    state: callback.searchParams.get("state")!,
    code: callback.searchParams.get("code")!,
    issuer: callback.searchParams.get("iss")!,
    browserBinding: binding,
  });

  expect(complete.error).toBe("");

  return complete.account!;
}

async function rename(c: ConfigComputer, id: string, name: string) {
  return c.gateway.api.saveConnectorAccount({ id, name, expectedRevision: (await account(c, id))!.revision });
}

const credentials = (c: ConfigComputer, id: string) =>
  c.gateway.runtime.runPromise(
    GatewayStore.use((s) => Effect.flatMap(s.connectors.owned(c.gateway.userId, id), s.connectors.credentials)),
  );

describe.skipIf(!dockerAvailable)("shared connectors across separate linked databases", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let fake: ReturnType<typeof fakeConnector>;
  let id = "";
  const printed: string[] = [];

  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    }),
  );

  beforeAll(async () => {
    fake = fakeConnector({ accountId: "workspace-fixture" });
    repo.skill("skills/shared-source", "shared-source");
    repo.commit();
    a = await configComputer("Laptop A", undefined, sources);
    b = await configComputer("Laptop B", undefined, sources);
    fake.duration = 1;
    id = (await signIn(a, fake, "Work")).id;
    await a.gateway.api.setConnectorAccess({
      accountId: id,
      allWorkers: true,
      allBots: true,
      workerIds: [a.gateway.workerId],
      expectedRevision: (await account(a, id))!.revision,
    });
    await pairConfig(a, b);
    await wait(() => configAllowed(a.links, b.node) && configAllowed(b.links, a.node));
    await wait(async () => (await account(b, id))?.status === "connected");
  }, 120_000);
  afterAll(async () => {
    await a?.close();
    await b?.close();
    await fake?.close();

    for (const spy of spies) spy.mockRestore();
  }, 30_000);

  test("rotated credentials beat B's old refresh token and recover its local reconnect status", async () => {
    const stale = (
      await a.store.query<ConfigRow>("SELECT * FROM config_items WHERE kind='connector' AND local_id=$1", [id])
    )[0]!;

    const old = JSON.stringify(await credentials(a, id));
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    fake.duration = 3600;
    await a.gateway.api.testConnector({ accountId: id });
    expect(fake.refreshes).toBe(1);
    expect(await failure(b.gateway.api.testConnector({ accountId: id }))).toContain("reconnect");
    expect((await account(b, id))?.status).toBe("needs_reconnect");
    const newest = await credentials(a, id);
    expect(newest.tokens?.refresh_token === JSON.parse(old).tokens.refresh_token).toBe(false);
    await a.sharing(b.node, true);
    await wait(async () => (await credentials(b, id)).tokens?.refresh_token === newest.tokens?.refresh_token);
    expect((await account(b, id))?.status).toBe("connected");

    // Delayed replay carries the real older secret with its older clock; it cannot replace the rotation.
    const field = stale.fields["credentials"]!;
    const secrets = new Map([[versionKey("connector", stale.global_id, "credentials", field.hlc), old]]);
    await b.links.config!.receive(
      a.node,
      create(computerLink.ConfigUpdateSchema, { items: [wireItem(stale, secrets)] }),
      () => true,
    );
    expect((await credentials(b, id)).tokens?.refresh_token === newest.tokens?.refresh_token).toBe(true);
    expect(fake.refreshes).toBe(1);
  }, 45_000);

  test("A's connected account runs through B's worker without sign-in; machine state and grants stay at home", async () => {
    const onA = (await account(a, id))!;
    const onB = (await account(b, id))!;
    expect(onB.allWorkers).toBe(true);
    expect(onB.allBots).toBe(true);
    // A's worker grant is A's: B lists it from A's worker record and stores no grant of its own.
    expect(onB.workerIds).toEqual([`${a.gateway.workerId}~${a.node.slice(0, 16)}`]);
    expect(await b.store.query("SELECT 1 FROM connector_worker_grants WHERE account_id=$1::uuid", [id])).toHaveLength(
      0,
    );
    expect(onB.namespace).not.toBe(onA.namespace);
    b.gateway.worker.holdTurns = true;
    const project = (await b.gateway.api.createProject({ name: "Connector use" })).project!;

    const workspace = (
      await b.gateway.api.createWorkspace({ projectId: project.id, workerId: b.gateway.workerId, rootPath: "/repo" })
    ).workspace!;

    const thread = (
      await b.gateway.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        permissionMode: PermissionMode.FULL_AUTO,
        initialMessage: "Use the shared account",
      })
    ).thread!;

    const turns = await eventually(
      () =>
        b.store.query<{ id: string; status: string }>("SELECT id,status FROM turns WHERE thread_id=$1::uuid", [
          thread.id,
        ]),
      (r) => r[0]?.status === "running",
    );

    const tools = (await b.gateway.api.testConnector({ accountId: id })).tools;
    const read = tools.find((t) => t.remoteName === "read_marker")!;
    expect(read.name.startsWith(onB.namespace)).toBe(true);

    const result = await b.gateway.worker.callTool({
      threadId: thread.id,
      turnId: turns[0]!.id,
      connectorAccountId: id,
      tool: read.name,
      args: { marker: "SHARED_ACCOUNT_WORKS" },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("SHARED_ACCOUNT_WORKS");
    expect(result.content).toContain("[REDACTED]");
    expect(fake.registrations).toBe(1);
    expect((await account(b, id))?.lastUsedAt).toBeDefined();
    expect((await account(a, id))?.lastUsedAt).toBeUndefined();

    const aCipher = (
      await a.store.query<{ credentials: Uint8Array }>("SELECT credentials FROM connector_accounts WHERE id=$1::uuid", [
        id,
      ])
    )[0]!.credentials;

    const bCipher = (
      await b.store.query<{ credentials: Uint8Array }>("SELECT credentials FROM connector_accounts WHERE id=$1::uuid", [
        id,
      ])
    )[0]!.credentials;

    expect(Buffer.from(aCipher).equals(Buffer.from(bCipher))).toBe(false);
    expect(() => decryptSecret(a.gateway.secretsKey, bCipher)).toThrow();
  }, 40_000);

  test("test diagnostics and recovery stay local without publishing configuration revisions", async () => {
    const saved = (
      await a.gateway.api.saveConnectorAccount({
        connectorType: "custom",
        name: "Local diagnosis",
        url: fake.url,
        token: fake.secret,
      })
    ).account!;

    const probeId = saved.id;
    await wait(async () => !!(await account(b, probeId)));
    expect((await a.gateway.api.testConnector({ accountId: probeId })).tools).toHaveLength(2);
    await wait(
      async () =>
        (
          await b.store.query<{ count: number }>(
            "SELECT jsonb_array_length(tools) AS count FROM connector_accounts WHERE id=$1::uuid",
            [probeId],
          )
        )[0]?.count === 2,
    );
    expect((await b.gateway.api.testConnector({ accountId: probeId })).tools).toHaveLength(2);

    const state = async (c: ConfigComputer) => {
      const row = (
        await c.store.query<ConfigRow>("SELECT * FROM config_items WHERE kind='connector' AND local_id=$1", [probeId])
      )[0]!;

      return { fields: row.fields, revision: row.revision, localRevision: (await account(c, probeId))!.revision };
    };

    const beforeA = await state(a);
    const beforeB = await state(b);

    try {
      fake.failCatalog = true;
      const failed = (await a.gateway.api.testConnector({ accountId: probeId })).account!;
      expect(failed.status).toBe("error");
      expect(failed.error).toMatchObject({ kind: "http" });
      const diagnosis = failed.error!;
      fake.failCatalog = false;
      // Force the same scan performed at restart; runtime fields must never become shared fields.
      await a.links.config!.start();
      await b.links.config!.start();
      expect(await state(a)).toEqual(beforeA);
      expect(await state(b)).toEqual(beforeB);
      expect((await account(b, probeId))?.status).toBe("connected");
      expect((await account(b, probeId))?.error).toBeUndefined();
      expect(Object.keys((await state(a)).fields)).not.toContain("error");
      expect(Object.keys((await state(a)).fields)).not.toContain("status");

      // B can still use the account; the unchanged catalog must not erase A's error or bump revisions.
      expect((await b.gateway.api.testConnector({ accountId: probeId })).tools).toHaveLength(2);
      expect(await state(a)).toEqual(beforeA);
      expect(await state(b)).toEqual(beforeB);
      expect((await account(a, probeId))?.error).toEqual(diagnosis);

      expect((await a.gateway.api.testConnector({ accountId: probeId })).account?.status).toBe("connected");
      expect((await account(a, probeId))?.error).toBeUndefined();
      expect(await state(a)).toEqual(beforeA);
      expect(await state(b)).toEqual(beforeB);
      fake.failCatalog = true;
      expect((await a.gateway.api.testConnector({ accountId: probeId })).account?.status).toBe("error");
      fake.failCatalog = false;

      // A real shared metadata change is delivered, while the diagnosis stays on its own gateway.
      await rename(b, probeId, "Renamed diagnostic account");
      await wait(async () => (await account(a, probeId))?.name === "Renamed diagnostic account");
      expect((await account(a, probeId))?.status).toBe("error");
      expect((await account(a, probeId))?.error).toEqual(diagnosis);
      expect((await account(b, probeId))?.error).toBeUndefined();
      expect((await a.gateway.api.testConnector({ accountId: probeId })).account?.status).toBe("connected");
      expect((await account(a, probeId))?.error).toBeUndefined();

      // A new diagnosis survives a remote catalog update, but new credentials invalidate it.
      fake.failCatalog = true;
      expect((await a.gateway.api.testConnector({ accountId: probeId })).account?.status).toBe("error");
      fake.failCatalog = false;
      const oldToolsClock = (await state(b)).fields["tools"]!.hlc;
      fake.readOnlyTools = [];
      await b.gateway.api.testConnector({ accountId: probeId });
      const newToolsClock = (await state(b)).fields["tools"]!.hlc;
      expect(newToolsClock).not.toBe(oldToolsClock);
      await wait(async () => (await state(a)).fields["tools"]?.hlc === newToolsClock);
      expect((await account(a, probeId))?.error).toBeDefined();
      await b.gateway.api.saveConnectorAccount({
        id: probeId,
        name: "Renamed diagnostic account",
        expectedRevision: (await account(b, probeId))!.revision,
        token: fake.secret,
        headers: { "X-Replacement": "replacement-header-private-fixture" },
      });
      await wait(
        async () => (await credentials(a, probeId)).headers?.["X-Replacement"] === "replacement-header-private-fixture",
      );
      expect((await account(a, probeId))?.status).toBe("connected");
      expect((await account(a, probeId))?.error).toBeUndefined();
      expect(
        (
          await a.store.query<{ cleared: boolean }>(
            "SELECT error IS NULL AS cleared FROM connector_accounts WHERE id=$1::uuid",
            [probeId],
          )
        )[0]?.cleared,
      ).toBe(true);
      const visible = json([await state(a), await state(b), printed]);
      expect(visible.includes(fake.secret)).toBe(false);
      expect(visible.includes("replacement-header-private-fixture")).toBe(false);
    } finally {
      fake.failCatalog = false;
      fake.readOnlyTools = ["read_marker"];
      await a.gateway.api.deleteConnectorAccount({ accountId: probeId });
      await wait(async () => !(await account(b, probeId)));

      for (const notice of (await b.links.snapshot()).configNotices.filter((n) => n.globalId === probeId))
        await b.gateway.api.manageConfigNotice({ id: notice.id, action: "dismiss" });
    }
  }, 40_000);

  test("concurrent rename shows a notice; Restore becomes a new shared change", async () => {
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    await rename(a, id, "Work A");
    await rename(b, id, "Work B");
    await a.sharing(b.node, true);
    await wait(async () => (await account(a, id))?.name === (await account(b, id))?.name);
    const notices = (await a.links.snapshot()).configNotices;
    await wait(async () =>
      [...notices, ...(await b.links.snapshot()).configNotices].some(
        (n) => n.kind === "connector" && n.field === "name",
      ),
    );
    const side = notices.some((n) => n.kind === "connector" && n.field === "name") ? a : b;

    const notice = (await side.links.snapshot()).configNotices.find(
      (n) => n.kind === "connector" && n.field === "name",
    )!;

    expect(notice.reason).toBe("concurrent");
    const lost = JSON.parse(notice.value);
    await side.gateway.api.manageConfigNotice({ id: notice.id, action: "restore" });
    await wait(async () => (await account(a, id))?.name === lost && (await account(b, id))?.name === lost);
  }, 40_000);

  test("delete is shared, with one Restore notice retaining encrypted working credentials", async () => {
    const before = fake.revoked.length;
    await a.gateway.api.deleteConnectorAccount({ accountId: id });
    await wait(async () => !(await account(b, id)));
    expect(fake.revoked.length).toBe(before);

    const notices = (await b.links.snapshot()).configNotices.filter(
      (n) => n.kind === "connector" && n.field === "deleted",
    );

    expect(notices).toHaveLength(1);
    expect(notices[0]!.reason).toBe("deleted");
    expect((await a.links.snapshot()).configNotices.some((n) => n.kind === "connector" && n.field === "deleted")).toBe(
      false,
    );
    await b.gateway.api.manageConfigNotice({ id: notices[0]!.id, action: "restore" });
    await wait(async () => !!(await account(a, id)) && !!(await account(b, id)));
    expect((await b.gateway.api.testConnector({ accountId: id })).tools).toHaveLength(2);
  }, 40_000);

  test("OAuth apps and headers stay secret and do not cross a link with sharing off", async () => {
    await b.sharing(a.node, false);
    await wait(() => !configAllowed(a.links, b.node));
    const app = fake.registeredApp("http://127.0.0.1:19119/api/connectors/oauth/callback");
    await a.gateway.api.saveConnectorOAuthApp({ connectorType: "custom", ...app, issuer: fake.issuer });

    const headers = (
      await a.gateway.api.saveConnectorAccount({
        connectorType: "custom",
        name: "Private apart",
        url: fake.url,
        authKind: "headers",
        token: fake.secret,
        headers: { "X-Private": "private-header-shared-fixture" },
      })
    ).account!;

    await Bun.sleep(700);
    expect(await account(b, headers.id)).toBeUndefined();
    expect((await b.gateway.api.listConnectors({})).types.find((t) => t.id === "custom")?.oauthAppSet).toBe(false);
    expect(await failure(b.links.config!.fetchBlob!(a.node, "0".repeat(64)))).toBeTruthy();
    await b.sharing(a.node, true);
    await wait(async () => !!(await account(b, headers.id)));
    await wait(
      async () => !!(await b.gateway.api.listConnectors({})).types.find((t) => t.id === "custom")?.oauthAppSet,
    );
    const there = await b.gateway.core.connectors.run((s) => s.app(b.gateway.userId, "custom"));
    expect(there?.client_id === app.clientId).toBe(true);
    expect(there?.client_secret === app.clientSecret).toBe(true);
    expect((await b.gateway.api.testConnector({ accountId: headers.id })).tools).toHaveLength(2);

    const visible = json([
      await b.gateway.api.listConnectors({}),
      await b.gateway.api.getComputers({}),
      await b.gateway.api.getOverview({}),
      await a.store.query("SELECT fields FROM config_items"),
      await b.store.query("SELECT value FROM config_history"),
      await b.store.query("SELECT * FROM connector_audit"),
      b.gateway.worker.commands,
      printed,
    ]);

    for (const secret of [...fake.tokens, fake.secret, app.clientId, app.clientSecret, "private-header-shared-fixture"])
      expect(visible.includes(secret)).toBe(false);
    expect(await failure(b.links.config!.fetchBlob!(a.node, "0".repeat(64)))).toContain("not found");
  }, 40_000);

  test("metadata merges separately connected accounts despite names; source aliases resolve on B", async () => {
    fake.accountId = "workspace-other-fixture";
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    const left = await signIn(a, fake, "Left name");
    const right = await signIn(b, fake, "Right name");
    await a.sharing(b.node, true);
    await wait(async () => (await b.store.query("SELECT 1 FROM config_aliases WHERE kind='connector'")).length > 0);
    const source = create(ui.SkillSourceSchema, { url: fake.url, credentialAccountId: left.id });
    const authorization = await new SourceDatabase(b.gateway.core.environment).authorization(source);
    expect(authorization.startsWith("Bearer ")).toBe(true);
    expect((await accounts(b)).some((a) => a.id === right.id)).toBe(true);
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));

    const saveSourceAccount = async (c: ConfigComputer) =>
      (
        await c.gateway.api.saveConnectorAccount({
          connectorType: "custom",
          name: "Source",
          url: "https://example.test/mcp",
          authKind: "headers",
          token: fake.secret,
        })
      ).account!;

    const sourceA = await saveSourceAccount(a);
    const sourceB = await saveSourceAccount(b);
    await a.sharing(b.node, true);
    await wait(
      async () =>
        (
          await b.store.query("SELECT 1 FROM config_aliases WHERE kind='connector' AND alias_id=$1", [
            sourceB.id > sourceA.id ? sourceB.id : sourceA.id,
          ])
        ).length > 0,
    );

    const preview = await a.gateway.api.previewSkillSource({
      command: "https://example.test/shared.git",
      credentialAccountId: sourceA.id,
    });

    const snapshot = await a.gateway.api.addSkillSource({
      previewId: preview.id,
      paths: preview.skills.map((s) => s.path),
      assignment: librarySkill(),
      expectedRevision: (await a.gateway.api.getAgentEnvironment({})).revision,
    });

    await wait(async () =>
      (await b.gateway.api.getAgentEnvironment({})).skills.some((s) => s.id === snapshot.skills[0]!.id),
    );
    const received = (await b.gateway.api.getAgentEnvironment({})).skills.find((s) => s.id === snapshot.skills[0]!.id)!;
    expect(received.source?.credentialAccountId).toBe(sourceB.id);
    expect(
      (await new SourceDatabase(b.gateway.core.environment).authorization(received.source!)) ===
        `Bearer ${fake.secret}`,
    ).toBe(true);
    // Client id and PKCE are secrets/session state, never account identity.
    expect(
      (await b.store.query<ConfigRow>("SELECT * FROM config_items WHERE kind='connector'")).some(
        (r) => !!r.fields["accountIdentity"]?.value,
      ),
    ).toBe(true);
  }, 60_000);

  test("same endpoint and name with different header credentials remain separate accounts", async () => {
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(b.links, a.node));
    const saved = [];

    for (const [computer, token] of [
      [a, "first-private-key"],
      [b, "second-private-key"],
    ] as const)
      saved.push(
        (
          await computer.gateway.api.saveConnectorAccount({
            connectorType: "custom",
            name: "Separate keys",
            url: "https://example.test/separate/mcp",
            authKind: "headers",
            token,
          })
        ).account!,
      );
    await a.sharing(b.node, true);
    await wait(
      async () =>
        (await accounts(a)).filter((r) => r.name === "Separate keys").length === 2 &&
        (await accounts(b)).filter((r) => r.name === "Separate keys").length === 2,
    );

    for (const computer of [a, b]) {
      const values = await Promise.all(saved.map((r) => credentials(computer, r.id)));
      expect(values[0]?.headers?.["Authorization"] !== values[1]?.headers?.["Authorization"]).toBe(true);
    }
  });

  test("foreign owner rows cannot be read, merged into, deleted or served as blobs", async () => {
    const owner = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await b.store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
      owner,
      `${owner}@example.test`,
    ]);
    await b.store.query(
      `INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status)
      VALUES($1::uuid,$2::uuid,'custom','Foreign',$1,'https://example.test/mcp','http','headers','disconnected')`,
      [foreign, owner],
    );
    expect(await failure(b.gateway.api.testConnector({ accountId: foreign }))).toContain("not found");
    expect(await failure(b.gateway.api.deleteConnectorAccount({ accountId: foreign }))).toContain("not found");

    const source = (
      await a.store.query<ConfigRow>("SELECT * FROM config_items WHERE kind='connector' AND local_id=$1", [id])
    )[0]!;

    source.global_id = foreign;
    source.fields["accountIdentity"]!.value = "foreign-probe";
    source.fields["name"]!.value = "Foreign probe";
    await b.links.config!.receive(
      a.node,
      create(computerLink.ConfigUpdateSchema, { items: [wireItem(source)] }),
      () => true,
    );
    expect(
      (await b.store.query<{ name: string }>("SELECT name FROM connector_accounts WHERE id=$1::uuid", [foreign]))[0]
        ?.name,
    ).toBe("Foreign");
    expect((await accounts(b)).some((a) => a.id === foreign)).toBe(false);
  }, 30_000);
});
