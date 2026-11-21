import { createReadStream } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { Schema } from "effect";
import { CutoverError, requireStorageSpace } from "./cutover-files.ts";

export const cutoverRunId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);

export const cutoverDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const byteCount = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

const milliseconds = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const postgresMajor = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 10, maximum: 214748 }));
const base = { version: Schema.Literal(1), runId: cutoverRunId };

const bundleSize = {
  manifestBytes: byteCount.check(Schema.isLessThanOrEqualTo(8192)),
  archiveBytes: byteCount,
};

export const cutoverKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/));

const bundle = {
  ...bundleSize,
  key: cutoverKey,
};

export const desktopDeviceSchema = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  tokenHash: cutoverDigest,
  name: Schema.String.check(
    Schema.isMaxLength(100),
    Schema.makeFilter((name) => name.length > 0 && name === name.trim() && !/[\p{Cc}]/u.test(name)),
  ),
  platform: Schema.Literals(["darwin", "linux", "win32"]),
});

export type DesktopCutoverDevice = typeof desktopDeviceSchema.Type;

export const cutoverRoutesSchema = Schema.Struct({
  fingerprint: cutoverDigest,
  addresses: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});

export type CutoverRoutes = typeof cutoverRoutesSchema.Type;

const approval = Schema.Struct({
  reviewDigest: cutoverDigest,
  conflictChoices: Schema.Record(Schema.String, Schema.Literals(["source", "target"])),
  approvedSecretIds: Schema.Array(Schema.String),
});

const requestSchema = Schema.Union([
  Schema.Struct({ ...base, action: Schema.Literal("prepare"), postgresMajor, databaseBytes: byteCount }),
  Schema.Struct({ ...base, ...bundle, action: Schema.Literals(["trial", "import"]) }),
  Schema.Struct({
    ...base,
    action: Schema.Literal("activate"),
    archiveSha256: cutoverDigest,
    desktopDevice: Schema.optional(desktopDeviceSchema),
  }),
  Schema.Struct({ ...base, action: Schema.Literals(["status", "abort"]) }),
  Schema.Struct({
    ...base,
    ...bundleSize,
    action: Schema.Literal("join-prepare"),
  }),
  Schema.Struct({
    ...base,
    action: Schema.Literal("join-import"),
    archiveSha256: cutoverDigest,
    approval,
    desktopDevice: Schema.optional(desktopDeviceSchema),
    secretBytes: byteCount.check(Schema.isLessThanOrEqualTo(16 * 1024 * 1024)),
  }),
  Schema.Struct({
    ...base,
    action: Schema.Literal("join-review"),
    archiveSha256: cutoverDigest,
    desktopDevice: Schema.optional(desktopDeviceSchema),
  }),
  Schema.Struct({ ...base, action: Schema.Literals(["join-status", "join-abort"]) }),
]);

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(requestSchema), { onExcessProperty: "error" });

export type CutoverRequest = typeof requestSchema.Type;

export type BundleRequest = Extract<CutoverRequest, { manifestBytes: number }>;

export type JoinRequest = Extract<CutoverRequest, { action: `join-${string}` }>;

export type MoveRequest = Exclude<CutoverRequest, JoinRequest>;

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

export const trialProofSchema = Schema.Struct({
  archiveSha256: cutoverDigest,
  postgresMajor,
  schemaMigration: byteCount,
  nodeId: Schema.NullOr(cutoverDigest),
  certificateSha256: Schema.NullOr(cutoverDigest),
  receiveMs: milliseconds,
  restoreMs: milliseconds,
  verifyMs: milliseconds,
  sample: Schema.Struct({ threads: count, workers: count, devices: count, attachments: count }),
});

export const targetStateSchema = Schema.Struct({
  ...base,
  phase: Schema.Literals(["absent", "prepared", "trialed", "restored", "activating", "active", "aborted"]),
  trial: Schema.optional(trialProofSchema),
  routes: Schema.optional(cutoverRoutesSchema),
  archiveSha256: Schema.optional(cutoverDigest),
});

