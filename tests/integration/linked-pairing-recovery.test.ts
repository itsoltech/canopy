import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { LAN_ROUTES, REMOTE_APP_UPDATE } from "@canopy/domain/computers";
import { AsyncChannel } from "@canopy/transport";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { computersDial, computersTick } from "../../apps/gateway/src/computers/runtime-connection.ts";
import { computersState } from "../../apps/gateway/src/computers/runtime-context.ts";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { linkClient } from "../../apps/gateway/src/computers/transport.ts";
import { Routes } from "../../apps/gateway/src/computers/routes.ts";
import { linkedUpdates } from "../../apps/gateway/src/updates/linked.ts";
import { linkedComputers, listenLink } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("pairing recovery over gateway TLS links", () => {
  let a: TestGateway;
  let b: TestGateway;
  let sa: ComputerStore;
  let sb: ComputerStore;
  let la: ReturnType<typeof linkedComputers>;
  let lb: ReturnType<typeof linkedComputers>;
  let replacement: Awaited<ReturnType<typeof listenLink>> | undefined;
  let address = "";
  let port = 0;

  function computer(gateway: TestGateway, store: ComputerStore, fixedPort?: number) {
    const computers = linkedComputers({
      store,
      host: "127.0.0.1",
      ...(fixedPort && { port: fixedPort }),
      // Only explicit ticks dial in this suite; live links stay valid while assertions run.
      heartbeatMs: 60_000,
      updates: async () => create(ui.UpdatesSnapshotSchema),
    });

    const start = computers.start.bind(computers);

    computers.start = async () => {
      // The shared fixture starts the runtime before its listener. Its first address
      // announcement would abort startup dials; this suite has no heartbeat retry for 60s.
      // Keep startup quiescent so each explicit tick runs after the listener is ready.
      computers[computersState].paused = true;

      try {
        await start();
      } finally {
        computers[computersState].paused = false;
      }
    };

    gateway.core.computers = computers;
    gateway.core.network = computers.options.network;

    return computers;
  }

  const peer = async () => (await sa.peers())[0]!;

  async function online(store = sa, nodeId = lb.hello().nodeId) {
    expect(
      await eventually(
        async () => (await store.peer(nodeId))?.status,
        (value) => value === "connected",
      ),
    ).toBe("connected");
  }

  async function reconnect() {
    la.reads.connected(lb.hello().nodeId);
    la[computersState].retry.clear();
    await computersTick(la);
    await online();
    await online(sb, la.hello().nodeId);
  }

  async function stopB() {
    await lb.close();
    expect(
      await eventually(
        async () => la[computersState].active.size,
        (size) => size === 0,
      ),
    ).toBe(0);
    await Promise.allSettled(la[computersState].tasks);
    await sa.status(lb.hello().nodeId, "unreachable");
  }

  async function failedDial() {
    await computersDial(la, await peer(), new AbortController());
  }

  async function rejectConnect(identity = lb.identity, message = "Peer is starting") {
    let calls = 0;
    replacement = await listenLink({
      host: "127.0.0.1",
      port,
      identity,
      routes: (router) =>
        router.service(link.ComputerLinkService, {
          connect: () => {
            calls++;
            throw new ConnectError(message, Code.Unauthenticated);
          },
        }),
    });

    return () => calls;
  }

  async function restoreB() {
    await lb.close();
    await replacement?.close();
    replacement = undefined;
    sb = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    lb = computer(b, sb, port);
    await lb.start();
    await reconnect();
  }

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
  }, 60_000);

  beforeEach(async () => {
    sa = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    sb = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    await sa.query("DELETE FROM computer_peers WHERE owner_user_id=$1::uuid", [sa.owner]);
    await sb.query("DELETE FROM computer_peers WHERE owner_user_id=$1::uuid", [sb.owner]);
    la = computer(a, sa);
    lb = computer(b, sb);
    await la.start();
    await lb.start();
    address = lb.addresses[0]!;
    port = lb.options.network.port!;
    const invitation = await lb.createPairing();
    await la.pair(address, invitation.code);
    await online();
    await online(sb, la.hello().nodeId);
  }, 30_000);

  afterEach(async () => {
    await replacement?.close();
    replacement = undefined;
    await Promise.allSettled([la?.close(), lb?.close()]);
  }, 15_000);

  afterAll(async () => {
    await a?.close();
    await b?.close();
  }, 15_000);

  test("startup Unauthenticated on a manual route stays retryable and retains the pin", async () => {
    const pinned = await peer();
    await stopB();
    const calls = await rejectConnect();
    await failedDial();
    await failedDial();
    expect(calls()).toBe(2);
    expect(await peer()).toMatchObject({ status: "unreachable", fingerprint: pinned.fingerprint });
    expect((await new Routes(sa).list(pinned.node_id))[0]).toMatchObject({ source: "manual", address });
    await restoreB();
    expect(await peer()).toMatchObject({ status: "connected", fingerprint: pinned.fingerprint });
  }, 25_000);

  test("an RPC cannot impersonate the local certificate mismatch signal", async () => {
    await stopB();

    const calls = await rejectConnect(
      lb.identity,
      "Computer certificate changed. Unlink and create a new pairing code on the other computer.",
    );

    await failedDial();
    await failedDial();
    expect(calls()).toBe(2);
    expect((await peer()).status).toBe("unreachable");
  }, 20_000);

  test("startup authentication failures keep a discovered LAN route for retry", async () => {
    const pinned = await peer();
    await stopB();
    await sa.query("UPDATE computer_routes SET source='lan' WHERE owner_user_id=$1::uuid AND node_id=$2", [
      sa.owner,
      pinned.node_id,
    ]);
    const calls = await rejectConnect();
    await failedDial();
    expect(calls()).toBe(1);
    expect((await new Routes(sa).list(pinned.node_id))[0]).toMatchObject({ source: "lan", address });
    await failedDial();
    expect(calls()).toBe(2);
    expect((await new Routes(sa).list(pinned.node_id))[0]).toMatchObject({ source: "lan", address });
    expect((await peer()).status).toBe("unreachable");
    await restoreB();
  }, 25_000);

  test("failed TLS connections cannot confirm an identity change on a manual route", async () => {
    const pinned = await peer();
    await stopB();
    await failedDial();
    await failedDial();
    expect(await peer()).toMatchObject({ status: "unreachable", fingerprint: pinned.fingerprint });
    expect((await new Routes(sa).list(pinned.node_id))[0]).toMatchObject({ source: "manual", address });
    await restoreB();
  }, 25_000);

  test("an early listener answers Unavailable until the computer runtime is ready", async () => {
    await stopB();
    lb = computer(b, sb, port);
    await lb.options.network.start();
    const client = linkClient(address, (await sb.identity()).certificate, la.identity);
    const output = new AsyncChannel<link.LinkFrame>();
    output.push(create(link.LinkFrameSchema, { body: { case: "hello", value: la.hello() } }));

    try {
      const stream = client.connect(output, { timeoutMs: 3000 });
      await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: Code.Unavailable });
      await expect(client.pair({ secret: "unused", hello: la.hello() })).rejects.toMatchObject({
        code: Code.Unavailable,
      });
      expect((await sb.peers())[0]!.fingerprint).toBe((await sa.identity()).fingerprint);
    } finally {
      output.close();
      client.close();
    }

    await lb.options.network.close();
    await lb.start();
    await reconnect();
  }, 20_000);

  test("both gateway restarts reuse the encrypted identity, certificate, routes and trust", async () => {
    const identityA = await sa.identity();
    const identityB = await sb.identity();
    const portA = la.options.network.port;
    await Promise.all([la.close(), lb.close()]);
    await a.close(true);
    await b.close(true);
    a = await startTestGateway({ role: "desktop", storage: a });
    b = await startTestGateway({ role: "desktop", storage: b });
    sa = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    sb = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    la = computer(a, sa, portA);
    lb = computer(b, sb, port);
    const restoredA = await sa.identity();
    const restoredB = await sb.identity();
    expect(restoredA.node_id).toBe(identityA.node_id);
    expect(restoredA.certificate).toBe(identityA.certificate);
    expect(restoredB.node_id).toBe(identityB.node_id);
    expect(restoredB.certificate).toBe(identityB.certificate);
    await la.start();
    await lb.start();
    await reconnect();
    expect(await peer()).toMatchObject({ status: "connected", fingerprint: identityB.fingerprint });
    expect((await sb.peers())[0]!.fingerprint).toBe(identityA.fingerprint);
  }, 60_000);

  test("an older hello without new capabilities remains linked to a newer peer", async () => {
    const pinned = await peer();
    await stopB();
    const newerHello = la.hello.bind(la);
    la.hello = () => create(link.NodeHelloSchema, { ...newerHello(), appVersion: "0.2.0-nightly.137" });
    lb = computer(b, sb, port);
    const hello = lb.hello.bind(lb);
    lb.hello = () =>
      create(link.NodeHelloSchema, {
        ...hello(),
        appVersion: "0.2.0-nightly.133",
        capabilities: ["presence", "unlink", LAN_ROUTES],
      });

    const previousVersion = (await sb.peers())[0]!.app_version;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const query = sb.query.bind(sb);
    // Force the CI ordering: B has received A's hello, but has not committed its metadata yet.
    sb.query = async <A extends object>(...args: Parameters<ComputerStore["query"]>) => {
      if (args[0].includes("app_version=$4") && args[1]?.[3] === "0.2.0-nightly.137") {
        entered.resolve();
        await resume.promise;
      }

      return query<A>(...args);
    };

    try {
      // Force B -> A, so A can commit connected while B is held processing A's welcome.
      await lb.start();
      lb.reads.connected(la.hello().nodeId);
      lb[computersState].retry.clear();
      await computersTick(lb);
      await entered.promise;
      expect(
        await eventually(
          async () => (await peer()).status,
          (value) => value === "connected",
        ),
      ).toBe("connected");
      // A's connected status is not a barrier for B: its pairing-time version is still legitimate here.
      expect((await sb.peers())[0]).toMatchObject({ status: "unreachable", app_version: previousVersion });
    } finally {
      resume.resolve();
      sb.query = query;
    }

    await online();
    // A's connected status does not imply B processed its welcome. B commits metadata before its own status.
    await online(sb, la.hello().nodeId);
    expect(await peer()).toMatchObject({
      status: "connected",
      app_version: "0.2.0-nightly.133",
      fingerprint: pinned.fingerprint,
      min_protocol: 1,
      max_protocol: 1,
    });
    expect((await sb.peers())[0]!.app_version).toBe("0.2.0-nightly.137");
    await restoreB();
    expect((await peer()).capabilities).toContain(REMOTE_APP_UPDATE);
  }, 25_000);

  test("a real key change requires confirmed pairing and never receives an RPC or changes trust", async () => {
    const pinned = await peer();
    await stopB();
    const calls = await rejectConnect(await generateIdentity());
    await failedDial();
    expect((await peer()).status).toBe("unreachable");
    await failedDial();
    expect(await peer()).toMatchObject({ status: "pairing_required", fingerprint: pinned.fingerprint });
    expect(calls()).toBe(0);
    const computer = (await a.api.getComputers({})).peers[0]!;
    const reason = `${computer.name}'s identity changed. Pair again to trust it.`;
    expect(computer.unavailableReason).toBe(reason);
    expect((await la.unavailable(pinned.node_id)).rawMessage).toBe(reason);
    expect((await linkedUpdates(a.core))[0]!.reason).toBe(reason);
    await restoreB();
    expect(await peer()).toMatchObject({ status: "connected", fingerprint: pinned.fingerprint });
  }, 25_000);

  test("a successful pinned handshake clears a persisted pairing_required after restart", async () => {
    const pinned = await peer();
    await stopB();
    await sa.status(pinned.node_id, "pairing_required");
    await la.close();
    la = computer(a, new ComputerStore(a.runtime, a.userId, a.secretsKey));
    await la.start();
    lb = computer(b, sb, port);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const startNetwork = lb.options.network.start.bind(lb.options.network);

    lb.options.network.start = async () => {
      // Hold the exact window that used to launch and then abort a startup dial.
      entered.resolve();
      await resume.promise;
      await startNetwork();
    };

    const starting = lb.start();

    try {
      await entered.promise;
      expect(lb[computersState].dialing.size).toBe(0);
      expect(lb[computersState].active.size).toBe(0);
      expect((await peer()).status).toBe("pairing_required");
    } finally {
      resume.resolve();
      await starting;
      lb.options.network.start = startNetwork;
    }

    await reconnect();
    expect(await peer()).toMatchObject({ status: "connected", fingerprint: pinned.fingerprint });
  }, 25_000);

  test("a verified alternate route outweighs a stale manual route with a different key", async () => {
    const pinned = await peer();
    await stopB();
    const calls = await rejectConnect(await generateIdentity());
    await failedDial();
    await sb.query("UPDATE network_access SET port=NULL WHERE owner_user_id=$1::uuid", [sb.owner]);
    await sb.query("DELETE FROM computer_routes WHERE owner_user_id=$1::uuid", [sb.owner]);
    lb = computer(b, sb);
    await lb.start();
    const current = lb.addresses[0]!;
    await new Routes(sa).add(pinned.node_id, [current], "announced");
    // Try the stale manual path first even though a new path is available.
    await sa.query(
      "UPDATE computer_routes SET last_failure=NULL,last_success=now() WHERE owner_user_id=$1::uuid AND address=$2",
      [sa.owner, address],
    );
    await reconnect();
    expect((await peer()).status).toBe("connected");
    expect(calls()).toBe(0);
    expect((await peer()).fingerprint).toBe(pinned.fingerprint);
  }, 25_000);
});
