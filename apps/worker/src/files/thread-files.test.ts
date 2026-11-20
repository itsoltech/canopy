import { afterEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { FileRequestSchema } from "@canopy/contracts";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError } from "../runtime/host-types.ts";
import { openFileMutation } from "./file-mutation-open.ts";
import { deleteThreadFile, readThreadFile, resolveThreadFile, writeThreadFile } from "./thread-files.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "canopy-thread-files-")));
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
    expect(code(() => writeThreadFile(path, new TextEncoder().encode("x"), "stale", [root]))).toBe("FILE_CHANGED");
    expect(code(() => writeThreadFile(path, new TextEncoder().encode("x"), "", [root]))).toBe("FILE_HASH_REQUIRED");

    const saved = writeThreadFile(path, new TextEncoder().encode("# Edited\n"), read.sha256 ?? "", [root]);

    expect(readFileSync(path, "utf8")).toBe("# Edited\n");
    expect(code(() => deleteThreadFile(path, read.sha256 ?? "", [root]))).toBe("FILE_CHANGED");
    deleteThreadFile(path, saved.sha256 ?? "", [root]);
    expect(existsSync(path)).toBe(false);
  });

  test("normal edits keep working in nested folders and for several files at once", () => {
    const { root } = fixture();
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    const names = ["a.ts", "b.ts", "c.ts"].map((name) => join(root, "src", "deep", name));

    for (const name of names) writeFileSync(name, "one\n");

    const results = names.map((name) => {
      const read = readThreadFile(name, 0);

      return writeThreadFile(name, new TextEncoder().encode("two\n"), read.sha256 ?? "", [root]);
    });

    for (const [index, name] of names.entries()) {
      expect(readFileSync(name, "utf8")).toBe("two\n");
      expect(results[index]?.size).toBe(4n);
    }

    // A shorter edit truncates; a longer one extends.
    const first = names[0]!;
    writeThreadFile(first, new TextEncoder().encode("2\n"), results[0]?.sha256 ?? "", [root]);
    expect(readFileSync(first, "utf8")).toBe("2\n");
  });

  test("a file with other hard links is refused instead of changing the other name", () => {
    const { root, outside } = fixture();
    const linked = join(root, "linked.md");

    try {
      linkSync(join(outside, "secret.txt"), linked);
    } catch {
      return; // Some volumes do not support hard links.
    }

    const read = readThreadFile(linked, 0);

    expect(code(() => writeThreadFile(linked, new TextEncoder().encode("x"), read.sha256 ?? "", [root]))).toBe(
      "FILE_CHANGED",
    );
    expect(code(() => deleteThreadFile(linked, read.sha256 ?? "", [root]))).toBe("FILE_CHANGED");
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret");
  });

  test("a pinned file notices it was moved or replaced before the change", () => {
    const { root } = fixture();
    const path = join(root, "report.md");
    const file = openFileMutation(path, true, [root]);

    try {
      file.verify();
      renameSync(path, join(root, "moved.md"));
    } catch {
      file.close();

      return; // Windows refuses to move an open file; either outcome keeps the change on the checked file.
    }

    try {
      expect(() => file.verify()).toThrow();
      expect(() => file.write(new TextEncoder().encode("x"))).toThrow();
      expect(readFileSync(join(root, "moved.md"), "utf8")).toBe("# Report\n");
    } finally {
      file.close();
    }
  });

  test("an authorised path is never re-resolved through a link or accepted outside the roots", () => {
    const { root, outside } = fixture();
    const secret = join(outside, "secret.txt");
    const hash = readThreadFile(secret, 0).sha256 ?? "";
    const content = new TextEncoder().encode("x");

    expect(code(() => writeThreadFile(secret, content, hash, [root]))).toBe("FILE_CHANGED");
    expect(code(() => deleteThreadFile(secret, hash, [root]))).toBe("FILE_CHANGED");

    try {
      symlinkSync(outside, join(root, "dir-link"), "dir");
      symlinkSync(secret, join(root, "file-link.txt"));
    } catch {
      return; // Creating symlinks needs a privilege on Windows.
    }

    expect(code(() => writeThreadFile(join(root, "dir-link", "secret.txt"), content, hash, [root]))).toBe(
      "FILE_CHANGED",
    );
    expect(code(() => writeThreadFile(join(root, "file-link.txt"), content, hash, [root]))).toBe("FILE_CHANGED");
    expect(code(() => deleteThreadFile(join(root, "file-link.txt"), hash, [root]))).toBe("FILE_CHANGED");
    expect(readFileSync(secret, "utf8")).toBe("secret");
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
