import { afterEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { FileRequestSchema } from "@canopy/contracts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../runtime/host-types.ts";
import { deleteThreadFile, readThreadFile, resolveThreadFile, writeThreadFile } from "./thread-files.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "canopy-thread-files-"));
  dirs.push(base);
  const root = join(base, "thread");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, "report.md"), "# Report\n");
  writeFileSync(join(outside, "secret.txt"), "secret");

  return { root, outside };
}

const request = (path: string, roots: string[]) => create(FileRequestSchema, { threadId: "t", path, roots });

const code = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return error instanceof CommandError ? error.code : String(error);
  }

  return "ok";
};

describe("thread files", () => {
  test("only files under the gateway's roots or the worker's own resolve", () => {
    const { root, outside } = fixture();

    expect(resolveThreadFile(request(join(root, "report.md"), [root]), [])).toEndWith("report.md");
    expect(code(() => resolveThreadFile(request(join(outside, "secret.txt"), [root]), []))).toBe("FILE_OUTSIDE_ROOTS");
    expect(code(() => resolveThreadFile(request(join(root, "..", "outside", "secret.txt"), [root]), []))).toBe(
      "FILE_OUTSIDE_ROOTS",
    );
    expect(resolveThreadFile(request(join(outside, "secret.txt"), [root]), [outside])).toEndWith("secret.txt");
    expect(code(() => resolveThreadFile(request("report.md", [root]), []))).toBe("FILE_PATH_INVALID");
    expect(code(() => resolveThreadFile(request(root, [root]), []))).toBe("FILE_NOT_REGULAR");
    expect(code(() => resolveThreadFile(request(join(root, "missing.md"), [root]), []))).toBe("FILE_NOT_FOUND");
  });

  test("a symlink inside the roots cannot reach a file outside them", () => {
    const { root, outside } = fixture();

    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    } catch {
      return; // Creating symlinks needs a privilege on Windows.
    }

    expect(code(() => resolveThreadFile(request(join(root, "link.txt"), [root]), []))).toBe("FILE_OUTSIDE_ROOTS");
  });

  test("writes and deletes only the content the user read", () => {
    const { root } = fixture();
    const path = join(root, "report.md");
    const read = readThreadFile(path, 0);

    expect(new TextDecoder().decode(read.content)).toBe("# Report\n");
    expect(code(() => writeThreadFile(path, new TextEncoder().encode("x"), "stale"))).toBe("FILE_CHANGED");
    expect(code(() => writeThreadFile(path, new TextEncoder().encode("x"), ""))).toBe("FILE_HASH_REQUIRED");

    const saved = writeThreadFile(path, new TextEncoder().encode("# Edited\n"), read.sha256 ?? "");

    expect(readFileSync(path, "utf8")).toBe("# Edited\n");
    expect(code(() => deleteThreadFile(path, read.sha256 ?? ""))).toBe("FILE_CHANGED");
    deleteThreadFile(path, saved.sha256 ?? "");
    expect(existsSync(path)).toBe(false);
  });

  test("binary files send no content and long files come back truncated", () => {
    const { root } = fixture();
    writeFileSync(join(root, "image.bin"), new Uint8Array([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(join(root, "long.txt"), "ąbc".repeat(10));

    const binary = readThreadFile(join(root, "image.bin"), 0);
    const long = readThreadFile(join(root, "long.txt"), 5);

    expect([binary.binary, binary.content?.length]).toEqual([true, 0]);
    expect([long.truncated, long.binary, new TextDecoder().decode(long.content)]).toEqual([true, false, "ąbc"]);
  });
});
