import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { computerLink as link } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AsyncChannel } from "@canopy/transport";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { generateIdentity, hash } from "../../apps/gateway/src/computers/identity.ts";
import { linkClient, listenLink } from "../../apps/gateway/src/computers/transport.ts";
import { eventually as poll, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

async function eventually(predicate: () => Promise<boolean>, timeoutMs = 5000) {
  expect(await poll(predicate, Boolean, timeoutMs)).toBe(true);
}

describe.skipIf(!dockerAvailable)("two independent gateways with pinned computer links", () => {
  let a: TestGateway; let b: TestGateway;
  let sa: ComputerStore; let sb: ComputerStore;
  let la: LinkedComputers; let lb: LinkedComputers;
  const status = async (gw: TestGateway) => (await gw.api.getComputers({})).peers[0]?.status;
  const online = () => eventually(async () => await status(a) === "connected" && await status(b) === "connected", 15_000);
  async function pair() {
    const invitation = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });
    await online();
    return invitation;
  }
  async function restartB(extra: { minProtocol?: number; maxProtocol?: number } = {}) {
    const address = lb.addresses[0]!;
    await lb.close();
    lb = new LinkedComputers({ store: sb, host: "127.0.0.1", port: Number(new URL(address).port), heartbeatMs: 100, ...extra });
    b.core.computers = lb; await lb.start();
  }
  beforeAll(async () => {
    a = await startTestGateway(); b = await startTestGateway();
    sa = new ComputerStore(a.runtime, a.userId, randomBytes(32)); sb = new ComputerStore(b.runtime, b.userId, randomBytes(32));
    la = new LinkedComputers({ store: sa, host: "127.0.0.1", heartbeatMs: 100 });
    lb = new LinkedComputers({ store: sb, host: "127.0.0.1", heartbeatMs: 100 });
    a.core.computers = la; b.core.computers = lb;
    await la.start(); await lb.start();
  }, 60_000);
  afterAll(async () => { await Promise.allSettled([la?.close(), lb?.close()]); await a?.close(); await b?.close(); }, 15_000);

  test("pairing pins both TLS certificates; stores only a hash and encrypted identity; replay fails", async () => {
    const invitation = await pair();
    const pa = (await a.api.getComputers({})).peers[0]!; const pb = (await b.api.getComputers({})).peers[0]!;
    expect(pa.fingerprint).toBe((await b.api.getComputers({})).self!.fingerprint);
    expect(pb.fingerprint).toBe((await a.api.getComputers({})).self!.fingerprint);
    expect(pa.nodeId).toBe(lb.hello().nodeId);
    const raw = invitation.code.replaceAll("-", "");
    const stored = (await sa.query<{ secret_hash: string; used_at: Date }>("SELECT secret_hash,used_at FROM computer_pairings WHERE owner_user_id=$1::uuid", [a.userId]))[0]!;
    expect(stored.secret_hash).toBe(hash(raw.slice(64))); expect(stored.used_at).toBeTruthy();
    const identity = (await sa.query<{ private_key: Uint8Array }>("SELECT private_key FROM computer_identity"))[0]!;
    expect(Buffer.from(identity.private_key).toString()).not.toContain("PRIVATE KEY");
    expect(await failure(b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code }))).toContain("already used");
  }, 25_000);

  test("wrong, expired and revoked codes fail without changing pins", async () => {
    let invite = await a.api.createComputerPairing({});
    const wrong = invite.code.slice(0, -1) + (invite.code.endsWith("0") ? "1" : "0");
    expect(await failure(b.api.linkComputer({ address: la.addresses[0]!, code: wrong }))).toContain("invalid");
    await sa.query("UPDATE computer_pairings SET expires_at=now()-interval '1 second'");
    expect(await failure(b.api.linkComputer({ address: la.addresses[0]!, code: invite.code }))).toContain("expired");
    invite = await a.api.createComputerPairing({});
    await a.api.manageComputer({ action: "revoke_pairing" });
    expect(await failure(b.api.linkComputer({ address: la.addresses[0]!, code: invite.code }))).toContain("revoked");
    expect((await sa.peers())[0]!.fingerprint).toBe((await sb.identity()).fingerprint);
  }, 25_000);

  test("simultaneous exchanges consume the same invitation exactly once", async () => {
    const invitation = await a.api.createComputerPairing({});
    const results = await Promise.allSettled([b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code }), b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await online();
  }, 25_000);

  test("a third computer with a valid self-signed client certificate cannot use Connect", async () => {
    const intruder = await generateIdentity();
    const frames = new AsyncChannel<link.LinkFrame>();
    frames.push(create(link.LinkFrameSchema, { body: { case: "hello", value: { ...lb.hello(), nodeId: intruder.nodeId } } }));
    try {
      const stream = linkClient(la.addresses[0]!, la.identity.certificate, intruder).connect(frames, { timeoutMs: 3000 });
      const error = await stream[Symbol.asyncIterator]().next().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectError); expect((error as ConnectError).code).toBe(Code.Unauthenticated);
    } finally { frames.close(); }
  });

  test("a different server key on the same address is rejected before the pairing secret is sent", async () => {
    const invitation = await a.api.createComputerPairing({});
    const port = Number(new URL(la.addresses[0]!).port);
    const address = la.addresses[0]!;
    await la.close();
    let calls = 0;
    const mitm = await listenLink({ host: "127.0.0.1", port, identity: await generateIdentity(), routes: (router) => {
      router.service(link.ComputerLinkService, { pair: async () => { calls++; return create(link.PairResponseSchema); }, connect: async function* () { calls++; } });
    } });
    try {
      expect(await failure(b.api.linkComputer({ address, code: invitation.code }))).toContain("certificate changed");
      const stream = linkClient(address, la.identity.certificate, lb.identity).connect(new AsyncChannel(), { timeoutMs: 2000 });
      expect(await failure(stream[Symbol.asyncIterator]().next())).toBeTruthy();
      expect(calls).toBe(0);
    } finally { await mitm.close(); }
    la = new LinkedComputers({ store: sa, host: "127.0.0.1", port, heartbeatMs: 100 }); a.core.computers = la; await la.start();
    await online();
  }, 25_000);

  test("incompatible ranges identify the computer needing an update on both sides; restart recovers", async () => {
    await restartB({ minProtocol: 2, maxProtocol: 2 });
    await eventually(async () => await status(a) === "needs_update" && await status(b) === "needs_update", 15_000);
    expect((await a.api.getComputers({})).peers[0]!.updateNodeId).toBe(la.hello().nodeId);
    expect((await b.api.getComputers({})).peers[0]!.updateNodeId).toBe(la.hello().nodeId);
    await restartB(); await online();
  }, 35_000);

  test("announced states are preserved on disconnect; unannounced loss becomes unreachable; reconnect is durable", async () => {
    await lb.announce("updating"); await eventually(async () => await status(a) === "updating");
    await lb.announce("sleeping"); await eventually(async () => await status(a) === "sleeping");
    await lb.announce("connected"); await online();
    const nodeId = lb.hello().nodeId;
    await lb.close(); await eventually(async () => await status(a) === "shutting_down");
    await restartB(); await online(); expect(lb.hello().nodeId).toBe(nodeId);
    // Loss of the listening socket has no announcement and ends the bidi stream.
    await b.api.manageComputer({ action: "listener", enabled: false });
    // The other side may have dialled too; shut its listener to drop both directions.
    await a.api.manageComputer({ action: "listener", enabled: false });
    await eventually(async () => await status(a) === "unreachable" && await status(b) === "unreachable", 10_000);
    await a.api.manageComputer({ action: "listener", enabled: true });
    await b.api.manageComputer({ action: "listener", enabled: true });
    await online();
  }, 35_000);

  test("rename propagates self name; peer aliases stay local; unlink removes both records", async () => {
    await b.api.manageComputer({ action: "rename", name: "Travel laptop" });
    await eventually(async () => (await a.api.getComputers({})).peers[0]?.name === "Travel laptop");
    await a.api.manageComputer({ action: "rename", nodeId: lb.hello().nodeId, name: "My laptop" });
    expect((await a.api.getComputers({})).peers[0]!.displayName).toBe("My laptop");
    expect((await b.api.getComputers({})).self!.name).toBe("Travel laptop");
    await a.api.manageComputer({ action: "unlink", nodeId: lb.hello().nodeId });
    await eventually(async () => !(await a.api.getComputers({})).peers.length && !(await b.api.getComputers({})).peers.length);
    await pair();
  }, 25_000);

  test("offline unlink revokes trust immediately and removes the other record after reconnect", async () => {
    await lb.close();
    await a.api.manageComputer({ action: "unlink", nodeId: lb.hello().nodeId });
    expect(await sa.peers()).toHaveLength(0);
    await restartB();
    await eventually(async () => !(await sb.peers()).length, 15_000);
  }, 25_000);

  test("reconnect tries the next known route after a pin mismatch without granting the false route access", async () => {
    await pair();
    let calls = 0;
    const falseRoute = await listenLink({ host: "127.0.0.1", port: 0, identity: await generateIdentity(), routes: (router) => {
      router.service(link.ComputerLinkService, { pair: async () => { calls++; return create(link.PairResponseSchema); }, connect: async function* () { calls++; } });
    } });
    try {
      await sa.query("UPDATE computer_peers SET addresses='[]'::jsonb WHERE owner_user_id=$1::uuid", [a.userId]);
      await sb.query("UPDATE computer_peers SET addresses=$2::jsonb WHERE owner_user_id=$1::uuid", [b.userId, JSON.stringify([`https://127.0.0.1:${falseRoute.port}`, la.addresses[0]!])]);
      await restartB(); await online();
      expect(calls).toBe(0);
      expect((await sb.peers())[0]!.addresses[0]).toBe(la.addresses[0]!);
    } finally { await falseRoute.close(); }
  }, 25_000);

  test("failed attempts exhaust invitations and the persistent global rate budget", async () => {
    const invitation = await a.api.createComputerPairing({});
    const client = linkClient(la.addresses[0]!, la.identity.certificate, lb.identity);
    await sa.query("UPDATE computer_pairing_budget SET attempts=0,window_start=now()");
    for (let i = 0; i < 10; i++) await client.pair({ secret: "wrong", hello: lb.hello() }).catch(() => {});
    expect(await failure(b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code }))).toContain("exhausted");
    await sa.query("UPDATE computer_pairing_budget SET attempts=30,window_start=now()");
    expect(await failure(client.pair({ secret: "wrong", hello: lb.hello() }))).toContain("Too many");
  }, 20_000);
});
