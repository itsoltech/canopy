import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { WorkerAdministration } from "../../apps/gateway/src/core/worker-administration.ts";
import { WorkerSsh } from "../../apps/gateway/src/core/worker-ssh.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { Server, utils } from "ssh2";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let gw: TestGateway;
let directory = "";
let ssh: Server;
let port: number;
let authenticated = 0;
let privateKey = "";
const hostKey = utils.generateKeyPairSync("ed25519", {});
async function collect(action: string, extra: MessageInitShape<typeof ui.WorkerSshRequestSchema> = {}) {
  const output: ui.WorkerSshEvent[] = [];
  for await (const event of gw.api.workerSsh({ action, ...extra }, { timeoutMs: 20_000 })) output.push(event);
  return output;
}
async function query(statement: string, params: unknown[]) {
  return gw.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; return yield* sql.unsafe<Record<string, unknown>>(statement, params); }));
}

describe.skipIf(!dockerAvailable)("owner-scoped SSH enrollment trust boundary", () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "canopy-ssh-test-"));
    gw = await startTestGateway({ updates: { cacheDir: join(directory, "mirror") } });
    ssh = new Server({ hostKeys: [hostKey.private] }, (connection) => {
      connection.on("error", () => {});
      connection.on("authentication", (ctx) => { authenticated++; ctx.reject(); });
    });
    await new Promise<void>((resolve) => ssh.listen(0, "127.0.0.1", resolve));
    port = (ssh.address() as { port: number }).port;
  }, 60_000);
  afterAll(async () => { ssh?.close(); await gw?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

  test("generates once, encrypts at rest, probe never authenticates, explicit trust pins before authentication", async () => {
    const key = (await collect("key"))[0]!.publicKey;
    expect(key).toStartWith("ssh-ed25519 ");
    expect((await collect("key"))[0]!.publicKey).toBe(key);
    const rows = await query("SELECT private_key, public_key, key_id FROM worker_ssh_keys WHERE owner_user_id = $1", [gw.userId]);
    privateKey = Buffer.from(rows[0]!["private_key"] as Uint8Array).toString();
    expect(privateKey).not.toContain("PRIVATE KEY");
    expect(rows[0]!["key_id"]).toBe("env-v1");
    const target = `canopy@127.0.0.1:${port}`;
    const probe = await collect("probe", { target });
    const fingerprint = probe.find((e) => e.fingerprint)!.fingerprint;
    expect(fingerprint).toStartWith("SHA256:"); expect(authenticated).toBe(0);
    expect(await failure(collect("install", { target, name: "No confirmation", webOrigin: "http://localhost" }))).toContain("does not match");
    expect(authenticated).toBe(0);
    expect(await failure(collect("install", { target, fingerprint, name: "Wrong key", webOrigin: "http://localhost" }))).toContain("Add this Canopy public key");
    // ssh2 only sends authentication after accepting the pinned/confirmed host key.
    expect(authenticated).toBeGreaterThan(0);
  });

  test("a stored host-key mismatch is a hard error, independent of supplied confirmation", async () => {
    await query("INSERT INTO worker_ssh_hosts (owner_user_id, host, port, fingerprint) VALUES ($1, '127.0.0.1', $2, 'SHA256:old') ON CONFLICT (owner_user_id, host, port) DO UPDATE SET fingerprint = 'SHA256:old'", [gw.userId, port]);
    const attempts = authenticated;
    expect(await failure(collect("probe", { target: `canopy@127.0.0.1:${port}` }))).toContain("host key changed");
    expect(await failure(collect("install", { target: `canopy@127.0.0.1:${port}`, fingerprint: "SHA256:old" }))).toContain("host key changed");
    expect(authenticated).toBe(attempts);
  });

  test("separate owners have separate keys and pins; rotation preserves host pins and audits have no key material", async () => {
    const userId = Bun.randomUUIDv7();
    await query("INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'Other', 'user')", [userId, `${userId}@test`]);
    const administration = new WorkerAdministration({ ...gw.core.workers.options, userId });
    const other = new WorkerSsh({ runtime: gw.runtime, userId, workers: administration, secretsKey: randomBytes(32) });
    const events: ui.WorkerSshEvent[] = [];
    for await (const event of other.run(create(ui.WorkerSshRequestSchema, { action: "key" }), new AbortController().signal)) events.push(event);
    const original = (await collect("key"))[0]!.publicKey;
    expect(events[0]!.publicKey).not.toBe(original);
    expect((await query("SELECT * FROM worker_ssh_hosts WHERE owner_user_id = $1", [userId])).length).toBe(0);
    expect((await collect("rotate"))[0]!.publicKey).not.toBe(original);
    expect((await query("SELECT fingerprint FROM worker_ssh_hosts WHERE owner_user_id = $1", [gw.userId]))[0]!["fingerprint"]).toBe("SHA256:old");
    const audit = JSON.stringify(await query("SELECT action, details FROM audit_log WHERE actor_user_id = $1", [gw.userId]));
    expect(audit).toContain("worker.ssh.key.rotate"); expect(audit).not.toContain(privateKey); expect(audit).not.toContain("PRIVATE KEY");
  });
});
