import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ui, WorkerEnrollmentService } from "@canopy/contracts";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient, type SqlConnection } from "effect/sql";
import { ed25519KeyPair } from "../../apps/gateway/src/core/ssh-keys.ts";
import { WorkerAdministration } from "../../apps/gateway/src/core/worker-administration.ts";
import { WorkerSsh } from "../../apps/gateway/src/core/worker-ssh.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { Server } from "ssh2";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let gw: TestGateway;
let directory = "";
let ssh: Server;
let port: number;
let authenticated = 0;
let acceptInstall = false;
let installerFailure = "";
let installerInput = "";
let privateKey = "";
let network: NetworkAccess;
const hostKey = ed25519KeyPair("");

async function collect(action: string, extra: MessageInitShape<typeof ui.WorkerSshRequestSchema> = {}) {
  const output: ui.WorkerSshEvent[] = [];

  for await (const event of gw.api.workerSsh({ action, ...extra }, { timeoutMs: 20_000 })) output.push(event);

  return output;
}

async function query(statement: string, params: unknown[]) {
  return gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe<SqlConnection.Row>(statement, params);
    }),
  );
}

describe.skipIf(!dockerAvailable)("owner-scoped SSH enrollment trust boundary", () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "canopy-ssh-test-"));
    gw = await startTestGateway({ updates: { cacheDir: join(directory, "mirror") } });
    await gw.core.updates.service.options.mirror.remember({
      schema: 1,
      version: gw.core.updates.version,
      channel: "nightly",
      commit: "fixture",
      published_at: "2026-11-05T00:00:00Z",
      protocol: { worker_link: 1, update: 1 },
      assets: [
        {
          app: "worker",
          os: "linux",
          arch: "x64",
          name: "canopy-worker-linux-x64",
          url: "https://github.com/itsoltech/canopy/releases/download/v0.2.0-nightly.74/canopy-worker-linux-x64",
          sha256: "a".repeat(64),
          size: 42,
        },
      ],
    });
    ssh = new Server({ hostKeys: [hostKey.private] }, (connection) => {
      connection.on("error", () => {});
      connection.on("authentication", (ctx) => {
        authenticated++;

        if (acceptInstall) ctx.accept();
        else ctx.reject();
      });
      connection.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, _reject, info) => {
          expect(info.command).toBe("sh -s");
          const stream = accept();
          stream.on("data", (chunk: Buffer) => {
            installerInput += chunk.toString();
          });
          stream.on("end", () => {
            if (installerFailure) {
              stream.stderr.write(`Canopy: ${installerFailure}`);
              stream.exit(1);
              stream.end();

              return;
            }

            void (async () => {
              const token = installerInput.match(/--token '([^']+)'/)?.[1];

              if (!token) throw new Error("Fixed installer did not receive an enrollment token");
              const client = createClient(WorkerEnrollmentService, createGrpcTransport({ baseUrl: gw.grpcUrl }));

              const enrolled = await client.enroll({
                enrollmentToken: token,
                host: { hostname: "ssh-tagged", os: "linux", arch: "x64" },
              });

              await gw.connect(enrolled.workerId, enrolled.workerCredential, "linux");
              stream.exit(0);
              stream.end();
            })().catch(() => {
              stream.exit(1);
              stream.end();
            });
          });
        });
      });
    });
    await new Promise<void>((resolve) => ssh.listen(0, "127.0.0.1", resolve));
    port = (ssh.address() as { port: number }).port;
  }, 60_000);
  afterAll(async () => {
    ssh?.close();
    await network?.close();
    await gw?.close();

    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test("generates once, encrypts at rest, probe never authenticates, explicit trust pins before authentication", async () => {
    const key = (await collect("key"))[0]!.publicKey;
    expect(key).toStartWith("ssh-ed25519 ");
    expect((await collect("key"))[0]!.publicKey).toBe(key);

    const rows = await query("SELECT private_key, public_key, key_id FROM worker_ssh_keys WHERE owner_user_id = $1", [
      gw.userId,
    ]);

    privateKey = Buffer.from(rows[0]!["private_key"] as Uint8Array).toString();
    expect(privateKey).not.toContain("PRIVATE KEY");
    expect(rows[0]!["key_id"]).toBe("env-v1");
    const target = `canopy@127.0.0.1:${port}`;
    const probe = await collect("probe", { target });
    const fingerprint = probe.find((e) => e.fingerprint)!.fingerprint;
    expect(fingerprint).toStartWith("SHA256:");
    expect(authenticated).toBe(0);
    expect(
      await failure(collect("install", { target, name: "No confirmation", webOrigin: "http://localhost" })),
    ).toContain("does not match");
    expect(authenticated).toBe(0);
    expect(
      await failure(collect("install", { target, fingerprint, name: "Wrong key", webOrigin: "http://localhost" })),
    ).toContain("Add this Canopy public key");
    // ssh2 only sends authentication after accepting the pinned/confirmed host key.
    expect(authenticated).toBeGreaterThan(0);
  });

  test("SSH refuses installation before executing when no gateway address is reachable", async () => {
    acceptInstall = true;
    expect(
      await failure(
        collect("install", {
          target: `canopy@127.0.0.1:${port}`,
          name: "No route",
          webOrigin: "http://127.0.0.1:49788",
        }),
      ),
    ).toContain("Turn on network access or set a gateway address for workers");
    expect(installerInput).toBe("");
    expect((await gw.api.getWorkerSetup({})).enrollments).toHaveLength(0);
  });

  test("desktop local SSH uses HTTPS release downloads and a pinned network gateway, preserving tags", async () => {
    network = new NetworkAccess({
      store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
      host: "127.0.0.1",
      detect: () => [{ host: "192.0.2.20", kind: "lan", interfaceName: "fixture" }],
      pollMs: 60_000,
    });
    gw.core.network = network;
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
    const settings = await gw.api.getSettings({});
    await gw.api.updateUserSettings({ expectedVersion: settings.user!.version, workerGatewayUrl: "" });
    const target = `canopy@127.0.0.1:${port}`;

    const events = await collect("install", {
      target,
      name: "SSH tagged worker",
      tags: ["ssh-team"],
      webOrigin: "http://127.0.0.1:49788",
    });

    const workerId = events.findLast((e) => e.enrollment?.workerId)?.enrollment?.workerId;
    expect(workerId).toBeDefined();
    expect(installerInput.includes("ssh-team")).toBe(false);
    expect(installerInput).toContain(`--gateway '${network.origins()[0]}'`);
    expect(installerInput).toContain(`--fingerprint '${network.fingerprint}'`);
    expect(installerInput).toContain("--release-url 'https://github.com/itsoltech/canopy/releases/download/");
    expect(installerInput).toContain(`--release-sha256 '${"a".repeat(64)}'`);
    expect(installerInput).not.toContain("http://127.0.0.1:49788");
    expect(installerInput).not.toContain("--origin '");
    expect((await gw.api.getAgentEnvironment({})).workers.find((w) => w.workerId === workerId)?.manualTags).toEqual([
      "ssh-team",
    ]);
    expect(
      await query("SELECT tags FROM worker_enrollments WHERE worker_id = $1 AND owner_user_id = $2", [
        workerId,
        gw.userId,
      ]),
    ).toEqual([{ tags: ["ssh-team"] }]);
    acceptInstall = false;
    installerInput = "";
  });

  test("SSH reports the actual installer failure without an unrelated service-session hint", async () => {
    acceptInstall = true;
    installerFailure = "Worker download failed. Check this computer’s access to GitHub Releases and retry";

    try {
      const message = await failure(
        collect("install", {
          target: `canopy@127.0.0.1:${port}`,
          name: "Download failure",
          webOrigin: "http://127.0.0.1:49788",
        }),
      );

      expect(message).toContain(installerFailure);
      expect(message).not.toContain("systemd");
      expect(message).not.toContain("macOS GUI");
    } finally {
      installerFailure = "";
      acceptInstall = false;
      installerInput = "";
    }
  });

  test("a stored host-key mismatch is a hard error, independent of supplied confirmation", async () => {
    await query(
      "INSERT INTO worker_ssh_hosts (owner_user_id, host, port, fingerprint) VALUES ($1, '127.0.0.1', $2, 'SHA256:old') ON CONFLICT (owner_user_id, host, port) DO UPDATE SET fingerprint = 'SHA256:old'",
      [gw.userId, port],
    );
    const attempts = authenticated;
    expect(await failure(collect("probe", { target: `canopy@127.0.0.1:${port}` }))).toContain("host key changed");
    expect(
      await failure(collect("install", { target: `canopy@127.0.0.1:${port}`, fingerprint: "SHA256:old" })),
    ).toContain("host key changed");
    expect(authenticated).toBe(attempts);
  });

  test("separate owners have separate keys and pins; rotation preserves host pins and audits have no key material", async () => {
    const userId = Bun.randomUUIDv7();
    await query("INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'Other', 'user')", [
      userId,
      `${userId}@test`,
    ]);
    const administration = new WorkerAdministration({ ...gw.core.workers.options, userId });

    const other = new WorkerSsh({
      runtime: gw.runtime,
      userId,
      workers: administration,
      updates: gw.core.updates,
      secretsKey: randomBytes(32),
    });

    const events: ui.WorkerSshEvent[] = [];

    for await (const event of other.run(
      create(ui.WorkerSshRequestSchema, { action: "key" }),
      new AbortController().signal,
    ))
      events.push(event);
    const original = (await collect("key"))[0]!.publicKey;
    expect(events[0]!.publicKey).not.toBe(original);
    expect((await query("SELECT * FROM worker_ssh_hosts WHERE owner_user_id = $1", [userId])).length).toBe(0);
    expect((await collect("rotate"))[0]!.publicKey).not.toBe(original);
    expect(
      (await query("SELECT fingerprint FROM worker_ssh_hosts WHERE owner_user_id = $1", [gw.userId]))[0]![
        "fingerprint"
      ],
    ).toBe("SHA256:old");

    const audit = JSON.stringify(
      await query("SELECT action, details FROM audit_log WHERE actor_user_id = $1", [gw.userId]),
    );

    expect(audit).toContain("worker.ssh.key.rotate");
    expect(audit).not.toContain(privateKey);
    expect(audit).not.toContain("PRIVATE KEY");
  });
});
