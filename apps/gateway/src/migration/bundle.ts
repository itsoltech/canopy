import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { Schema } from "effect";
import { loadSecretsKey } from "../store/secrets.ts";
import {
  dumpDatabase,
  inspectDatabase,
  readRestoreReceipt,
  requireOfflineSource,
  restoreDatabase,
  type DatabaseSnapshot,
} from "./postgres.ts";

const ARCHIVE = "database.dump";
const MANIFEST = "manifest.json";
const hexDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const positiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

const snapshotSchema = Schema.Struct({
  postgresMajor: positiveInteger,
  schemaMigration: positiveInteger,
  nodeId: Schema.NullOr(hexDigest),
  certificateSha256: Schema.NullOr(hexDigest),
  encryptedKeySha256: Schema.NullOr(hexDigest),
});

const manifestSchema = Schema.Struct({
  format: Schema.Literal(1),
  version: Schema.String.check(Schema.isMaxLength(100)),
  database: snapshotSchema,
  ownerBinding: hexDigest,
  archiveBytes: positiveInteger,
  archiveSha256: hexDigest,
});

const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ manifest: Schema.String, signature: hexDigest })),
  { onExcessProperty: "error" },
);

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(manifestSchema), { onExcessProperty: "error" });

type MigrationManifest = typeof manifestSchema.Type;

export class MigrationBundleError extends Error {}

function key(env: NodeJS.ProcessEnv) {
  try {
    return loadSecretsKey(env);
  } catch {
    throw new MigrationBundleError("Set CANOPY_SECRETS_KEY to the existing gateway's 32-byte base64 key.");
  }
}

function signature(manifest: string, secret: Buffer) {
  return createHmac("sha256", secret).update("canopy.gateway-migration.manifest.v1\0").update(manifest).digest();
}

function ownerBinding(env: NodeJS.ProcessEnv, secret: Buffer) {
  return createHmac("sha256", secret)
    .update("canopy.gateway-migration.owner.v1\0")
    .update(env["CANOPY_DEV_USER_EMAIL"] ?? "dev@localhost")
    .digest("hex");
}

async function digest(path: string) {
  const hash = createHash("sha256");
  let bytes = 0;

  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }

  return { archiveBytes: bytes, archiveSha256: hash.digest("hex") };
}

function isPrivate(stat: { mode: number; uid: number }) {
  return process.getuid === undefined || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
}

