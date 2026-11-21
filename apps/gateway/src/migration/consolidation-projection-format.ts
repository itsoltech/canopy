import { createHash, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { POSTGRES_MAX_MESSAGE_BYTES } from "@canopy/db";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { Schema } from "effect";
import { certificateIdentity } from "../computers/identity.ts";
import { consolidationError } from "./consolidation-types.ts";
import { DatabaseMigrationError } from "./postgres-tools.ts";

const digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const integer = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));

const metadataSchema = Schema.Struct({
  format: Schema.Literal("canopy-consolidation-1"),
  version: Schema.Literal(CANOPY_VERSION),
  operationId: Schema.String.check(Schema.isUUID()),
  database: Schema.Struct({ postgresMajor: integer, schemaMigration: integer }),
  catalogSignature: digest,
  source: Schema.Struct({
    nodeId: digest,
    ownerUserId: Schema.String.check(Schema.isUUID()),
    ownerEmail: Schema.String.check(Schema.isMaxLength(320)),
    name: Schema.String.check(Schema.isMaxLength(100)),
    certificate: Schema.String.check(Schema.isMaxLength(4096)),
  }),
  fence: Schema.NullOr(Schema.Literal("drained")),
});

const manifestSchema = Schema.Struct({
  ...metadataSchema.fields,
  archiveBytes: integer.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  archiveSha256: digest,
});

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(manifestSchema), { onExcessProperty: "error" });

const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      manifest: Schema.String,
      signature: Schema.String.check(Schema.isPattern(/^[a-f0-9]{120,160}$/)),
    }),
  ),
  { onExcessProperty: "error" },
);

const decodeOperationId = Schema.decodeUnknownSync(metadataSchema.fields.operationId);
const fileSignatureDomain = "canopy.gateway-consolidation.manifest.v1\0";
const header = Buffer.from("canopy-consolidation-1\n");
const maxManifestBytes = 8192;

// Leave room for the bind, JSON array and PostgreSQL message framing.
const maxFrameBytes = POSTGRES_MAX_MESSAGE_BYTES - 64 * 1024;

export const projectionArchive = (directory: string) => join(directory, "database.dump");
export const projectionManifest = (directory: string) => join(directory, "manifest.json");

export type ProjectionMetadata = typeof metadataSchema.Type;

export type ProjectionManifest = typeof manifestSchema.Type;

export function projectionOperationId(value: string) {
  return decodeOperationId(value).toLowerCase();
}

export async function projectionOperation<A>(work: () => Promise<A>): Promise<A> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DatabaseMigrationError) throw error;
    throw consolidationError(
      "Could not process the consolidation projection. Check the private files and database configuration.",
    );
  }
}

function archiveHash(metadata: ProjectionMetadata) {
  const { format, version, operationId, database, catalogSignature, source, fence } = metadata;

  return createHash("sha256")
    .update(
      JSON.stringify([
        format,
        version,
        operationId,
        database.postgresMajor,
        database.schemaMigration,
        catalogSignature,
        source.nodeId,
        source.ownerUserId,
        source.ownerEmail,
        source.name,
        source.certificate,
        fence,
      ]),
    )
    .update("\0");
}

export async function projectionWriter(file: FileHandle, metadata: ProjectionMetadata) {
  const hash = archiveHash(metadata).update(header);
  let archiveBytes = header.length;
  await file.writeFile(header);

  return {
    async write(table: string, payload: string) {
      const frame = Buffer.from(table + "\t" + payload + "\n");

      if (frame.length > maxFrameBytes)
        throw consolidationError("A source row exceeds the consolidation transfer limit.");

      await file.writeFile(frame);
      hash.update(frame);
      archiveBytes += frame.length;
    },
    result(): ProjectionManifest {
      return { ...metadata, archiveBytes, archiveSha256: hash.digest("hex") };
    },
  };
}

export function encodeProjectionManifest(manifest: ProjectionManifest, key: KeyObject) {
  const value = JSON.stringify(manifest);
  decodeManifest(value);

  return JSON.stringify({
    manifest: value,
    signature: sign("sha256", Buffer.from(fileSignatureDomain + value), key).toString("hex"),
  });
}

function requirePrivate(info: { mode: number; uid: number }, valid: boolean) {
  if (!valid || (process.getuid !== undefined && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)))
    throw consolidationError("Use a private consolidation directory owned by the current user.");
}

