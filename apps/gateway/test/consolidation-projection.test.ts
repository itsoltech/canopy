import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, startPostgres } from "@canopy/db/testing";
import { PgClient } from "@effect/sql-pg";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { generateIdentity } from "../src/computers/identity.ts";
import { databaseUrl } from "../src/database-credentials.ts";
import { databaseLayer } from "../src/migration/consolidation-catalog.ts";
import {
  exportConsolidationProjection,
  loadApprovedConsolidationSecrets,
  materializeConsolidationProjection,
  verifyConsolidationProjection,
} from "../src/migration/consolidation-projection.ts";
import { consolidationSecretId } from "../src/migration/consolidation-types.ts";
import { withTrialDatabase } from "../src/migration/postgres.ts";
import { encryptSecret } from "../src/store/secrets.ts";

const operationId = randomUUID();
const owner = randomUUID();
const other = randomUUID();
const project = randomUUID();
const worker = randomUUID();
const ownBlob = Buffer.concat([Buffer.from("owner-home file fixture"), Buffer.alloc(320 * 1024, 95)]);
const foreignBlob = Buffer.from("other-owner file fixture");
const ownSecret = randomUUID();
const unapprovedSecret = randomUUID();
const otherSecret = randomUUID();
const secretKey = randomBytes(32);
const ownCiphertext = encryptSecret(secretKey, "approved fixture");
const unapprovedCiphertext = encryptSecret(secretKey, "unapproved fixture");
const foreignCiphertext = encryptSecret(secretKey, "foreign fixture");

function seed(sql: SqlClient.SqlClient) {
  return Effect.gen(function* () {
    const identity = yield* Effect.promise(generateIdentity);
    const privateEnvelope = encryptSecret(secretKey, identity.privateKey);
    const peer = "b".repeat(64);
    const relay = "c".repeat(64);
    const movedBot = randomUUID();
    const localBot = randomUUID();
    const foreignWorker = randomUUID();
    const workspace = randomUUID();
    const ownHash = Bun.SHA256.hash(ownBlob, "hex");
    const otherHash = Bun.SHA256.hash(foreignBlob, "hex");

    yield* sql`INSERT INTO public.users (id,email,display_name,role) VALUES
      (${owner}::uuid,'dev@localhost','Owner','admin'),(${other}::uuid,'foreign@example.test','Foreign owner fixture','user')`;
    yield* sql`INSERT INTO public.computer_identity (node_id,name,certificate,private_key,owner_user_id) VALUES
      (${identity.nodeId},'Source',${identity.certificate},${privateEnvelope},${owner}::uuid)`;
    yield* sql`INSERT INTO public.projects (id,owner_user_id,name,slug) VALUES
      (${project}::uuid,${owner}::uuid,'Home project fixture','home'),
      (gen_random_uuid(),${other}::uuid,'Foreign project fixture','foreign')`;
    yield* sql`INSERT INTO public.config_items(owner_user_id,kind,global_id,local_id,home_node_id,fields,revision) VALUES
      (${owner}::uuid,'project',${project},${project},'','{"fixture":"discard unused config fields"}',1),
      (${owner}::uuid,'worker','peer-worker','',${peer},'{"fixture":"peer-only worker metadata"}',2)`;
    yield* sql`INSERT INTO public.workers(id,owner_user_id,name,credential_hash) VALUES
      (${worker}::uuid,${owner}::uuid,'Home worker fixture','worker-hash'),
      (${foreignWorker}::uuid,${other}::uuid,'Foreign worker fixture','other-worker-hash')`;
    yield* sql`INSERT INTO public.project_workspaces(id,project_id,worker_id,root_path) VALUES
      (${workspace}::uuid,${project}::uuid,${worker}::uuid,'/home-workspace-fixture'),
      (gen_random_uuid(),${project}::uuid,${foreignWorker}::uuid,'/other-workspace-fixture')`;
    yield* sql`INSERT INTO public.checkout_heads(workspace_id,branch) VALUES
      (${workspace}::uuid,'derived-checkout-head')`;
    yield* sql`INSERT INTO public.worker_model_catalogs(worker_id,profiles) VALUES
      (${worker}::uuid,'[{"fixture":"derived model cache"}]')`;
    yield* sql`INSERT INTO public.worker_environments(worker_id,manual_tags,report) VALUES
      (${worker}::uuid,ARRAY['keep-tag'],'{"fixture":"derived worker report"}')`;
    yield* sql`INSERT INTO public.bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance,moved_to) VALUES
      (${movedBot}::uuid,${owner}::uuid,'moved bot fixture','{}','codex','native',${peer}),
      (${localBot}::uuid,${owner}::uuid,'home bot fixture','{}','codex','native',NULL)`;
    yield* sql`INSERT INTO public.computer_redirects(owner_user_id,kind,item_id,from_node_id,home_node_id,basis,home_name,moved_at) VALUES
      (${owner}::uuid,'bot',${movedBot}::uuid,${identity.nodeId},${peer},'local_move','Preserve departure route',now()),
      (${owner}::uuid,'bot',gen_random_uuid(),${peer},${relay},'former_home','Ignore relayed route',now())`;
    yield* sql`INSERT INTO public.computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
      VALUES (${owner}::uuid,${peer},'Peer','peer cert fixture','peer fingerprint fixture')`;
    yield* sql`INSERT INTO public.computer_mirror_state(owner_user_id,origin_node_id) VALUES (${owner}::uuid,${peer})`;
    yield* sql`INSERT INTO public.computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
      SELECT owner_user_id,origin_node_id,generation,gen_random_uuid(),convert_to('mirror document fixture','UTF8'),''
      FROM public.computer_mirror_state`;
    yield* sql`INSERT INTO public.blobs(sha256,size_bytes,data) VALUES
      (${ownHash},${ownBlob.length},${ownBlob}),(${otherHash},${foreignBlob.length},${foreignBlob})`;
    yield* sql`INSERT INTO public.attachments(id,owner_user_id,sha256,name,mime_type,kind,size_bytes) VALUES
      (gen_random_uuid(),${owner}::uuid,${ownHash},'home.txt','text/plain','file',${ownBlob.length}),
      (gen_random_uuid(),${other}::uuid,${otherHash},'foreign.txt','text/plain','file',${foreignBlob.length})`;
    yield* sql`INSERT INTO public.secrets(id,owner_user_id,name,ciphertext,key_id,created_by) VALUES
      (${ownSecret}::uuid,${owner}::uuid,'approved',${ownCiphertext},'env-v1',${owner}::uuid),
      (${unapprovedSecret}::uuid,${owner}::uuid,'unapproved',${unapprovedCiphertext},'env-v1',${owner}::uuid),
      (${otherSecret}::uuid,${other}::uuid,'foreign',${foreignCiphertext},'env-v1',${other}::uuid)`;
    yield* sql`INSERT INTO public.gateway_relocation_fence (operation_id,state) VALUES (${operationId}::uuid,'drained')`;

    return { identity, privateEnvelope, ownHash };
  });
}

