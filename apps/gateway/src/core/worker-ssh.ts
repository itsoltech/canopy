import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { createHash } from "node:crypto";
import { Client, utils } from "ssh2";
import { decryptSecret, encryptSecret, loadSecretsKey, SECRETS_KEY_ID } from "../store/secrets.ts";
import type { CoreRuntime } from "./core.ts";
import type { WorkerAdministration } from "./worker-administration.ts";
import { installWorker, type SshInstallation } from "./worker-ssh-install.ts";
import type { GatewayUpdates } from "../updates/runtime.ts";

export interface SshTarget {
  username: string;
  host: string;
  port: number;
}

export function sshTarget(value: string): SshTarget {
  const match =
    /^([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63})@(?:\[([a-fA-F0-9:]+)\]|([a-zA-Z0-9][a-zA-Z0-9.-]{0,252}))(?::([0-9]{1,5}))?$/.exec(
      value.trim(),
    );

  const port = Number(match?.[4] ?? 22);

  if (!match || port < 1 || port > 65535)
    throw new ConnectError("Use login@host[:port] (IPv6: login@[address]:port)", Code.InvalidArgument);

  return { username: match[1]!, host: (match[2] ?? match[3]!).toLowerCase(), port };
}

export const sshFingerprint = (key: Buffer) =>
  `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

type KeyRow = { public_key: string; private_key: Uint8Array };

/** No arbitrary command API. Host verification always precedes SSH authentication. */
export class WorkerSsh {
  #active = false;
  constructor(
    readonly options: {
      runtime: CoreRuntime;
      userId: string;
      workers: WorkerAdministration;
      updates: GatewayUpdates;
      secretsKey?: Buffer;
    },
  ) {}

  async #key(rotate = false): Promise<KeyRow> {
    const { runtime, userId } = this.options;
    const master = this.options.secretsKey ?? loadSecretsKey(Bun.env);

    return runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;

            const existing =
              yield* sql<KeyRow>`SELECT public_key, private_key FROM worker_ssh_keys WHERE owner_user_id = ${userId}::uuid`;

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
          }),
        );
      }),
    );
  }
  async #pin(target: SshTarget, fingerprint?: string): Promise<string | undefined> {
    const { runtime, userId } = this.options;

    return runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        if (fingerprint) {
          const inserted = yield* sql`INSERT INTO worker_ssh_hosts (owner_user_id, host, port, fingerprint)
          VALUES (${userId}::uuid, ${target.host}, ${target.port}, ${fingerprint}) ON CONFLICT DO NOTHING RETURNING host`;

          if (inserted.length)
            yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'worker.ssh.host.trust', 'user', ${userId}::uuid)`;
        }

        const rows = yield* sql<{ fingerprint: string }>`SELECT fingerprint FROM worker_ssh_hosts
        WHERE owner_user_id = ${userId}::uuid AND host = ${target.host} AND port = ${target.port}`;

        return rows[0]?.fingerprint;
      }),
    );
  }
  async #audit(action: string) {
    const { runtime, userId } = this.options;
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
        VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, ${action}, 'user', ${userId}::uuid)`;
      }),
    );
  }
  async *run(request: ui.WorkerSshRequest, signal: AbortSignal): AsyncIterable<ui.WorkerSshEvent> {
    if (this.#active)
      throw new ConnectError("An SSH operation is already running. Cancel it first.", Code.FailedPrecondition);
    this.#active = true;

    try {
      yield* this.#run(request, signal);
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      throw new ConnectError("SSH setup failed. Check the gateway secrets key and try again.", Code.FailedPrecondition);
    } finally {
      this.#active = false;
    }
  }
  async *#run(request: ui.WorkerSshRequest, signal: AbortSignal): AsyncIterable<ui.WorkerSshEvent> {
    if (!["key", "rotate", "probe", "install"].includes(request.action))
      throw new ConnectError("Unknown SSH action", Code.InvalidArgument);
    const key = await this.#key(request.action === "rotate");
    yield create(ui.WorkerSshEventSchema, { publicKey: key.public_key });

    if (["key", "rotate"].includes(request.action)) return;
    const target = sshTarget(request.target);
    const pinned = await this.#pin(target);
    const client = new Client();
    const events = new AsyncChannel<ui.WorkerSshEvent>();

    const session: SshInstallation = {
      client,
      events,
      channel: undefined,
      fingerprint: "",
      token: "",
      invitationId: "",
      finished: false,
      request,
      signal,
      target,
      pinned,
      workers: this.options.workers,
      updates: this.options.updates,
      pin: (value, fingerprint) => this.#pin(value, fingerprint),
      audit: (action) => this.#audit(action),
    };

    const fail = (message: string) => {
      events.close(new ConnectError(message, Code.FailedPrecondition));
      session.channel?.close();
      client.destroy();
    };

    const abort = () =>
      fail("SSH installation cancelled. A service already started on the target may still be running.");

    const timeout = setTimeout(() => fail("SSH installation timed out after 5 minutes"), 300_000);
    signal.addEventListener("abort", abort, { once: true });
    client.on("error", (error: Error & { level?: string }) => {
      if (request.action === "probe" && session.fingerprint && (!pinned || pinned === session.fingerprint)) {
        events.push(
          create(ui.WorkerSshEventSchema, {
            fingerprint: session.fingerprint,
            trusted: pinned === session.fingerprint,
          }),
        );
        events.close();

        return;
      }

      fail(
        pinned && session.fingerprint && pinned !== session.fingerprint
          ? "SSH host key changed. Installation blocked; verify the host with its administrator."
          : error.level === "client-authentication"
            ? "SSH authentication failed. Add this Canopy public key to the target user's ~/.ssh/authorized_keys."
            : session.fingerprint &&
                request.action === "install" &&
                session.fingerprint !== (pinned ?? request.fingerprint)
              ? "SSH host key does not match your confirmation. Installation blocked."
              : "SSH host unreachable or handshake failed. Check the address, port and network from the gateway.",
      );
    });
    client.on("close", () => {
      if (!session.finished && !events.closed && request.action !== "probe")
        fail("SSH connection closed before installation completed");
    });
    client.on("ready", () => {
      void installWorker(session, fail).catch((cause: unknown) =>
        fail(cause instanceof ConnectError ? cause.rawMessage : "SSH installation failed"),
      );
    });

    try {
      signal.throwIfAborted();
      client.connect({
        ...target,
        privateKey: decryptSecret(this.options.secretsKey ?? loadSecretsKey(Bun.env), key.private_key),
        readyTimeout: 15_000,
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
        hostVerifier: (raw: Buffer, verify: (valid: boolean) => void) => {
          session.fingerprint = sshFingerprint(raw);

          // Probe deliberately stops before authentication; the user sees this fingerprint first.
          if (request.action !== "install" || session.fingerprint !== (pinned ?? request.fingerprint)) {
            verify(false);

            return;
          }

          void this.#pin(target, session.fingerprint).then(
            (saved) => verify(!signal.aborted && saved === session.fingerprint),
            () => verify(false),
          );
        },
      });
      yield* events;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      session.channel?.close();
      client.destroy();
      events.close();

      if (session.invitationId) await this.options.workers.revokeEnrollment(session.invitationId).catch(() => {});

      if (!session.finished && request.action === "install")
        await this.#audit("worker.ssh.install.interrupted").catch(() => {});
      session.token = "";
    }
  }
}

/** Line buffering before redaction also handles secrets split across SSH packets. */
export function sanitizeSshOutput(value: string, token: string): string {
  return (
    value
      .replaceAll(token || "\u0000", "[redacted]")
      .replace(/[A-Za-z0-9_-]{43,}/g, "[redacted]")
      // oxlint-disable-next-line no-control-regex -- Strip terminal ANSI escapes from remote SSH output before displaying it.
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // oxlint-disable-next-line no-control-regex -- Strip nonprinting terminal controls while preserving tabs and newlines.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
  );
}
