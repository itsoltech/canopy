import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink, Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { nodeRef } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { isBigInt } from "@canopy/testing";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { methodNamed } from "../../apps/gateway/src/computers/remote.ts";
import { single } from "../../apps/gateway/src/api/routed-context.ts";
import { wireItem } from "../../apps/gateway/src/config-sync/merge.ts";
import type { ConfigRow } from "../../apps/gateway/src/config-sync/persistence.ts";
import { decryptSecret } from "../../apps/gateway/src/store/secrets.ts";
import { versionKey } from "../../apps/gateway/src/config-sync/secrets.ts";
import { configComputer, createInstance, instanceOf, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually, failure } from "./support/gateway.ts";

const KEY = "sk-worker-own-key-never-leaves-b-4242";

const wait = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 20_000) =>
  expect(await eventually(async () => predicate(), Boolean, timeoutMs)).toBe(true);

const json = <T>(value: T) => JSON.stringify(value, (_name, v) => (isBigInt(v) ? v.toString() : v));

const records = async (c: ConfigComputer) => (await c.gateway.api.listWorkerRecords({})).records;

const audits = (c: ConfigComputer, action: string, worker: string) =>
  c.store.query<{ details: { method: string; node: string } }>(
    "SELECT details FROM audit_log WHERE actor_user_id=$1::uuid AND action=$2 AND target_id=$3::uuid",
    [c.gateway.userId, action, worker],
  );

const row = async (c: ConfigComputer, id: string) =>
  (
    await c.store.query<ConfigRow>(
      "SELECT * FROM config_items WHERE owner_user_id=$1::uuid AND kind='worker' AND global_id=$2",
      [c.gateway.userId, id],
    )
  )[0];