function sqlAt<A, E>(env: NodeJS.ProcessEnv, use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    SqlClient.SqlClient.use(use).pipe(Effect.provide(databaseLayer(databaseUrl(env), "canopy-projection-fixture"))),
  );
}

test.skipIf(!dockerAvailable || !Bun.which("psql"))(
  "join projection scopes records, redacts envelopes and restricts secret reads to approval",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "canopy-projection-test-"));
    const source = await startPostgres({ migrated: true });
    const runtime = ManagedRuntime.make(source.layer);

    try {
      const runtimeConfig = await runtime.runPromise(PgClient.PgClient.use((client) => Effect.succeed(client.config)));

      const sourceEnv = {
        CANOPY_DATABASE_URL: `postgres://postgres:test@${runtimeConfig.host}:${runtimeConfig.port}/${runtimeConfig.database}`,
        CANOPY_SECRETS_KEY: secretKey.toString("base64"),
      };

      const fixture = await runtime.runPromise(SqlClient.SqlClient.use(seed));
      await runtime.dispose();

      const trialBundle = join(directory, "trial");
      const trial = await exportConsolidationProjection(sourceEnv, trialBundle, { operationId, offline: false });
      const bundle = join(directory, "final");
      const manifest = await exportConsolidationProjection(sourceEnv, bundle, { operationId, offline: true });

      expect(trial.fence).toBeNull();
      expect(manifest.archiveSha256).not.toBe(trial.archiveSha256);
      expect(manifest.source).toMatchObject({ nodeId: fixture.identity.nodeId, ownerUserId: owner });
      expect(await verifyConsolidationProjection(bundle)).toEqual(manifest);

      const archivePath = join(bundle, "database.dump");

      const [archive, manifestFile] = await Promise.all([
        readFile(archivePath, "utf8"),
        readFile(join(bundle, "manifest.json"), "utf8"),
      ]);

      const artifact = archive + manifestFile;
      expect(archive).toContain("Home project fixture");
      expect(archive).toContain("Preserve departure route");
      expect(archive).toContain("/home-workspace-fixture");

      for (const secret of [
        secretKey,
        ownCiphertext,
        unapprovedCiphertext,
        foreignCiphertext,
        fixture.privateEnvelope,
        foreignBlob,
      ])
        expect(artifact).not.toContain(secret.toString("hex"));

      expect(artifact).not.toContain(secretKey.toString("base64"));

      for (const omitted of [
        other,
        "moved bot fixture",
        "Ignore relayed route",
        "peer-only worker metadata",
        "mirror document fixture",
        "derived model cache",
        "derived-checkout-head",
        "/other-workspace-fixture",
        "derived worker report",
        "discard unused config fields",
      ])
        expect(archive).not.toContain(omitted);

      await withTrialDatabase(sourceEnv, operationId, async (stagingEnv) => {
        expect(
          await materializeConsolidationProjection(stagingEnv, bundle, {
            operationId,
            targetDatabaseUrl: databaseUrl(sourceEnv),
          }),
        ).toEqual(manifest);
        await sqlAt(stagingEnv, (sql) =>
          Effect.gen(function* () {
            const secrets = yield* sql<{
              id: string;
              ciphertext: string | null;
            }>`SELECT id,ciphertext FROM public.secrets ORDER BY name`;

            expect(secrets).toEqual([
              { id: ownSecret, ciphertext: null },
              { id: unapprovedSecret, ciphertext: null },
            ]);
            expect(yield* sql`SELECT sha256,octet_length(data) AS bytes FROM public.blobs`).toEqual([
              { sha256: fixture.ownHash, bytes: ownBlob.length },
            ]);
            expect(yield* sql`SELECT manual_tags,report FROM public.worker_environments`).toEqual([
              { manual_tags: ["keep-tag"], report: {} },
            ]);
            expect(yield* sql`SELECT id,email FROM public.users`).toEqual([{ id: owner, email: "dev@localhost" }]);
            expect(yield* sql`SELECT operation_id,state FROM public.gateway_relocation_fence`).toEqual([
              { operation_id: operationId, state: "drained" },
            ]);
            expect(
              yield* sql`SELECT attname FROM pg_attribute WHERE attrelid='public.computer_identity'::regclass AND attname='private_key'`,
            ).toHaveLength(0);
          }),
        );
      });

      const approved = consolidationSecretId("secrets", JSON.stringify([ownSecret]), "ciphertext");
      const foreign = consolidationSecretId("secrets", JSON.stringify([otherSecret]), "ciphertext");
      const approval = { operationId, archiveSha256: manifest.archiveSha256, approvedSecretIds: [approved] };

      await sqlAt(sourceEnv, (sql) => sql`UPDATE public.gateway_relocation_fence SET state='committed'`);
      expect(await loadApprovedConsolidationSecrets(sourceEnv, bundle, approval)).toEqual([
        { id: approved, value: Buffer.from("approved fixture").toString("base64") },
      ]);
      await expect(
        loadApprovedConsolidationSecrets(sourceEnv, bundle, { ...approval, approvedSecretIds: [foreign] }),
      ).rejects.toThrow("missing from the final projection");

      await sqlAt(
        sourceEnv,
        (sql) =>
          sql`UPDATE public.secrets SET ciphertext=${encryptSecret(secretKey, "changed fixture")} WHERE id=${ownSecret}::uuid`,
      );
      await expect(loadApprovedConsolidationSecrets(sourceEnv, bundle, approval)).rejects.toThrow(
        "has changed since review",
      );

      await writeFile(archivePath, archive.replace("Home project fixture", "Fake project fixture"));
      await expect(verifyConsolidationProjection(bundle)).rejects.toThrow("checksum");
      await withTrialDatabase(sourceEnv, operationId, async (stagingEnv) => {
        await expect(
          materializeConsolidationProjection(stagingEnv, bundle, {
            operationId,
            targetDatabaseUrl: databaseUrl(sourceEnv),
          }),
        ).rejects.toThrow("checksum");
        const empty = await sqlAt(stagingEnv, (sql) => sql`SELECT to_regclass('public.users') AS users`);

        expect(empty).toEqual([{ users: null }]);
      });
    } finally {
      await runtime.dispose();
      await source.stop();
      await rm(directory, { force: true, recursive: true });
    }
  },
  60_000,
);
