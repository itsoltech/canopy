import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ExportThreadImageSchema } from "@canopy/contracts";
import { pinImageRoot } from "./export-root.ts";
import { ThreadImageExports } from "./exports.ts";

/**
 * Release smoke for the native calls show_images makes (bun:ffi), on its own runner: open this binary through its
 * pinned directory (open, stat, read, path, close), then export a multi-chunk file end to end.
 */
export async function imageExportSelfCheck(): Promise<string | undefined> {
  try {
    return pinnedBinaryFailure() ?? (await exportFailure());
  } catch (error) {
    return `image export failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function pinnedBinaryFailure(): string | undefined {
  const binary = realpathSync(process.execPath);
  const file = pinImageRoot(dirname(binary)).open([basename(binary)]);

  try {
    const actual = file.path();
    const same = process.platform === "win32" ? actual.toLowerCase() === binary.toLowerCase() : actual === binary;

    if (!same) return `image export resolved ${JSON.stringify(actual)}, expected ${JSON.stringify(binary)}`;
    const stat = file.stat();

    if (!stat.regular || stat.size !== statSync(binary).size) return "image export read the wrong file metadata";
    const pinned = Buffer.alloc(4096);
    const expected = Buffer.alloc(4096);
    const fd = openSync(binary, "r");

    try {
      readSync(fd, expected, 0, expected.length, 1024);
    } finally {
      closeSync(fd);
    }

    return file.read(pinned, 0, pinned.length, 1024) === pinned.length && pinned.equals(expected)
      ? undefined
      : "image export read the wrong bytes";
  } finally {
    file.close();
  }
}

async function exportFailure(): Promise<string | undefined> {
  const base = mkdtempSync(join(tmpdir(), "canopy-self-check-"));
  const exports = new ThreadImageExports();

  try {
    const [cwd, attachments] = [join(base, "repo"), join(base, "attachments")];
    mkdirSync(cwd);
    mkdirSync(attachments);
    // Larger than one chunk, so the snapshot reads at a non-zero position.
    const bytes = randomBytes(300 * 1024);
    writeFileSync(join(cwd, "screen.png"), bytes);
    const threadId = randomUUID();
    exports.assign(threadId, cwd, attachments);

    const request = (operation: string, offset = 0n) =>
      exports.execute(
        create(ExportThreadImageSchema, {
          threadId,
          turnId: "self-check",
          exportId: "00000000-0000-4000-8000-000000000000",
          path: "screen.png",
          roots: [cwd],
          operation,
          offset,
          maxBytes: BigInt(bytes.length),
        }),
        { cwd, attachments, running: true },
      );

    const probe = await request("probe");
    const read = await request("read");
    await request("release");

    const same =
      probe.sizeBytes === BigInt(bytes.length) && read.sha256 === createHash("sha256").update(bytes).digest("hex");

    return same ? undefined : "image export returned the wrong file";
  } finally {
    exports.close();
    rmSync(base, { recursive: true, force: true });
  }
}