export type CutoverTargetState = typeof targetStateSchema.Type;

export const decodeTargetState = Schema.decodeUnknownSync(Schema.fromJsonString(targetStateSchema), {
  onExcessProperty: "error",
});

const MANIFEST = "manifest.json";
const ARCHIVE = "database.dump";
const headerLimit = 1024 * 1024;

export class CutoverInput {
  #input: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array = new Uint8Array(0);
  #decode = new TextDecoder("utf-8", { fatal: true });

  constructor(input: ReadableStream<Uint8Array>) {
    this.#input = input.getReader();
  }

  async #next() {
    while (this.#buffer.length === 0) {
      const { value, done } = await this.#input.read();

      if (done) return false;
      this.#buffer = value;
    }

    return true;
  }

  #take(bytes: number) {
    const chunk = this.#buffer.subarray(0, bytes);
    this.#buffer = this.#buffer.subarray(bytes);

    return chunk;
  }

  async request(): Promise<CutoverRequest> {
    const parts: Uint8Array[] = [];
    let bytes = 0;

    while (await this.#next()) {
      const lineEnd = this.#buffer.indexOf(10);
      const chunk = this.#take(lineEnd < 0 ? this.#buffer.length : lineEnd);
      bytes += chunk.length;

      if (bytes > headerLimit) break;
      parts.push(chunk);

      if (lineEnd >= 0) {
        this.#take(1);

        return this.#decodeRequest(parts, bytes);
      }
    }

    throw new CutoverError("The SSH cutover request header is incomplete or too large.");
  }

  #decodeRequest(parts: Uint8Array[], bytes: number) {
    try {
      const request = decodeRequest(this.#decode.decode(Buffer.concat(parts, bytes)));

      if (bytes > 8192 && request.action !== "join-import") throw new Error();

      return request;
    } catch {
      throw new CutoverError("The SSH cutover request has an invalid format or protocol version.");
    }
  }

  async end() {
    if (await this.#next()) throw new CutoverError("The SSH cutover request contains trailing data.");
  }

  async secretPayload(size: number): Promise<string> {
    const parts: Uint8Array[] = [];
    let remaining = size;

    while (remaining > 0) {
      if (!(await this.#next())) throw new CutoverError("The approved secrets transfer ended early.");
      const chunk = this.#take(Math.min(remaining, this.#buffer.length));
      parts.push(chunk);
      remaining -= chunk.length;
    }

    await this.end();

    try {
      return this.#decode.decode(Buffer.concat(parts, size));
    } catch {
      throw new CutoverError("The approved secrets transfer has an invalid encoding.");
    }
  }

  async #write(path: string, size: number) {
    const handle = await open(path, "wx", 0o600);

    try {
      let remaining = size;

      while (remaining > 0) {
        if (!(await this.#next())) throw new CutoverError("The SSH bundle transfer ended early.");
        const chunk = this.#take(Math.min(remaining, this.#buffer.length));
        await handle.writeFile(chunk);
        remaining -= chunk.length;
      }

      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async receiveBundle(directory: string, request: BundleRequest) {
    await requireStorageSpace(dirname(directory), BigInt(request.archiveBytes) * 2n + BigInt(request.manifestBytes));
    await mkdir(directory, { mode: 0o700 });
    await this.#write(join(directory, MANIFEST), request.manifestBytes);
    await this.#write(join(directory, ARCHIVE), request.archiveBytes);
    await this.end();
  }
}

export async function* bundleRequest(action: "trial" | "import", runId: string, directory: string, key: string) {
  const files = [join(directory, MANIFEST), join(directory, ARCHIVE)];
  const [manifest, archive] = await Promise.all([lstat(join(directory, MANIFEST)), lstat(join(directory, ARCHIVE))]);

  const request = decodeRequest(
    JSON.stringify({
      version: 1,
      action,
      runId,
      key,
      manifestBytes: manifest.size,
      archiveBytes: archive.size,
    }),
  );

  yield Buffer.from(JSON.stringify(request) + "\n", "utf8");

  for (const path of files) yield* createReadStream(path);
}
