import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { Schema } from "effect";
import { decryptSecret, loadSecretsKey } from "../store/secrets.ts";
import { DatabaseMigrationError } from "./postgres-tools.ts";
import type { RestoreReceipt } from "./postgres-target.ts";

export interface DatabaseSnapshot {
  postgresMajor: number;
  schemaMigration: number;
  nodeId: string | null;
  certificateSha256: string | null;
  encryptedKeySha256: string | null;
}

const identityMigration = 48;
const ownerMatches = "pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(email, 'UTF8')), 'hex')";

export const inspectScript = String.raw`
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
\encoding UTF8
\getenv owner_hash CANOPY_MIGRATION_OWNER
SELECT current_setting('server_version_num')::int / 10000;
SELECT to_regclass('public.schema_migrations') IS NOT NULL AS has_migrations,
       to_regclass('public.users') IS NOT NULL AS has_users,
       to_regclass('public.computer_identity') IS NOT NULL AS has_identity \gset
\if :has_migrations
  SELECT coalesce(max(migration_id), 0) FROM public.schema_migrations;
\else
  SELECT 0;
\endif
\if :has_users
  SELECT EXISTS (SELECT FROM public.users WHERE ${ownerMatches} = :'owner_hash')::int;
\else
  SELECT 0;
\endif
\if :has_identity
  SELECT json_build_object('nodeId', i.node_id, 'certificate', i.certificate, 'privateKey', encode(i.private_key, 'hex'),
    'sameOwner', EXISTS (SELECT FROM public.users WHERE id = i.owner_user_id AND ${ownerMatches} = :'owner_hash'))
    FROM public.computer_identity i;
\endif
ROLLBACK;
`;

const decodeIdentity = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      nodeId: Schema.String,
      certificate: Schema.String,
      privateKey: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{2})+$/)),
      sameOwner: Schema.Boolean,
    }),
  ),
);

const ownerError = "CANOPY_DEV_USER_EMAIL must select the gateway's existing database owner.";

export function snapshotMetadata(output: string, env: NodeJS.ProcessEnv): DatabaseSnapshot {
  const [major = "", migration = "", owner, ...identities] = output.split("\n");
  const postgresMajor = Number(major);
  const schemaMigration = Number(migration);

  if (
    !/^\d+$/.test(major) ||
    !/^\d+$/.test(migration) ||
    !Number.isSafeInteger(schemaMigration) ||
    identities.length > 1
  )
    throw new DatabaseMigrationError("PostgreSQL returned invalid gateway metadata.");

  if (schemaMigration > 0 && owner !== "1") throw new DatabaseMigrationError(ownerError);

  const [identityJson] = identities;

  if (!identityJson)
    return { postgresMajor, schemaMigration, nodeId: null, certificateSha256: null, encryptedKeySha256: null };

  const identity = readIdentity(identityJson);

  if (!identity.sameOwner) throw new DatabaseMigrationError(ownerError);

  try {
    const certificate = new X509Certificate(identity.certificate);
    const encrypted = Buffer.from(identity.privateKey, "hex");
    const privateKey = createPrivateKey(decryptSecret(loadSecretsKey(env), encrypted));

    const nodeId = createHash("sha256")
      .update(certificate.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex");

    const now = Date.now();

    if (
      nodeId !== identity.nodeId ||
      !certificate.checkPrivateKey(privateKey) ||
      !certificate.verify(certificate.publicKey) ||
      now < Date.parse(certificate.validFrom) ||
      now >= Date.parse(certificate.validTo)
    )
      throw new Error();

    return {
      postgresMajor,
      schemaMigration,
      nodeId,
      certificateSha256: createHash("sha256").update(certificate.raw).digest("hex"),
      encryptedKeySha256: createHash("sha256").update(encrypted).digest("hex"),
    };
  } catch {
    throw new DatabaseMigrationError(
      "Check that CANOPY_SECRETS_KEY matches the database gateway identity and certificate.",
    );
  }
}

function readIdentity(input: string) {
  try {
    return decodeIdentity(input);
  } catch {
    throw new DatabaseMigrationError("PostgreSQL returned an invalid gateway identity.");
  }
}

export function validateSnapshot(snapshot: DatabaseSnapshot) {
  const { postgresMajor, schemaMigration, nodeId, certificateSha256, encryptedKeySha256 } = snapshot;
  const hex = /^[a-f0-9]{64}$/;

  if (
    !Number.isSafeInteger(postgresMajor) ||
    postgresMajor < 10 ||
    postgresMajor > 214748 ||
    !Number.isSafeInteger(schemaMigration) ||
    schemaMigration <= 0 ||
    schemaMigration > 2147483647 ||
    (nodeId === null) !== (certificateSha256 === null) ||
    (nodeId === null) !== (encryptedKeySha256 === null) ||
    (nodeId !== null && (!hex.test(nodeId) || schemaMigration < identityMigration)) ||
    (certificateSha256 !== null && !hex.test(certificateSha256)) ||
    (encryptedKeySha256 !== null && !hex.test(encryptedKeySha256))
  )
    throw new DatabaseMigrationError("The archive's gateway metadata is invalid.");
}

export function restoreChecks(snapshot: DatabaseSnapshot, receipt?: RestoreReceipt) {
  const pin = snapshot.certificateSha256;

  const identity = pin
    ? `
    IF NOT EXISTS (SELECT FROM public.computer_identity i JOIN public.users u ON u.id = i.owner_user_id
      WHERE ${ownerMatches} = current_setting('canopy.migration_owner')
        AND i.node_id = '${snapshot.nodeId}'
        AND encode(sha256(i.private_key), 'hex') = '${snapshot.encryptedKeySha256}'
        AND encode(sha256(decode(regexp_replace(replace(replace(i.certificate, '-----BEGIN CERTIFICATE-----', ''),
          '-----END CERTIFICATE-----', ''), '[[:space:]]', '', 'g'), 'base64')), 'hex') = '${pin}') THEN
      RAISE EXCEPTION USING ERRCODE = 'CNP05';
    END IF;
  `
    : `
    IF EXISTS (SELECT FROM public.computer_identity) THEN RAISE EXCEPTION USING ERRCODE = 'CNP05'; END IF;
  `;

  return `
SET LOCAL search_path = pg_catalog;
SELECT set_config('canopy.migration_owner', :'owner_hash', true);
DO $canopy$
BEGIN
  IF (SELECT coalesce(max(migration_id), 0) FROM public.schema_migrations) <> ${snapshot.schemaMigration} THEN
    RAISE EXCEPTION USING ERRCODE = 'CNP05';
  END IF;
  IF NOT EXISTS (SELECT FROM public.users WHERE ${ownerMatches} = current_setting('canopy.migration_owner')) THEN
    RAISE EXCEPTION USING ERRCODE = 'CNP04';
  END IF;
  ${snapshot.schemaMigration >= identityMigration ? identity : ""}
END $canopy$;
${
  receipt
    ? `DO $relocation$
BEGIN
  IF NOT EXISTS (SELECT FROM public.gateway_relocation_fence
    WHERE operation_id = '${receipt.runId}'::uuid AND state = 'drained') THEN
    RAISE EXCEPTION USING ERRCODE = 'CNP06';
  END IF;
END $relocation$;
INSERT INTO public.gateway_relocation_receipts(run_id, archive_sha256)
  VALUES ('${receipt.runId}'::uuid, '${receipt.archiveSha256}');`
    : ""
}
COMMIT;
`;
}
