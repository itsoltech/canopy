import { expect, test } from "bun:test";
import { linkSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ExportThreadImageSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { windowsLocalTempRoot } from "./export-local-temp.ts";
import { ThreadImageExports } from "./exports.ts";

const temp = tempDirs();

test("selects the default Windows Temp within the profile and rejects shared, network and traversal roots", () => {
  const profile = "C:\\Users\\Example";
  const local = `${profile}\\AppData\\Local`;

  expect(windowsLocalTempRoot(local, profile)).toBe(`${local}\\Temp`);

  for (const path of [
    undefined,
    "C:\\Windows",
    "C:\\Users\\Public",
    "C:\\Users\\Example-other\\AppData\\Local",
    "\\\\host\\share\\AppData",
    "\\Users\\Example\\AppData\\Local",
    `${profile}\\Local\\.. \\private`,
    `${local}:stream`,
    "D:\\AppData\\Local",
    profile,
  ])
    expect(windowsLocalTempRoot(path, profile)).toBeUndefined();
  expect(windowsLocalTempRoot(local, "C:\\")).toBeUndefined();
});

test("Temp exports require a worker-selected pinned root and an explicit active-turn request", async () => {
  const root = realpathSync(temp("canopy-image-local-temp-"));
  const cwd = join(root, "repo");
  const attachments = join(root, "attachments");
  const localTemp = join(root, "Temp");
  const shared = join(root, "Temp-other");
  const sharedImage = join(shared, "screen.png");
  const tempImage = join(localTemp, "screen.png");
  const junction = process.platform === "win32" ? "junction" : "dir";
  const bytes = Buffer.from("external screenshot");

  for (const dir of [cwd, attachments, shared]) mkdirSync(dir);
  writeFileSync(join(cwd, "screen.png"), bytes);
  writeFileSync(sharedImage, bytes);
  symlinkSync(shared, localTemp, junction);

  const exports = new ThreadImageExports(undefined, localTemp);
  const remoteExports = new ThreadImageExports();
  const scope = { cwd, attachments, running: true };

  const request = (path: string, allowLocalTemp = true) =>
    create(ExportThreadImageSchema, {
      threadId: "thread",
      turnId: "turn",
      exportId: crypto.randomUUID(),
      path,
      allowLocalTemp,
      roots: [cwd],
      operation: "probe",
      maxBytes: 1024n,
    });

  exports.assign("thread", cwd, attachments);
  remoteExports.assign("thread", cwd, attachments);

  const outside = "outside this thread's directory";

  try {
    // A pre-existing redirect cannot be pinned as Temp, and it has no effect on an ordinary workspace export.
    await expect(exports.execute(request(tempImage), scope)).rejects.toThrow("directory changed");
    const workspace = request("screen.png");
    expect((await exports.execute(workspace, scope)).sizeBytes).toBe(BigInt(bytes.length));
    exports.release(workspace.exportId);
    rmSync(localTemp);
    mkdirSync(localTemp);
    writeFileSync(tempImage, bytes);
    symlinkSync(shared, join(localTemp, "junction"), junction);
    linkSync(sharedImage, join(localTemp, "hardlink.png"));

    await expect(exports.execute(request(tempImage, false), scope)).rejects.toThrow(outside);
    await expect(remoteExports.execute(request(tempImage), scope)).rejects.toThrow(outside);
    await expect(exports.execute({ ...request(tempImage), roots: [cwd, localTemp] }, scope)).rejects.toThrow(outside);
    await expect(exports.execute(request(sharedImage), scope)).rejects.toThrow(outside);
    await expect(exports.execute(request(tempImage), { ...scope, running: false })).rejects.toThrow("ended");
    await expect(exports.execute({ ...request(tempImage), maxBytes: 1n }, scope)).rejects.toThrow(
      "remaining image limit",
    );

    for (const path of [
      join(localTemp, "junction", "screen.png"),
      join(localTemp, "hardlink.png"),
      `${localTemp}${sep}..${sep}Temp${sep}screen.png`,
    ])
      await expect(exports.execute(request(path), scope)).rejects.toThrow();

    const capture = request(tempImage);
    expect((await exports.execute(capture, scope)).sizeBytes).toBe(BigInt(bytes.length));
    const read = { ...capture, operation: "read" };
    await expect(exports.execute({ ...read, allowLocalTemp: false }, scope)).rejects.toThrow("another request");
    expect((await exports.execute(read, scope)).data).toEqual(bytes);
    exports.release(capture.exportId);
    renameSync(localTemp, join(root, "old-temp"));
    mkdirSync(localTemp);
    writeFileSync(tempImage, bytes);
    await expect(exports.execute(request(tempImage), scope)).rejects.toThrow("directory changed");
    expect((await exports.execute(workspace, scope)).sizeBytes).toBe(BigInt(bytes.length));
  } finally {
    exports.close();
    remoteExports.close();
  }
});