describe.skipIf(!dockerAvailable)("worker records and remote worker settings across separate databases", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;
  let worker = "";
  const q = () => `${b.gateway.workerId}~${nodeRef(b.node)}`;

  beforeAll(async () => {
    a = await configComputer("Laptop A");
    b = await configComputer("Laptop B");
    worker = b.gateway.workerId;
    await pairConfig(a, b);
    await wait(() => configAllowed(a.links, b.node) && configAllowed(b.links, a.node));
    await wait(async () => (await records(a)).some((r) => r.workerId === q()));
  }, 120_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
  }, 30_000);

  test("B's worker reaches A as a read-only copy; nobody but its home changes it", async () => {
    const copy = (await records(a)).find((r) => r.workerId === q())!;
    expect(copy).toMatchObject({ nodeId: b.node, computerName: "Laptop B", name: "laptop", readOnlyReason: "" });
    expect((await row(a, worker))?.home_node_id).toBe(b.node);
    // A's own worker is never a copy on A, and B keeps A's worker the same way.
    expect((await records(a)).some((r) => r.workerId.startsWith(a.gateway.workerId))).toBe(false);
    await wait(async () => (await records(b)).some((r) => r.workerId === `${a.gateway.workerId}~${nodeRef(a.node)}`));

    const forged = structuredClone((await row(a, worker))!);
    const name = forged.fields["name"]!;
    forged.fields["name"] = { value: "Forged", hlc: `${Date.now() + 60_000}.0.${a.node}`, prev: name.hlc };
    const update = create(computerLink.ConfigUpdateSchema, { items: [wireItem(forged)] });

    // A third computer's edit of B's worker is refused wherever it arrives; B ignores any copy of its own worker.
    expect(await failure(a.links.config!.receive(b.node, update, () => true))).toContain("Only a worker's home");
    await b.links.config!.receive(a.node, update, () => true);
    expect((await row(b, worker))!.fields["name"]!.value).toBe("laptop");

    const secret = create(computerLink.ConfigUpdateSchema, {
      items: [wireItem((await row(a, worker))!, new Map([[versionKey("worker", worker, "name", name.hlc), "plain"]]))],
    });

    expect(await failure(a.links.config!.receive(b.node, secret, () => true))).toContain("never carry secrets");
  }, 30_000);

  test("A edits B's worker at its home: only B's database changes, and both computers audit it", async () => {
    await a.gateway.api.renameWorker({ workerId: q(), name: "Studio" });
    const named = await b.store.query<{ name: string }>("SELECT name FROM workers WHERE id=$1::uuid", [worker]);
    expect(named[0]?.name).toBe("Studio");
    expect(await a.store.query("SELECT 1 FROM workers WHERE id=$1::uuid", [worker])).toHaveLength(0);

    const live = (await a.gateway.api.getOverview({})).workers.find((w) => w.id === q())!;
    await a.gateway.api.setWorkerCliUpdateSettings({
      workerId: q(),
      intervalMinutes: 60,
      expectedConfigVersion: live.configVersion,
    });
    await a.gateway.api.setEnvironmentTags({ workerId: q(), tags: ["gpu"], expectedRevision: 0n });
    await a.gateway.api.setInstanceWorker({ harness: Provider.CODEX, id: "native", workerId: q(), enabled: false });

    const config = await b.store.query<{ minutes: number }>(
      "SELECT (config->>'cliUpdateCheckMinutes')::int AS minutes FROM worker_configs WHERE worker_id=$1::uuid",
      [worker],
    );

    expect(config[0]?.minutes).toBe(60);
    expect(
      (
        await b.store.query<{ manual_tags: string[] }>(
          "SELECT manual_tags FROM worker_environments WHERE worker_id=$1::uuid",
          [worker],
        )
      )[0]?.manual_tags,
    ).toEqual(["gpu"]);
    expect(
      await b.store.query(
        "SELECT 1 FROM provider_instance_workers WHERE worker_id=$1::uuid AND harness='codex' AND NOT enabled",
        [worker],
      ),
    ).toHaveLength(1);

    await wait(async () => {
      const copy = (await records(a)).find((r) => r.workerId === q());

      return (
        copy?.name === "Studio" &&
        copy.cliUpdateCheckMinutes === 60 &&
        copy.manualTags.join() === "gpu" &&
        copy.instances.some((i) => i.harness === Provider.CODEX && i.id === "native" && i.enabled === false)
      );
    });

    const sent = await audits(a, "computer.config.worker.sent", worker);
    const received = await audits(b, "computer.config.worker.received", worker);
    const methods = ["RenameWorker", "SetWorkerCliUpdateSettings", "SetEnvironmentTags", "SetInstanceWorker"];
    expect(sent.map((r) => r.details.method).sort()).toEqual([...methods].sort());
    expect(received.map((r) => r.details.method).sort()).toEqual([...methods].sort());
    expect(sent.every((r) => r.details.node === b.node) && received.every((r) => r.details.node === a.node)).toBe(true);
  }, 45_000);

  test("a worker's own key stays at its home; A sees only that it is set", async () => {
    await createInstance(a, {
      harness: Provider.CODEX,
      id: "team",
      label: "Team endpoint",
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:8317",
    });
    await wait(async () => Boolean(await instanceOf(b, Provider.CODEX, "team")));
    await a.gateway.api.setInstanceWorker({
      harness: Provider.CODEX,
      id: "team",
      workerId: q(),
      enabled: true,
      overrides: { apiKey: KEY },
    });

    await wait(async () =>
      (await records(a))
        .find((r) => r.workerId === q())!
        .instances.some((i) => i.id === "team" && i.keySet && i.enabled === true),
    );

    const plain = async (c: ConfigComputer) =>
      (
        await c.store.query<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM secrets WHERE owner_user_id=$1::uuid", [
          c.gateway.userId,
        ])
      ).map((s) => decryptSecret(c.gateway.secretsKey, s.ciphertext));

    const shared = async (c: ConfigComputer) =>
      (await c.store.query<{ ciphertext: Uint8Array }>("SELECT ciphertext FROM config_secrets")).map((s) =>
        decryptSecret(c.gateway.secretsKey, s.ciphertext),
      );

    expect(await plain(b)).toContain(KEY);
    expect(await plain(a)).not.toContain(KEY);
    // B saves the key as a proxy of that worker only; it is no shared record on either computer.
    expect([...(await shared(a)), ...(await shared(b))]).not.toContain(KEY);

    const everywhere = json([
      await a.store.query("SELECT * FROM config_items"),
      await a.store.query("SELECT * FROM config_history"),
      await a.store.query("SELECT details FROM audit_log"),
      await records(a),
    ]);

    expect(everywhere).not.toContain(KEY);
    expect(json(await b.store.query("SELECT * FROM config_items"))).not.toContain(KEY);
  }, 45_000);

  test("access lists naming workers of both computers are split: each home writes its own workers", async () => {
    const saved = (
      await a.gateway.api.saveConnectorAccount({
        connectorType: "custom",
        name: "Split",
        url: "https://mcp.example.test/mcp",
        authKind: "headers",
        token: "header-secret",
      })
    ).account!;

    await wait(async () => (await b.gateway.api.listConnectors({})).accounts.some((x) => x.id === saved.id));

    const grants = (c: ConfigComputer) =>
      c.store.query<{ worker_id: string }>(
        "SELECT worker_id::text FROM connector_worker_grants WHERE account_id=$1::uuid",
        [saved.id],
      );

    await a.gateway.api.setConnectorAccess({
      accountId: saved.id,
      workerIds: [a.gateway.workerId, q()],
      expectedRevision: saved.revision,
    });
    expect((await grants(a)).map((g) => g.worker_id)).toEqual([a.gateway.workerId]);
    expect((await grants(b)).map((g) => g.worker_id)).toEqual([worker]);
    await wait(async () =>
      ((await a.gateway.api.listConnectors({})).accounts.find((x) => x.id === saved.id)?.workerIds ?? []).includes(q()),
    );

    await a.gateway.api.setInstanceWorkers({
      harness: Provider.CODEX,
      id: "team",
      allWorkers: false,
      workerIds: [a.gateway.workerId],
    });

    const team = await b.store.query<{ enabled: boolean }>(
      "SELECT enabled FROM provider_instance_workers WHERE worker_id=$1::uuid AND harness='codex' AND instance_id='team'",
      [worker],
    );

    expect(team[0]?.enabled).toBe(false);
    // The shared parts (all workers, bots) are A's write; B changed only its worker.
    expect(
      (
        await b.store.query<{ all_workers: boolean }>("SELECT all_workers FROM connector_accounts WHERE id=$1::uuid", [
          saved.id,
        ])
      )[0]?.all_workers,
    ).toBe(false);
  }, 45_000);

  test("ids of another computer, or of nobody's worker, are refused", async () => {
    // A's own worker under B's suffix: B has no such worker.
    expect(
      await failure(a.gateway.api.renameWorker({ workerId: `${a.gateway.workerId}~${nodeRef(b.node)}`, name: "X" })),
    ).toContain("isn't on this computer");
    expect(
      await failure(
        a.gateway.api.updateWorktreeSettings({ workerId: q(), projectId: crypto.randomUUID(), settings: {} }),
      ),
    ).toContain("same computer");

    // Directly over the link, as a computer that skips its own checks would send it.
    const call = (workerId: string) =>
      single(
        a.links.remote(
          b.node,
          methodNamed("RenameWorker")!,
          create(ui.RenameWorkerRequestSchema, { workerId, name: "X" }),
          AbortSignal.timeout(5000),
        ),
      );

    expect(await failure(call(crypto.randomUUID()))).toContain("isn't on this computer");
    expect(await failure(call(""))).toContain("Choose a worker");
    expect(
      (await b.store.query<{ name: string }>("SELECT name FROM workers WHERE id=$1::uuid", [worker]))[0]?.name,
    ).toBe("Studio");
  }, 30_000);

  test("a linked computer cannot start a sign-in that replaces another computer's CLI login", async () => {
    const request = { workerId: q(), harness: Provider.CODEX, id: "native" };
    // Through A's own API, the call never leaves A …
    expect(await failure(a.gateway.api.startProviderLogin(request))).not.toBe("");

    // … and B refuses it over the link too, also when the caller skips its own checks.
    const direct = await failure(
      single(
        a.links.remote(
          b.node,
          methodNamed("StartProviderLogin")!,
          create(ui.StartProviderLoginRequestSchema, { ...request, workerId: worker }),
          AbortSignal.timeout(5000),
        ),
      ),
    );

    expect(direct).toContain("does not share that action");
    expect(await failure(a.gateway.api.logoutProvider(request))).not.toBe("");
    expect(
      await failure(
        single(
          a.links.remote(
            b.node,
            methodNamed("LogoutProvider")!,
            create(ui.LogoutProviderRequestSchema, { ...request, workerId: worker }),
            AbortSignal.timeout(5000),
          ),
        ),
      ),
    ).toContain("does not share that action");
    expect(
      await failure(
        single(
          a.links.remote(
            b.node,
            methodNamed("CompleteProviderLogin")!,
            create(ui.CompleteProviderLoginRequestSchema, {
              ...request,
              workerId: worker,
              loginId: "fixture",
              code: "fixture-code",
            }),
            AbortSignal.timeout(5000),
          ),
        ),
      ),
    ).toContain("does not share that action");
  }, 30_000);

  test("records and edits are this owner's only", async () => {
    const other = crypto.randomUUID();
    const foreign = crypto.randomUUID();

    for (const c of [a, b])
      await c.store.query(
        "INSERT INTO users(id,email,display_name,role) VALUES ($1::uuid,'other-owner@localhost','Other owner','user')",
        [other],
      );

    await b.store.query(
      "INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES ($1::uuid,$2::uuid,'Theirs','x')",
      [foreign, other],
    );
    await a.store.query(
      "INSERT INTO config_items(owner_user_id,kind,global_id,home_node_id,fields,revision) VALUES ($1::uuid,'worker',$2,$3,$4::jsonb,1)",
      [
        other,
        crypto.randomUUID(),
        b.node,
        JSON.stringify({ name: { value: "Not yours", hlc: `1.0.${b.node}`, prev: "" } }),
      ],
    );
    await b.links.config!.publishWorkers();

    expect(await b.store.query("SELECT 1 FROM config_items WHERE global_id=$1", [foreign])).toHaveLength(0);
    expect((await records(a)).map((r) => r.name)).toEqual(["Studio"]);
    expect(
      await failure(a.gateway.api.renameWorker({ workerId: `${foreign}~${nodeRef(b.node)}`, name: "X" })),
    ).toContain("isn't on this computer");
  }, 30_000);

  test("an unreachable home fails at once; nothing is applied when it returns", async () => {
    await b.links.close();
    await wait(() => !a.links.reachable().includes(b.node));
    const started = Date.now();
    const error = await failure(a.gateway.api.renameWorker({ workerId: q(), name: "Queued" }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(error).toMatch(/Laptop B/);

    // The last known values stay readable, with the same reason as the API.
    const copy = (await records(a)).find((r) => r.workerId === q())!;
    expect(copy.name).toBe("Studio");
    expect(copy.readOnlyReason).toMatch(/Laptop B/);
    expect(await audits(a, "computer.config.worker.sent", worker)).toHaveLength(7);

    await b.restart();
    await wait(() => configAllowed(a.links, b.node) && configAllowed(b.links, a.node));
    await wait(async () => (await records(a)).find((r) => r.workerId === q())?.readOnlyReason === "");
    await Bun.sleep(500);
    expect(
      (await b.store.query<{ name: string }>("SELECT name FROM workers WHERE id=$1::uuid", [worker]))[0]?.name,
    ).toBe("Studio");
  }, 60_000);

  test("without Share configuration there are no worker records and no remote edits", async () => {
    await a.sharing(b.node, false);
    await wait(() => !configAllowed(a.links, b.node) && !configAllowed(b.links, a.node));
    await wait(async () => (await records(a)).length === 0);
    expect(await row(a, worker)).toBeUndefined();
    expect(await failure(a.gateway.api.renameWorker({ workerId: q(), name: "Off" }))).toContain(
      "Turn on Share configuration",
    );

    // B refuses the edit itself, also when the caller skips its own check.
    const direct = await failure(
      single(
        a.links.remote(
          b.node,
          methodNamed("RenameWorker")!,
          create(ui.RenameWorkerRequestSchema, { workerId: worker, name: "Off" }),
          AbortSignal.timeout(5000),
        ),
      ),
    );

    expect(direct).toContain("Configuration sharing is off");
    expect(
      (await b.store.query<{ name: string }>("SELECT name FROM workers WHERE id=$1::uuid", [worker]))[0]?.name,
    ).toBe("Studio");
  }, 45_000);
});
