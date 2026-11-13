import { expect, spyOn, test } from "bun:test";
import { mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ListThreadDirectorySchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { VerifiedDirectory } from "../../apps/worker/src/files/directory-handle.ts";
import { ThreadDirectories } from "../../apps/worker/src/files/thread-directory.ts";

function fixture() {
  const dir = tempDir("canopy-directory-race-");
  const workspace = join(dir, "workspace");
  const parent = join(workspace, "parent");
  const saved = join(workspace, "saved");
  const outside = join(dir, "outside");
  mkdirSync(join(parent, "child"), { recursive: true });
  mkdirSync(join(outside, "child"), { recursive: true });
  writeFileSync(join(parent, "child", "inside.txt"), "safe");
  writeFileSync(join(outside, "child", "outside-secret.txt"), "outside metadata must not escape");

  return {
    workspace,
    replace() {
      renameSync(parent, saved);
      symlinkSync(outside, parent, "junction");
    },
    restore() {
      unlinkSync(parent);
      renameSync(saved, parent);
    },
  };
}

test.skipIf(process.platform === "win32")(
  "an ancestor ABA swap during enumeration cannot disclose outside names or sizes",
  async () => {
    const race = fixture();
    const directories = new ThreadDirectories();
    const open = VerifiedDirectory.open.bind(VerifiedDirectory);
    let swaps = 0;

    const probe = spyOn(VerifiedDirectory, "open").mockImplementation(async (target) => {
      const handle = await open(target);
      const read = handle.read.bind(handle);

      handle.read = async () => {
        race.replace();
        swaps++;

        try {
          return await read();
        } finally {
          race.restore();
        }
      };

      return handle;
    });

    try {
      const page = await directories.list(
        create(ListThreadDirectorySchema, {
          workspace: race.workspace,
          directory: "parent/child",
          includeIgnored: true,
        }),
      );

      expect(swaps).toBeGreaterThan(0);
      expect(page.complete).toBe(true);
      expect(page.entries.map(({ name, size }) => ({ name, size }))).toEqual([{ name: "inside.txt", size: 4n }]);
    } finally {
      probe.mockRestore();
      await directories.close();
    }
  },
);

test("an ancestor replaced after validation is rejected before enumeration", async () => {
  const race = fixture();
  const directories = new ThreadDirectories();
  const open = VerifiedDirectory.open.bind(VerifiedDirectory);

  const probe = spyOn(VerifiedDirectory, "open").mockImplementation(async (target) => {
    race.replace();

    try {
      return await open(target);
    } finally {
      race.restore();
    }
  });

  try {
    await expect(
      directories.list(create(ListThreadDirectorySchema, { workspace: race.workspace, directory: "parent/child" })),
    ).rejects.toMatchObject({ code: "DIRECTORY_PATH_INVALID" });
  } finally {
    probe.mockRestore();
    await directories.close();
  }
});
