import { expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { nodeRef, qualifyId } from "@canopy/domain/computers";
import { Code } from "@connectrpc/connect";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  exportConsolidationProjection,
  loadApprovedConsolidationSecrets,
} from "../../apps/gateway/src/migration/consolidation-projection.ts";
import { consolidationReviewSchema } from "../../apps/gateway/src/migration/consolidation-target-state.ts";
import { handleCutoverTarget } from "../../apps/gateway/src/migration/cutover-target.ts";
import type { JoinRequest } from "../../apps/gateway/src/migration/cutover-protocol.ts";
import {
  abortFence,
  commitSourceFence,
  readFence,
  requestDrain,
} from "../../apps/gateway/src/migration/relocation-fence.ts";
import { decryptSecret, encryptSecret, SECRETS_KEY_ID } from "../../apps/gateway/src/store/secrets.ts";
import { ScriptedWorker, eventually } from "./support/gateway.ts";
import {
  attachmentData,
  connectWorker,
  pairedClient,
  rpcError,
  seedSource,
  verifyHistory,
} from "./support/gateway-relocation-data.ts";
import {
  createRelocationSandbox,
  privateFile,
  relocationAvailable,
  type RelocationHost,
} from "./support/gateway-relocation.ts";

const tempDir = tempDirs();
const decodePrepared = Schema.decodeUnknownSync(Schema.Struct({ review: consolidationReviewSchema }));

async function sqlRun<A, E>(host: RelocationHost, use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) {
  const runtime = ManagedRuntime.make(host.db.layer);

  try {
    return await runtime.runPromise(SqlClient.SqlClient.use(use));
  } finally {
    await runtime.dispose();
  }
}

async function identity(host: RelocationHost) {
  const [row] = await sqlRun(
    host,
    (sql) =>
      sql<{ id: string; owner: string; cert: string }>`SELECT node_id AS id, owner_user_id AS owner, certificate AS cert
      FROM public.computer_identity`,
  );

  if (!row) throw new Error("Fixture gateway did not create its identity");

  return row;
}

function receive(target: RelocationHost, request: JoinRequest, parts: BlobPart[] = []) {
  return handleCutoverTarget(target.env, new Blob([JSON.stringify(request) + "\n", ...parts]).stream());
}

async function offer(target: RelocationHost, directory: string, runId: string) {
  const manifest = Bun.file(join(directory, "manifest.json"));
  const archive = Bun.file(join(directory, "database.dump"));

  return receive(
    target,
    {
      version: 1,
      runId,
      action: "join-prepare",
      manifestBytes: manifest.size,
      archiveBytes: archive.size,
    },
    await Promise.all([manifest.arrayBuffer(), archive.arrayBuffer()]),
  );
}

type Seed = Awaited<ReturnType<typeof seedSource>>;

async function resumeOn(target: RelocationHost, seed: Seed, pin: Seed["trust"], signal: AbortSignal) {
  const link = await connectWorker(target, seed.profile, pin, {
    signal,
    threads: [{ threadId: seed.threadId, lastSeq: 4n }],
  });

  expect(link.welcome.persisted).toContainEqual(expect.objectContaining({ threadId: seed.threadId, lastSeq: 4n }));

  const worker = new ScriptedWorker(link, { resumeJournal: true });
  const message = "Continue in the original session after consolidation";

  const result = await target.api.sendMessage({
    threadId: seed.threadId,
    text: message,
    clientRequestId: randomUUID(),
  });

  await eventually(
    async () => worker.started.get(result.turn!.id)?.text,
    (text) => text === message,
  );
  await eventually(
    () =>
      sqlRun(
        target,
        (sql) => sql<{ status: string }>`SELECT status FROM public.turns WHERE id=${result.turn!.id}::uuid`,
      ),
    ([row]) => row?.status === "completed",
  );
  await verifyHistory(target.api, seed.threadId, [seed.originalAnswer, "Echo: " + message]);
  expect(
    worker.commands.some(
      (command) => command.case === "startTurn" && command.value.thread?.providerThreadId === "codex-" + seed.threadId,
    ),
  ).toBe(true);
  link.close();
  await link.closed;
}

