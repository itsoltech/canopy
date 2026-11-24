import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ExportThreadImageSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { ThreadImageExports } from "./exports.ts";

const temp = tempDirs();

test("closing an image scope fences an in-flight snapshot and leaves another thread's export readable", async () => {
  const root = temp("canopy-image-close-");
  const attachments = join(root, "attachments");
  mkdirSync(attachments);
  const path = join(root, "image.png");
  writeFileSync(path, Buffer.alloc(512 * 1024, 42));
  const exports = new ThreadImageExports();
  const scope = { cwd: root, attachments, running: true };

  const request = (threadId: string) =>
    create(ExportThreadImageSchema, {
      threadId,
      turnId: "turn",
      exportId: crypto.randomUUID(),
      path,
      maxBytes: 1024n * 1024n,
      roots: [root],
      operation: "probe",
    });

  const archived = request("archived");
  const survivor = request("survivor");
  exports.assign("archived", root, attachments);
  exports.assign("survivor", root, attachments);

  try {
    await exports.execute(archived, scope);
    await exports.execute(survivor, scope);
    const snapshot = exports.execute({ ...archived, operation: "read" }, scope).catch((cause: Error) => cause);
    exports.closeThread("archived");

    const denied = await exports
      .execute({ ...archived, exportId: crypto.randomUUID() }, scope)
      .catch((cause: Error) => cause);

    expect(denied).toMatchObject({ code: "IMAGE_EXPORT_REFUSED" });
    // Reopening explicitly assigns the scope again and can use the released transfer slot.
    exports.assign("archived", root, attachments);
    expect((await exports.execute(archived, scope)).sizeBytes).toBe(512n * 1024n);
    expect(await snapshot).toMatchObject({ code: "IMAGE_EXPORT_REFUSED" });
    expect((await exports.execute({ ...archived, operation: "read" }, scope)).data?.byteLength).toBeGreaterThan(0);
    expect((await exports.execute({ ...survivor, operation: "read" }, scope)).data?.byteLength).toBeGreaterThan(0);
  } finally {
    exports.close();
  }
});

test("a newly assigned worktree revokes old image transfers and scopes the next turn to its checkout", async () => {
  const root = temp("canopy-image-rebind-");
  const original = join(root, "original");
  const moved = join(root, "moved");
  const attachments = join(root, "attachments");

  for (const dir of [original, moved, attachments]) mkdirSync(dir);
  const source = join(original, "image.png");
  const destination = join(moved, "image.png");
  writeFileSync(source, Buffer.alloc(40, 2));
  writeFileSync(destination, Buffer.alloc(32, 3));
  const exports = new ThreadImageExports();
  const scope = { cwd: original, attachments, running: true };

  const request = create(ExportThreadImageSchema, {
    threadId: "thread",
    turnId: "original",
    exportId: crypto.randomUUID(),
    path: source,
    maxBytes: 2048n,
    roots: [original],
    operation: "probe",
  });

  try {
    exports.assign("thread", original, attachments);
    expect((await exports.execute(request, scope)).sizeBytes).toBe(40n);
    exports.assign("thread", moved, attachments);
    await expect(exports.execute({ ...request, operation: "read" }, scope)).rejects.toMatchObject({
      code: "IMAGE_EXPORT_REFUSED",
    });
    expect(
      (
        await exports.execute(
          {
            ...request,
            turnId: "moved",
            exportId: crypto.randomUUID(),
            path: destination,
            roots: [moved],
          },
          { ...scope, cwd: moved },
        )
      ).sizeBytes,
    ).toBe(32n);
  } finally {
    exports.close();
  }
});
