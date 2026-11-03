/// <reference path="./worker-installer.d.ts" />
import { createHash } from "node:crypto";
import { Client, utils, type ClientChannel } from "ssh2";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { decryptSecret, encryptSecret, loadSecretsKey, SECRETS_KEY_ID } from "../store/secrets.ts";
import type { CoreRuntime } from "./core.ts";
import type { WorkerAdministration } from "./worker-administration.ts";
import installer from "../../../../scripts/install-worker.sh" with { type: "text" };

export interface SshTarget { username: string; host: string; port: number }
export function sshTarget(value: string): SshTarget {
  const match = /^([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63})@(?:\[([a-fA-F0-9:]+)\]|([a-zA-Z0-9][a-zA-Z0-9.-]{0,252}))(?::([0-9]{1,5}))?$/.exec(value.trim());
  const port = Number(match?.[4] ?? 22);
  if (!match || port < 1 || port > 65535) throw new ConnectError("Use login@host[:port] (IPv6: login@[address]:port)", Code.InvalidArgument);
  return { username: match[1]!, host: (match[2] ?? match[3]!).toLowerCase(), port };
}
export const sshFingerprint = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
type KeyRow = { public_key: string; private_key: Uint8Array };

/** No arbitrary command API. Host verification always precedes SSH authentication. */
export class WorkerSsh {
  #active = false;
  constructor(readonly options: { runtime: CoreRuntime; userId: string; workers: WorkerAdministration; secretsKey?: Buffer }) {}

