import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { PersistentThreadCache, clearPairingCache } from "../../apps/mobile/src/storage/thread-cache.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { encryptSecret, SECRETS_KEY_ID } from "../../apps/gateway/src/store/secrets.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { DiskThreadStorage } from "./support/thread-cache.ts";
import { SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

const directory = tempDirs();

describe("durable bounded thread snapshots", () => {
  const snapshot = (id: string, title = id) =>
    create(ui.ThreadSnapshotSchema, {
      thread: { id, title },
      cursor: `${crypto.randomUUID()}:1`,
    });

  test("disk restart retains the checkpoint, durable LRU evicts, and corrupt entries fall back", async () => {
    const storage = new DiskThreadStorage(directory("canopy-cache-lru-"));
    const limits = { count: 2, bytes: 4096, entry: 2048 };
    let cache = new PersistentThreadCache(storage, limits);
    const first = snapshot("first");
    await cache.save(first);
    await cache.save(snapshot("second"));
    cache = new PersistentThreadCache(storage, limits);
    expect(await cache.load("first")).toEqual(first);
    await cache.save(snapshot("third"));
    cache = new PersistentThreadCache(storage, limits);
    expect(await cache.load("second")).toBeUndefined();
    expect(await cache.load("first")).toEqual(first);
    const entry = (await storage.list()).find((file) => file.id === "third")!;
    await storage.remove(entry.name);
    await storage.write("third", new Uint8Array([255, 255]));
    expect(await cache.load("third")).toBeUndefined();
    await cache.save(snapshot("oversized", "x".repeat(5000)));
    expect((await storage.list()).some((file) => file.id === "oversized")).toBe(false);
    const byteCache = new PersistentThreadCache(storage, { ...limits, bytes: 1800 });
    await byteCache.save(snapshot("large-a", "a".repeat(1000)));
    await byteCache.save(snapshot("large-b", "b".repeat(1000)));
    expect((await storage.list()).reduce((sum, file) => sum + file.bytes, 0)).toBeLessThanOrEqual(1800);
    expect(await new PersistentThreadCache(storage).load("large-a")).toBeUndefined();
  });

  test("unpair fences in-flight and late writes before clearing disk and memory", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    class SlowStorage extends DiskThreadStorage {
      override async write(id: string, bytes: Uint8Array) {
        entered.resolve();
        await release.promise;
        await super.write(id, bytes);
      }
    }

    const storage = new SlowStorage(directory("canopy-cache-unpair-"));
    const cache = new PersistentThreadCache(storage);
    const state = snapshot("thread");
    const saving = cache.save(state);
    await entered.promise;
    const clearing = clearPairingCache(cache, () => Promise.resolve());
    expect(cache.peek("thread")).toBeUndefined();
    release.resolve();
    await saving;
    expect(await clearing).toBe(true);
    await cache.save(state);
    expect(await cache.load("thread")).toBeUndefined();
    expect(await storage.list()).toHaveLength(0);
  });
});

describe.skipIf(!dockerAvailable)("paired device cache and real gateway", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  let store: ComputerStore;
  let id: string;

  beforeAll(async () => {
    gw = await startTestGateway();
    store = new ComputerStore(gw.runtime, gw.userId, gw.secretsKey);
    network = new NetworkAccess({ store, host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
    const project = (await gw.api.createProject({ name: "Cached mobile" })).project!.id;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project, workerId: gw.workerId, rootPath: "/repo/cache" })
    ).workspace!.id;

    id = (
      await gw.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
  }, 60_000);

  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  test("persisted full and delta payloads exclude secrets, then revocation clears the cache", async () => {
    const routes = gw.core.mobile.networkRoutes();
    const transport = nodePinnedTransport();
    const invitation = await gw.api.createMobilePairing({});
    const pairing = routedMobileClient({ connection: routes, transport });

    const paired = await pairing.pairing.exchangeMobilePairing({
      code: invitation.code,
      name: "Cache test",
      platform: "android",
    });

    const client = routedMobileClient({ connection: routes, token: paired.deviceToken, transport });
    const storage = new DiskThreadStorage(directory("canopy-cache-device-"));
    let cache = new PersistentThreadCache(storage);

    async function open(cursor = "") {
      const abort = new AbortController();

      try {
        for await (const update of client.api.watchThread(
          { threadId: id, incremental: true, cursor },
          { signal: abort.signal, timeoutMs: 5000 },
        ))
          return update;
        throw new Error("No initial state");
      } finally {
        abort.abort();
      }
    }

    let state = applyThreadUpdate(undefined, await open());
    await cache.save(state);
    cache = new PersistentThreadCache(storage);
    state = (await cache.load(id))!;
    const secret = `synthetic-${crypto.randomUUID()}`;
    const request = crypto.randomUUID();
    const turn = crypto.randomUUID();
    await store.query(
      `INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq,completed_at)
      VALUES($1::uuid,$2::uuid,1,'completed','user',$3::uuid,'{}'::jsonb,1,1,now())`,
      [turn, id, gw.userId],
    );
    await store.query(
      `INSERT INTO thread_secrets(id,thread_id,turn_id,call_id,label,description,placeholder,name,status,ciphertext,key_id,expires_at,revision)
      VALUES($1::uuid,$2::uuid,$5::uuid,$1::uuid,'Private token','Test','','TOKEN','saved',$3,$4,now()+interval '1 hour',1)`,
      [request, id, encryptSecret(gw.secretsKey, secret), SECRETS_KEY_ID, turn],
    );
    const delta = await open(state.cursor);
    expect(delta.change.case).toBe("delta");
    const identity = await store.identity();

    const http2 = createClient(
      ui.GatewayService,
      createConnectTransport({
        baseUrl: network.origins()[0]!,
        httpVersion: "2",
        nodeOptions: { ca: identity.certificate, checkServerIdentity: () => undefined },
        interceptors: [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${paired.deviceToken}`);

            return next(request);
          },
        ],
      }),
    );

    const abort = new AbortController();

    try {
      for await (const update of http2.watchThread(
        { threadId: id, incremental: true, cursor: state.cursor },
        { signal: abort.signal, timeoutMs: 3000 },
      )) {
        expect(update.change.case).toBe("delta");
        break;
      }
    } finally {
      abort.abort();
    }

    state = applyThreadUpdate(state, delta);
    expect(state.secrets.some((entry) => entry.requestId === request)).toBe(true);
    expect(Buffer.from(toBinary(ui.ThreadUpdateSchema, delta)).includes(Buffer.from(secret))).toBe(false);
    const full = await open();
    expect(Buffer.from(toBinary(ui.ThreadUpdateSchema, full)).includes(Buffer.from(secret))).toBe(false);
    await cache.save(state);

    for (const file of await storage.list()) {
      const bytes = Buffer.from(await storage.read(file.name));
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(bytes.includes(Buffer.from(paired.deviceToken))).toBe(false);
    }

    await gw.api.revokeMobileDevice({ id: paired.device!.id });
    let revoked = false;

    try {
      await open(state.cursor);
    } catch (error) {
      revoked = ConnectError.from(error).code === Code.Unauthenticated;
    }

    expect(revoked).toBe(true);
    expect(await clearPairingCache(cache, () => Promise.resolve())).toBe(true);
    await cache.save(state);
    expect(cache.peek(id)).toBeUndefined();
    expect(await new PersistentThreadCache(storage).load(id)).toBeUndefined();
    expect(await storage.list()).toHaveLength(0);
  });
});
