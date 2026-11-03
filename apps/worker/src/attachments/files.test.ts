import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { InputAttachmentSchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { AttachmentFiles } from "./files.ts";

const dataDir = tempDir("canopy-attachments-");

const THREAD = "0196f0c1-0000-7000-8000-000000000001";
const ID = "0196f0c1-0000-7000-8000-0000000000aa";
const bytes = new TextEncoder().encode("hello attachment");
const sha = createHash("sha256").update(bytes).digest("hex");

describe("attachments on the worker", () => {
  const files = new AttachmentFiles(dataDir);
  const attachment = (overrides: Partial<{ path: string; sha256: string; attachmentId: string; sizeBytes: bigint }> = {}) =>
    create(InputAttachmentSchema, {
      attachmentId: ID,
      sha256: sha,
      sizeBytes: BigInt(bytes.length),
      mimeType: "text/plain",
      name: "notes.txt",
      kind: "file",
      path: join(files.root, THREAD, ID, "notes.txt"),
      ...overrides,
    });

  test("fetched once into <data_dir>/attachments/<thread>/<attachment>/<name>, private to the worker's user", async () => {
    let fetched = 0;
    const fetch = async () => (fetched++, bytes);
    await files.ensure(THREAD, [attachment()], fetch);
    const path = join(dataDir, "attachments", THREAD, ID, "notes.txt");
    expect(readFileSync(path, "utf8")).toBe("hello attachment");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // A redelivered StartTurn finds it in place.
    await files.ensure(THREAD, [attachment()], fetch);
    expect(fetched).toBe(1);
  });

  test("damaged bytes are not written (retryable); a path other than its own is refused (final)", async () => {
    const other = "0196f0c1-0000-7000-8000-0000000000bb";
    const damaged = await files.ensure(THREAD, [attachment({ attachmentId: other, path: join(files.root, THREAD, other, "notes.txt") })], async () => new TextEncoder().encode("tampered")).then(
      () => undefined,
      (e: { final: boolean; message: string }) => e,
    );
    expect(damaged?.final).toBe(false);
    expect(existsSync(join(files.root, THREAD, other))).toBe(false);
    const traversal = await files.ensure(THREAD, [attachment({ path: "/etc/cron.d/x" })], async () => bytes).then(
      () => undefined,
      (e: { final: boolean; message: string }) => e,
    );
    expect(traversal).toMatchObject({ final: true });
    const badId = await files.ensure(THREAD, [attachment({ attachmentId: "../../x" })], async () => bytes).then(
      () => undefined,
      (e: { final: boolean }) => e,
    );
    expect(badId?.final).toBe(true);
  });

  test("the thread's directory exists for Claude's additionalDirectories", () => {
    expect(existsSync(files.threadDir(THREAD))).toBe(true);
    expect(() => files.threadDir("../x")).toThrow();
  });
});