async function openPrivate(path: string, bytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

  try {
    const info = await file.stat();
    requirePrivate(info, info.isFile());

    if (info.size > bytes) throw consolidationError("A consolidation file exceeds its expected size.");

    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function readProjectionManifest(directory: string): Promise<ProjectionManifest> {
  const parent = await lstat(directory);
  requirePrivate(parent, parent.isDirectory());
  const file = await openPrivate(projectionManifest(directory), maxManifestBytes);

  try {
    const buffer = Buffer.alloc(maxManifestBytes + 1);
    const result = await file.read(buffer, 0, buffer.length, 0);

    if (result.bytesRead > maxManifestBytes) throw consolidationError("The consolidation manifest is too large.");

    const envelope = decodeEnvelope(buffer.subarray(0, result.bytesRead).toString("utf8"));
    const manifest = decodeManifest(envelope.manifest);
    const { certificate, nodeId } = manifest.source;
    const cert = new X509Certificate(certificate);

    if (
      certificateIdentity(certificate).nodeId !== nodeId ||
      !verify(
        "sha256",
        Buffer.from(fileSignatureDomain + envelope.manifest),
        cert.publicKey,
        Buffer.from(envelope.signature, "hex"),
      )
    )
      throw consolidationError("The consolidation manifest does not match its source computer identity.");

    return manifest;
  } finally {
    await file.close();
  }
}

export interface ProjectionFrame {
  table: string;
  payload: string;
  bytes: number;
}

async function* frames(chunks: AsyncIterable<Buffer>): AsyncGenerator<ProjectionFrame> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let parts: Buffer[] = [];
  let bytes = 0;
  let sawHeader = false;

  for await (const chunk of chunks) {
    let offset = 0;

    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, end === -1 ? chunk.length : end);
      offset += part.length + (end === -1 ? 0 : 1);
      bytes += part.length;

      if (bytes >= maxFrameBytes) throw consolidationError("A consolidation row exceeds the transfer limit.");

      if (end === -1) {
        parts.push(part);
        continue;
      }

      const frame = parts.length ? Buffer.concat([...parts, part], bytes) : part;

      if (!sawHeader) {
        if (!frame.equals(header.subarray(0, -1)))
          throw consolidationError("The consolidation data format is invalid.");
        sawHeader = true;
      } else {
        const tableEnd = frame.indexOf(9);

        if (tableEnd < 1 || tableEnd > 63 || frame[tableEnd + 1] !== 123)
          throw consolidationError("A consolidation row has an invalid envelope.");

        yield {
          table: decoder.decode(frame.subarray(0, tableEnd)),
          payload: decoder.decode(frame.subarray(tableEnd + 1)),
          bytes,
        };
      }

      parts = [];
      bytes = 0;
    }
  }

  if (bytes || !sawHeader) throw consolidationError("The consolidation archive ended before its last record.");
}

export const projectionSecretsTable = "consolidation_export_secrets";
export const projectionBlockersTable = "consolidation_export_blockers";

async function* projectionChunks(directory: string, manifest: ProjectionManifest): AsyncGenerator<Buffer> {
  const file = await openPrivate(projectionArchive(directory), manifest.archiveBytes);
  const stream = file.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 });
  const checksum = archiveHash(manifest);
  let bytes = 0;

  try {
    for await (const chunk of stream) {
      bytes += chunk.length;

      if (bytes > manifest.archiveBytes)
        throw consolidationError("The consolidation archive exceeds its expected size.");

      checksum.update(chunk);
      yield Buffer.from(chunk);
    }

    if (bytes !== manifest.archiveBytes || checksum.digest("hex") !== manifest.archiveSha256)
      throw consolidationError("The consolidation archive checksum does not match.");
  } finally {
    stream.destroy();
    await file.close();
  }
}

export function projectionFrames(directory: string, manifest: ProjectionManifest) {
  return frames(projectionChunks(directory, manifest));
}

export async function checkProjectionArchive(directory: string, manifest: ProjectionManifest) {
  const chunks = projectionChunks(directory, manifest);

  try {
    while (!(await chunks.next()).done) {
      // Verification only needs the byte stream.
    }
  } finally {
    await chunks.return(undefined);
  }
}