async function sync(path: string) {
  const handle = await open(path, "r");

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameSnapshot(source: DatabaseSnapshot, target: DatabaseSnapshot) {
  return (
    source.postgresMajor === target.postgresMajor &&
    source.schemaMigration === target.schemaMigration &&
    source.nodeId === target.nodeId &&
    source.certificateSha256 === target.certificateSha256 &&
    source.encryptedKeySha256 === target.encryptedKeySha256
  );
}

async function buildBundle(
  env: NodeJS.ProcessEnv,
  directory: string,
  secret: Buffer,
  before: DatabaseSnapshot,
  offline: boolean,
): Promise<MigrationManifest> {
  const archive = join(directory, ARCHIVE);
  // Publish the manifest last, so an incomplete export is never seen as a complete bundle.
  await writeFile(archive, "", { flag: "wx", mode: 0o600 });
  await dumpDatabase(env, archive);
  await chmod(archive, 0o600);

  if (offline) await requireOfflineSource(env);

  const database = await inspectDatabase(env);

  if (!sameSnapshot(before, database))
    throw new MigrationBundleError(
      "The source schema or gateway identity changed during export. Export to a new directory.",
    );

  const manifest = {
    format: 1,
    version: CANOPY_VERSION,
    database,
    ownerBinding: ownerBinding(env, secret),
    ...(await digest(archive)),
  } satisfies MigrationManifest;

  const payload = JSON.stringify(manifest);
  const temporary = join(directory, `${MANIFEST}.partial`);
  await sync(archive);
  await writeFile(
    temporary,
    JSON.stringify({ manifest: payload, signature: signature(payload, secret).toString("hex") }),
    {
      flag: "wx",
      mode: 0o600,
      flush: true,
    },
  );
  await rename(temporary, join(directory, MANIFEST));

  if (process.platform !== "win32") {
    await sync(directory);
    await sync(dirname(directory));
  }

  return manifest;
}

export async function exportBundle(
  env: NodeJS.ProcessEnv,
  directory: string,
  offline = false,
): Promise<MigrationManifest> {
  const secret = key(env);

  if (offline) await requireOfflineSource(env);

  const before = await inspectDatabase(env);

  if (before.schemaMigration <= 0) throw new MigrationBundleError("Select an initialized Canopy database to export.");

  await mkdir(directory, { mode: 0o700 });

  try {
    return await buildBundle(env, directory, secret, before, offline);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function readManifest(env: NodeJS.ProcessEnv, directory: string) {
  const secret = key(env);
  const archive = join(directory, ARCHIVE);
  const manifestFile = join(directory, MANIFEST);
  const [root, manifestStat, archiveStat] = await Promise.all([lstat(directory), lstat(manifestFile), lstat(archive)]);

  if (
    !root.isDirectory() ||
    !manifestStat.isFile() ||
    !archiveStat.isFile() ||
    ![root, manifestStat, archiveStat].every(isPrivate) ||
    manifestStat.size > 8192
  )
    throw new MigrationBundleError("Use a private bundle directory with regular files owned by the current user.");

  const envelope = decodeEnvelope(await readFile(manifestFile, "utf8"));

  if (!timingSafeEqual(Buffer.from(envelope.signature, "hex"), signature(envelope.manifest, secret)))
    throw new MigrationBundleError("Bundle authentication failed. Check the bundle and the source gateway key.");

  const manifest = decodeManifest(envelope.manifest);

  if (manifest.version !== CANOPY_VERSION)
    throw new MigrationBundleError("Use the same Canopy release to export and import the gateway.");

  if (manifest.ownerBinding !== ownerBinding(env, secret))
    throw new MigrationBundleError("Use the source gateway's CANOPY_DEV_USER_EMAIL for this operation.");

  if (archiveStat.size !== manifest.archiveBytes)
    throw new MigrationBundleError("The archive size does not match the manifest.");

  return { manifest, archive };
}

async function checkArchive(archive: string, manifest: MigrationManifest) {
  const actual = await digest(archive);

  if (actual.archiveBytes !== manifest.archiveBytes || actual.archiveSha256 !== manifest.archiveSha256)
    throw new MigrationBundleError("The archive digest does not match the manifest.");
}

export async function verifyBundle(env: NodeJS.ProcessEnv, directory: string): Promise<MigrationManifest> {
  const { manifest, archive } = await readManifest(env, directory);
  await checkArchive(archive, manifest);

  return manifest;
}

export async function importBundle(
  env: NodeJS.ProcessEnv,
  directory: string,
  operation?: { runId?: string; stagingDirectory?: string },
): Promise<MigrationManifest> {
  const { manifest, archive } = await readManifest(env, directory);

  const staging = await mkdtemp(
    join(operation?.stagingDirectory ?? env["TMPDIR"] ?? tmpdir(), "canopy-migration-import-"),
  );

  const stagedArchive = join(staging, ARCHIVE);

  try {
    // Restore from the same private copy that was checked, even if the supplied directory changes.
    await copyFile(archive, stagedArchive, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(stagedArchive, 0o600);
    await checkArchive(stagedArchive, manifest);

    const receipt = operation?.runId ? { runId: operation.runId, archiveSha256: manifest.archiveSha256 } : undefined;

    if (receipt) {
      const existing = await readRestoreReceipt(env, receipt.runId);

      if (existing?.archiveSha256 === receipt.archiveSha256) return manifest;

      if (existing) throw new MigrationBundleError("A different archive was already restored for this migration.");
    }

    try {
      await restoreDatabase(env, stagedArchive, manifest.database, receipt);
    } catch (error) {
      if (!receipt) throw error;
      const committed = await readRestoreReceipt(env, receipt.runId).catch(() => undefined);

      if (committed?.archiveSha256 !== receipt.archiveSha256) throw error;
    }

    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {
      console.warn("Could not remove the private import copy in the temporary directory.");
    });
  }
}
