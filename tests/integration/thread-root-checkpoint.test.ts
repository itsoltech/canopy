import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { WorkspaceStore } from "@canopy/domain/workspace";
import { WorkspaceFileConflict } from "@canopy/domain/workspace-file";
import { observeWorkspaceFile } from "@canopy/domain/workspace-changes";
import { eventually } from "./support/gateway.ts";
import { worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("document root checkpoints across watch lifetimes", () => {
  const dir = tempDir("canopy-root-checkpoint-");
  let home: Awaited<ReturnType<typeof worktreeFixture>>;

  beforeAll(async () => {
    home = await worktreeFixture(dir, {
      capabilities: ["thread_files_watch_v1", "thread_files_v1", "thread_file_preview_v1"],
    });
  }, 90_000);
  afterAll(async () => home?.close(), 30_000);

  const store = () =>
    new WorkspaceStore(
      {
        read: (target, path, expectedSha256, signal) =>
          home.gw.api.readThreadFile({ threadId: target.threadId, path, expectedSha256 }, { signal }),
        write: async (target, path, text, expectedSha256, expectedRootIdentity) => {
          try {
            return await home.gw.api.writeThreadFile({
              threadId: target.threadId,
              path,
              content: new TextEncoder().encode(text),
              expectedSha256,
              expectedRootIdentity: expectedRootIdentity ?? "",
            });
          } catch (cause) {
            if (ConnectError.from(cause).code === Code.Aborted)
              throw new WorkspaceFileConflict(ConnectError.from(cause).rawMessage);
            throw cause;
          }
        },
        remove: async (target, path, expectedSha256, expectedRootIdentity) => {
          await home.gw.api.deleteThreadFile({
            threadId: target.threadId,
            path,
            expectedSha256,
            expectedRootIdentity: expectedRootIdentity ?? "",
          });
        },
        watchFiles: async (request, signal, receive) => {
          for await (const update of home.gw.api.watchThreadFiles(request, { signal, timeoutMs: 0 })) receive(update);
        },
      },
      8 * 1024 * 1024,
    );

  for (const reopen of [true, false])
    test(`identical replacement bytes cannot accept a retained draft (reopen watch: ${reopen})`, async () => {
      const thread = await home.tree();
      const file = join(thread.cwd, "source.txt");
      writeFileSync(file, "base");
      const workspace = store();
      const view = workspace.view(thread.id);
      view.open({ threadId: thread.id, path: "source.txt" });
      const document = view.currentFile!.document;
      await document.load();
      const original = document.file!;
      expect(original.rootIdentity).toMatch(/^[a-f0-9]{64}$/);
      document.edit();
      document.setDraft("draft from the previous checkout");
      let release = observeWorkspaceFile(workspace, document);
      const watches = () => home.gw.core.link.connections.get(home.workerId)!.fileWatches.size;
      const backup = `${thread.cwd}-saved`;
      let moved = false;

      try {
        await eventually(
          () => Promise.resolve(watches()),
          (size) => size === 1,
        );
        release();
        await eventually(
          () => Promise.resolve(watches()),
          (size) => size === 0,
        );
        renameSync(thread.cwd, backup);
        moved = true;
        mkdirSync(thread.cwd);
        writeFileSync(file, "base");

        if (reopen) {
          release = observeWorkspaceFile(workspace, document);
          await eventually(() => Promise.resolve(document.changedOnDisk), Boolean);
          await document.revalidate();
        }

        expect(await document.save()).toBe(false);
        expect(document.draft).toBe("draft from the previous checkout");
        expect(document.changedOnDisk).toBe(true);
        expect(readFileSync(file, "utf8")).toBe("base");

        const target = {
          threadId: thread.id,
          path: "source.txt",
          expectedSha256: original.sha256,
          expectedRootIdentity: original.rootIdentity,
        };

        await expect(
          home.gw.api.writeThreadFile({ ...target, content: new TextEncoder().encode("stale") }),
        ).rejects.toMatchObject({ code: Code.Aborted });
        await expect(home.gw.api.deleteThreadFile(target)).rejects.toMatchObject({ code: Code.Aborted });
        expect(readFileSync(file, "utf8")).toBe("base");
        document.discard();
        expect(await document.remove()).toBe(false);
        await document.load();
        expect(document.file?.rootIdentity).not.toBe(original.rootIdentity);
        document.edit();
        document.setDraft("accepted after explicit reload");
        expect(await document.save()).toBe(true);
        expect(readFileSync(file, "utf8")).toBe("accepted after explicit reload");
      } finally {
        release();
        workspace.clear();

        if (moved) {
          rmSync(thread.cwd, { recursive: true });
          renameSync(backup, thread.cwd);
        }
      }
    }, 30_000);
});
