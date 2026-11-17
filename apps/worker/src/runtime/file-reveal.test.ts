import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { create } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { ManagedRuntime } from "effect";
import { Journal } from "../journal/index.ts";
import { WorkerHost } from "./host.ts";

describe("thread file reveal command security", () => {
  const dir = tempDir("canopy-file-reveal-worker-");
  const workspace = join(dir, "workspace");
  const outside = join(dir, "outside.txt");
  const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
  let host: WorkerHost;
  const threadId = Bun.randomUUIDv7();

  const reveal = (path: string, commandId = Bun.randomUUIDv7(), preferredPaths: string[] = []) =>
    host.handleCommand(
      create(CommandSchema, {
        commandId,
        kind: { case: "revealFile", value: { threadId, path, roots: [workspace], workspace, preferredPaths } },
      }),
    );

  beforeAll(() => {
    mkdirSync(workspace);
    writeFileSync(outside, "outside");
    host = new WorkerHost({ runtime, dataDir: dir, clientVersion: "test" });
  });

  afterAll(async () => {
    await host?.close();
    await runtime.dispose();
  });

  test("rejects directories, missing files and paths outside the thread before launching", async () => {
    for (const [path, errorCode] of [
      [workspace, "FILE_NOT_REGULAR"],
      [join(workspace, "missing.txt"), "FILE_NOT_RESOLVED"],
      [outside, "FILE_OUTSIDE_ROOTS"],
      ["relative.txt", "FILE_NOT_RESOLVED"],
    ])
      expect(await reveal(path!)).toMatchObject({ ok: false, errorCode });
  });

  test("a bare name with several matches never launches an arbitrary file", async () => {
    for (const folder of ["one", "two"]) {
      mkdirSync(join(workspace, folder));
      writeFileSync(join(workspace, folder, "duplicate.txt"), folder);
    }

    expect(await reveal("duplicate.txt")).toMatchObject({ ok: false, errorCode: "FILE_NOT_RESOLVED" });
  });

  test.skipIf(process.platform === "win32")("rejects a symlink escape and another thread's attachments", async () => {
    const link = join(workspace, "escape.txt");
    symlinkSync(outside, link);
    expect(await reveal(link)).toMatchObject({ ok: false, errorCode: "FILE_OUTSIDE_ROOTS" });
    const foreign = join(host.attachmentsRoot, Bun.randomUUIDv7());
    mkdirSync(foreign, { recursive: true });
    const file = join(foreign, "private.txt");
    writeFileSync(file, "other thread");
    expect(await reveal(file)).toMatchObject({ ok: false, errorCode: "FILE_OUTSIDE_ROOTS" });
  });

  test.skipIf(process.platform !== "linux")(
    "selects via safe argv, supports own attachments and falls back to the folder",
    async () => {
      const bin = join(dir, "bin");
      const capture = join(dir, "argv.jsonl");
      mkdirSync(bin);

      const program = (name: string, status = 0) => {
        const path = join(bin, name);
        writeFileSync(
          path,
          `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\n` +
            `appendFileSync(${JSON.stringify(capture)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + "\\n");\n` +
            `process.exit(${status});\n`,
        );
        chmodSync(path, 0o755);
      };

      program("gdbus");
      program("xdg-open");
      const name = "report 'quoted' ; $(touch injected) ü.txt";
      const path = join(workspace, name);
      writeFileSync(path, "regular file");
      const own = join(host.attachmentsRoot, threadId);
      mkdirSync(own, { recursive: true });
      const attachment = join(own, "attachment.txt");
      writeFileSync(attachment, "attachment");

      for (const folder of ["preferred-one", "preferred-two"]) {
        mkdirSync(join(workspace, folder));
        writeFileSync(join(workspace, folder, "hinted.txt"), folder);
      }

      const previousPath = process.env["PATH"];
      process.env["PATH"] = `${bin}:${previousPath ?? ""}`;
      const commandId = Bun.randomUUIDv7();

      try {
        expect(await reveal(path, commandId)).toMatchObject({ ok: true });
        expect(await reveal(attachment)).toMatchObject({ ok: true });
        expect(await reveal("hinted.txt", Bun.randomUUIDv7(), ["preferred-two/hinted.txt"])).toMatchObject({
          ok: true,
        });
        program("gdbus", 1);
        expect(await reveal(path)).toMatchObject({ ok: true });
      } finally {
        if (previousPath === undefined) delete process.env["PATH"];
        else process.env["PATH"] = previousPath;
      }

      const lines = readFileSync(capture, "utf8").trim().split("\n");
      const argv = JSON.parse(lines[0]!);
      expect(argv).toEqual([
        "gdbus",
        "call",
        "--session",
        "--dest",
        "org.freedesktop.FileManager1",
        "--object-path",
        "/org/freedesktop/FileManager1",
        "--method",
        "org.freedesktop.FileManager1.ShowItems",
        JSON.stringify([pathToFileURL(path).href]),
        "",
      ]);
      expect(JSON.parse(lines[1]!)).toContain(JSON.stringify([pathToFileURL(attachment).href]));
      expect(JSON.parse(lines[2]!)).toContain(
        JSON.stringify([pathToFileURL(join(workspace, "preferred-two/hinted.txt")).href]),
      );
      expect(JSON.parse(lines[4]!)).toEqual(["xdg-open", workspace]);
      expect(existsSync(join(workspace, "injected"))).toBe(false);
      expect(await runtime.runPromise(Journal.use((j) => j.commandResult(commandId)))).toBeUndefined();
    },
  );
});