  async #key(rotate = false): Promise<KeyRow> {
    const { runtime, userId } = this.options;
    const master = this.options.secretsKey ?? loadSecretsKey(Bun.env);
    return runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(Effect.gen(function* () {
        yield* sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
        const existing = yield* sql<KeyRow>`SELECT public_key, private_key FROM worker_ssh_keys WHERE owner_user_id = ${userId}::uuid`;
        if (existing[0] && !rotate) return existing[0];
        const pair = utils.generateKeyPairSync("ed25519", { comment: "canopy-worker-install" });
        const encrypted = encryptSecret(master, pair.private);
        yield* sql`INSERT INTO worker_ssh_keys (owner_user_id, public_key, private_key, key_id)
          VALUES (${userId}::uuid, ${pair.public}, ${encrypted}, ${SECRETS_KEY_ID})
          ON CONFLICT (owner_user_id) DO UPDATE SET public_key = excluded.public_key, private_key = excluded.private_key,
          key_id = excluded.key_id, created_at = now()`;
        yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, ${rotate ? "worker.ssh.key.rotate" : "worker.ssh.key.create"}, 'user', ${userId}::uuid)`;
        return { public_key: pair.public, private_key: encrypted };
      }));
    }));
  }
  async #pin(target: SshTarget, fingerprint?: string): Promise<string | undefined> {
    const { runtime, userId } = this.options;
    return runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (fingerprint) {
        const inserted = yield* sql`INSERT INTO worker_ssh_hosts (owner_user_id, host, port, fingerprint)
          VALUES (${userId}::uuid, ${target.host}, ${target.port}, ${fingerprint}) ON CONFLICT DO NOTHING RETURNING host`;
        if (inserted.length) yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'worker.ssh.host.trust', 'user', ${userId}::uuid)`;
      }
      const rows = yield* sql<{ fingerprint: string }>`SELECT fingerprint FROM worker_ssh_hosts
        WHERE owner_user_id = ${userId}::uuid AND host = ${target.host} AND port = ${target.port}`;
      return rows[0]?.fingerprint;
    }));
  }
  async #audit(action: string) {
    const { runtime, userId } = this.options;
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
        VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, ${action}, 'user', ${userId}::uuid)`;
    }));
  }
  async *run(request: ui.WorkerSshRequest, signal: AbortSignal): AsyncIterable<ui.WorkerSshEvent> {
    if (this.#active) throw new ConnectError("An SSH operation is already running. Cancel it first.", Code.FailedPrecondition);
    this.#active = true;
    try { yield* this.#run(request, signal); }
    catch (error) {
      if (error instanceof ConnectError) throw error;
      throw new ConnectError("SSH setup failed. Check the gateway secrets key and try again.", Code.FailedPrecondition);
    } finally { this.#active = false; }
  }
  async *#run(request: ui.WorkerSshRequest, signal: AbortSignal): AsyncIterable<ui.WorkerSshEvent> {
    if (!["key", "rotate", "probe", "install"].includes(request.action)) throw new ConnectError("Unknown SSH action", Code.InvalidArgument);
    const key = await this.#key(request.action === "rotate");
    yield create(ui.WorkerSshEventSchema, { publicKey: key.public_key });
    if (["key", "rotate"].includes(request.action)) return;
    const target = sshTarget(request.target);
    const pinned = await this.#pin(target);
    const client = new Client();
    const events = new AsyncChannel<ui.WorkerSshEvent>();
    let channel: ClientChannel | undefined;
    let fingerprint = "";
    let token = "";
    let invitationId = "";
    let finished = false;
    const fail = (message: string) => { events.close(new ConnectError(message, Code.FailedPrecondition)); channel?.close(); client.destroy(); };
    const abort = () => fail("SSH installation cancelled. A service already started on the target may still be running.");
    const timeout = setTimeout(() => fail("SSH installation timed out after 5 minutes"), 300_000);
    signal.addEventListener("abort", abort, { once: true });
    client.on("error", (error: Error & { level?: string }) => {
      if (request.action === "probe" && fingerprint && (!pinned || pinned === fingerprint)) {
        events.push(create(ui.WorkerSshEventSchema, { fingerprint, trusted: pinned === fingerprint })); events.close(); return;
      }
      fail(pinned && fingerprint && pinned !== fingerprint ? "SSH host key changed. Installation blocked; verify the host with its administrator."
        : error.level === "client-authentication" ? "SSH authentication failed. Add this Canopy public key to the target user's ~/.ssh/authorized_keys."
        : fingerprint && request.action === "install" && fingerprint !== (pinned ?? request.fingerprint) ? "SSH host key does not match your confirmation. Installation blocked."
        : "SSH host unreachable or handshake failed. Check the address, port and network from the gateway.");
    });
    client.on("close", () => { if (!finished && !events.closed && request.action !== "probe") fail("SSH connection closed before installation completed"); });
    client.on("ready", () => {
      void (async () => {
        if (!fingerprint || fingerprint !== (pinned ?? request.fingerprint)) throw new ConnectError("Confirm the SSH host fingerprint before installing", Code.FailedPrecondition);
        if (await this.#pin(target, fingerprint) !== fingerprint) throw new ConnectError("SSH host key changed. Installation blocked.", Code.FailedPrecondition);
        await this.#audit("worker.ssh.install.start");
        const origin = new URL(request.webOrigin);
        if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
          throw new ConnectError("Use the Canopy web origin", Code.InvalidArgument);
        }
        const setup = await this.options.workers.setup();
        signal.throwIfAborted();
        if (!setup.gatewayUrl) throw new ConnectError("Set the worker gateway address first", Code.FailedPrecondition);
        const invitation = await this.options.workers.create(request.name);
        token = invitation.token; invitationId = invitation.enrollment!.id;
        signal.throwIfAborted();
        events.push(create(ui.WorkerSshEventSchema, { enrollment: invitation.enrollment, fingerprint, trusted: true }));
        client.exec("sh -s", { pty: false }, (error, stream) => {
          if (error) { fail("Could not start the fixed installer over SSH"); return; }
          channel = stream;
          let output = "";
          let bytes = 0;
          let reused = false;
          const emit = (data: Buffer) => {
            bytes += data.length;
            if (bytes > 128_000) { fail("SSH installer output exceeded its limit"); return; }
            output += data.toString("utf8");
            const lines = output.split("\n"); output = lines.pop()!;
            for (const line of lines) {
              if (line.startsWith("Existing config preserved")) reused = true;
              events.push(create(ui.WorkerSshEventSchema, { output: sanitizeSshOutput(line, token) + "\n" }));
            }
          };
          stream.on("data", emit); stream.stderr.on("data", emit);
          stream.on("close", (code: number | null) => {
            if (output) events.push(create(ui.WorkerSshEventSchema, { output: sanitizeSshOutput(output, token) + "\n" }));
            if (code !== 0) { fail("Installer failed. Check the output above; an SSH session may need a systemd user session or macOS GUI login."); return; }
            if (reused) { fail("This target already has a worker config. Its binary/service were reinstalled without replacing enrollment. Check its existing entry in Settings → Workers."); return; }
            // A started service is not proof of a connected worker. Keep the RPC alive until Hello.
            void (async () => {
              events.push(create(ui.WorkerSshEventSchema, { output: "Waiting for the worker to connect to Canopy…\n" }));
              const deadline = Date.now() + 60_000;
              while (!events.closed) {
                signal.throwIfAborted();
                const current = (await this.options.workers.setup()).enrollments.find((e) => e.id === invitationId);
                if (current?.workerId && this.options.workers.options.link.connections.has(current.workerId)) {
                  await this.#audit("worker.ssh.install.finish");
                  finished = true;
                  events.push(create(ui.WorkerSshEventSchema, { enrollment: current, output: "Worker connected to Canopy.\n" }));
                  events.close(); return;
                }
                if (Date.now() >= deadline) { fail("Service started, but the worker did not connect within 60 seconds. Check the target's access to the worker gateway address."); return; }
                await new Promise<void>((resolve) => setTimeout(resolve, 250));
              }
            })().catch(() => fail("Could not confirm the worker connection"));
          });
          // Secrets travel through encrypted stdin, never the SSH command, logs or browser.
          stream.end(`set -- --channel-fallback --origin ${quote(origin.origin)} --gateway ${quote(setup.gatewayUrl)} --token ${quote(token)} --name ${quote(request.name)}\n${installer}\n`);
        });
      })().catch((error: unknown) => fail(error instanceof ConnectError ? error.rawMessage : "SSH installation failed"));
    });
    try {
      signal.throwIfAborted();
      client.connect({ ...target, privateKey: decryptSecret(this.options.secretsKey ?? loadSecretsKey(Bun.env), key.private_key),
        readyTimeout: 15_000, keepaliveInterval: 10_000, keepaliveCountMax: 3,
        hostVerifier: (raw: Buffer, verify: (valid: boolean) => void) => {
          fingerprint = sshFingerprint(raw);
          // Probe deliberately stops before authentication; the user sees this fingerprint first.
          if (request.action !== "install" || fingerprint !== (pinned ?? request.fingerprint)) { verify(false); return; }
          void this.#pin(target, fingerprint).then((saved) => verify(!signal.aborted && saved === fingerprint), () => verify(false));
        },
      });
      yield* events;
    } finally {
      clearTimeout(timeout); signal.removeEventListener("abort", abort); channel?.close(); client.destroy(); events.close();
      if (invitationId) await this.options.workers.revokeEnrollment(invitationId).catch(() => {});
      if (!finished && request.action === "install") await this.#audit("worker.ssh.install.interrupted").catch(() => {});
      token = "";
    }
  }
}

/** Line buffering before redaction also handles secrets split across SSH packets. */
export function sanitizeSshOutput(value: string, token: string): string {
  return value.replaceAll(token || "\u0000", "[redacted]").replace(/[A-Za-z0-9_-]{43,}/g, "[redacted]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