test.skipIf(!relocationAvailable)(
  "an offline linked computer later joins one gateway without duplicating mirrored history or losing its worker",
  async () => {
    const directory = tempDir("canopy-join-");
    const sandbox = await createRelocationSandbox(directory);
    const clients = new AbortController();
    const primaryKey = randomBytes(32);
    const sourceKey = randomBytes(32);
    const runId = randomUUID();
    const keyId = randomUUID();
    const fixtureSecret = randomBytes(30).toString("hex");

    try {
      const primary = await sandbox.host("primary", { migrated: true, secretsKey: primaryKey.toString("base64") });
      const source = await sandbox.host("additional", { migrated: true, secretsKey: sourceKey.toString("base64") });
      await privateFile(
        primary.configPath,
        JSON.stringify({ ...primary.config, networkOrigins: [primary.networkUrl] }),
      );
      await primary.start();
      const home = await seedSource(primary, clients.signal);
      const parent = await identity(primary);
      await source.start();
      const child = await seedSource(source, clients.signal);
      const origin = await identity(source);
      const parentRef = qualifyId(home.threadId, nodeRef(parent.id));

      const schedule = await source.api.createSchedule({
        threadId: child.threadId,
        prompt: "Next year only",
        when: { case: "cron", value: "0 0 1 1 *" },
      });

      await sqlRun(source, (sql) =>
        Effect.gen(function* () {
          yield* sql`UPDATE public.threads SET remote_parent_ref=${parentRef},remote_parent_kind='thread'
          WHERE id=${child.threadId}::uuid`;
          yield* sql`INSERT INTO public.computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
          VALUES(${origin.owner}::uuid,${parent.id},'Primary',${parent.cert},${home.trust.fingerprint})`;
          yield* sql`INSERT INTO public.computer_mirror_state(owner_user_id,origin_node_id)
          VALUES(${origin.owner}::uuid,${parent.id})`;
          yield* sql`INSERT INTO public.computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
          SELECT owner_user_id,origin_node_id,generation,${home.threadId}::uuid,'\\x00'::bytea,'\\x00'::bytea
            FROM public.computer_mirror_state WHERE origin_node_id=${parent.id}`;
          yield* sql`INSERT INTO public.secrets(id,owner_user_id,name,ciphertext,key_id,created_by)
          VALUES(${keyId}::uuid,${origin.owner}::uuid,'join-only-secret',${encryptSecret(sourceKey, fixtureSecret)},
            ${SECRETS_KEY_ID},${origin.owner}::uuid)`;
        }),
      );

      await source.stop();
      expect(await primary.ready()).toBe(true);
      await verifyHistory(primary.api, home.threadId, [home.originalAnswer]);
      await source.start();
      await requestDrain(source.env, runId);
      await eventually(
        () => readFence(source.env),
        (fence) => fence?.state === "drained",
      );
      await eventually(async () => source.stopped(), Boolean);

      const exportPath = join(directory, "approved-projection");

      const snapshot = await exportConsolidationProjection(source.env, exportPath, {
        operationId: runId,
        offline: true,
      });

      const prepared = await offer(primary, exportPath, runId);
      expect(prepared).toMatchObject({ phase: "reviewed", archiveSha256: snapshot.archiveSha256 });
      const { review } = decodePrepared(prepared);
      expect(review.blockers).toEqual([]);
      expect(review.counts["threads"]).toBe(1);
      expect(review.secrets).toHaveLength(1);
      expect(primary.starts).toBe(1);

      const approval = {
        reviewDigest: review.reviewDigest,
        conflictChoices: Object.fromEntries(review.conflicts.map(({ id }) => [id, "target" as const])),
        approvedSecretIds: review.secrets.map(({ id }) => id),
      };

      const secrets = await loadApprovedConsolidationSecrets(source.env, exportPath, {
        operationId: runId,
        archiveSha256: snapshot.archiveSha256,
        approvedSecretIds: approval.approvedSecretIds,
      });

      const secretBody = JSON.stringify(secrets);
      const deviceToken = "canopy_desktop_" + randomBytes(32).toString("base64url");

      const device = {
        id: randomUUID(),
        tokenHash: createHash("sha256").update(deviceToken).digest("hex"),
        name: "Joined Desktop",
        platform: "linux" as const,
      };

      await commitSourceFence(source.env, runId);
      await expect(abortFence(source.env, runId)).rejects.toThrow();

      const request = {
        version: 1,
        runId,
        action: "join-import",
        archiveSha256: snapshot.archiveSha256,
        approval,
        desktopDevice: device,
        secretBytes: Buffer.byteLength(secretBody),
      } satisfies JoinRequest;

      const applied = await receive(primary, request, [secretBody]);
      expect(applied).toMatchObject({
        phase: "applied",
        routes: { addresses: [primary.networkUrl], fingerprint: home.trust.fingerprint },
      });
      expect(JSON.stringify(applied).includes(fixtureSecret)).toBe(false);
      expect(await receive(primary, request, [secretBody])).toEqual(applied);
      expect(primary.starts).toBe(2);
      await child.worker.link.closed;
      await home.worker.link.closed;
      expect(await readFence(source.env)).toEqual({ operationId: runId, state: "committed" });

      const desktop = pairedClient(primary, home.trust, deviceToken);
      expect((await desktop.getThread({ threadId: child.threadId })).thread?.parentThreadId).toBe(home.threadId);
      expect((await desktop.getAttachment({ attachmentId: child.attachment.id })).data).toEqual(attachmentData);
      expect((await rpcError(pairedClient(primary, home.trust, child.revoked.deviceToken).getOverview({})))?.code).toBe(
        Code.Unauthenticated,
      );

      const restored = await sqlRun(primary, (sql) =>
        Effect.gen(function* () {
          const threads = yield* sql<{ id: string }>`SELECT id FROM public.threads`;

          const schedules = yield* sql<{
            id: string;
          }>`SELECT id FROM public.schedules WHERE id=${schedule.schedule!.id}::uuid`;

          const [secret] = yield* sql<{
            ciphertext: Uint8Array;
          }>`SELECT ciphertext FROM public.secrets WHERE id=${keyId}::uuid`;

          return { threads, schedules, secret };
        }),
      );

      expect(restored.threads.map(({ id }) => id).sort()).toEqual([home.threadId, child.threadId].sort());
      expect(restored.schedules).toHaveLength(1);
      expect(restored.secret && decryptSecret(primaryKey, restored.secret.ciphertext) === fixtureSecret).toBe(true);
      await resumeOn(primary, home, home.trust, clients.signal);
      await resumeOn(primary, child, home.trust, clients.signal);
    } finally {
      try {
        await sandbox.close();
      } finally {
        clients.abort();
      }
    }
  },
  110_000,
);
