import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Provider, WorkspaceCopyOperationSchema } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { copyTotals } from "@canopy/domain/workspace-copy";
import { tempDir } from "@canopy/testing";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("workspace copy recovery and total integrity over gRPC", () => {
  const dir = tempDir("canopy-copy-recovery-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  beforeAll(async () => {
    f = await worktreeFixture(dir);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  async function setup(name: string) {
    const manifest = (await f.gw.api.getWorkspaceCopyManifest({ workspaceId: f.workspace.id })).manifest!;
    const entries = manifest.entries.filter((e) => e.included);
    const token = Bun.randomUUIDv7();
    const project = (await f.gw.api.createProject({ name })).project!;

    const command = (operation: MessageInitShape<typeof WorkspaceCopyOperationSchema>) =>
      f.gw.api.workspaceCopyTarget({
        projectId: project.id,
        workerId: f.workerId,
        sourceRef: f.workspace.id,
        operation,
      });

    await f.gw.api.workspaceCopySource({
      workspaceId: f.workspace.id,
      token: manifest.token,
      authorize: true,
      paths: entries.map((e) => e.path),
      confirmedSecrets: entries.filter((e) => e.secret).map((e) => e.path),
    });
    await command({
      action: { case: "prepare", value: { token, parentPath: dir, name, entries, bytes: copyTotals(entries).bytes } },
    });
    const digest = createHash("sha256");

    async function write() {
      for (const entry of entries.filter((e) => !e.directory)) {
        let offset = 0n;

        for (;;) {
          const chunk = (
            await f.gw.api.workspaceCopySource({
              workspaceId: f.workspace.id,
              token: manifest.token,
              read: { token: manifest.token, path: entry.path, offset },
            })
          ).chunk!;

          offset += BigInt(chunk.data.length);
          chunk.token = token;
          await command({ action: { case: "write", value: chunk } });

          if (chunk.last) {
            digest.update(`${entry.path}\0${entry.size}\0${chunk.sha256}\n`);
            break;
          }
        }
      }

      return digest.digest("hex");
    }

    return {
      token,
      command,
      write,
      release: () =>
        f.gw.api.workspaceCopySource({ workspaceId: f.workspace.id, token: manifest.token, release: true }),
    };
  }

  test("refuses total hash mismatch and cleans partial files after worker restart", async () => {
    const s = await setup("partial");
    await s.write();
    let failed = false;

    try {
      await s.command({ action: { case: "finish", value: { token: s.token, sha256: "0".repeat(64) } } });
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    await f.restart();
    expect(existsSync(join(dir, "partial"))).toBe(false);
    expect(readdirSync(dir).some((p) => p.startsWith(".canopy-copy-"))).toBe(false);
    await s.release();
  }, 30_000);

  test("recovers a crash after rename and publishes a usable workspace on retry", async () => {
    const s = await setup("recover");
    const sha256 = await s.write();
    const first = await s.command({ action: { case: "finish", value: { token: s.token, sha256 } } });
    await f.gw.api.removeWorkspace({ workspaceId: first.workspaceRef });
    // Recreate the durable state of a crash between rename and either acknowledgement.
    await f.sql((sql) => sql`UPDATE workspace_copies SET status='writing',workspace_id=NULL WHERE id=${s.token}::uuid`);
    const path = join(dir, "data", "workspace-copies", s.token);
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    receipt.state = "committing";
    receipt.digest = sha256;
    writeFileSync(path, JSON.stringify(receipt));
    await f.restart();
    const result = await s.command({ action: { case: "prepare", value: { token: s.token } } });
    expect(result.workspaceRef).not.toBe("");
    expect(readFileSync(join(dir, "recover", "README.md"), "utf8")).toBe(
      readFileSync(join(f.repo, "README.md"), "utf8"),
    );
    expect((await s.command({ action: { case: "finish", value: { token: s.token, sha256 } } })).workspaceRef).toBe(
      result.workspaceRef,
    );

    const thread = (
      await f.gw.api.createThread({
        projectId: (await f.gw.api.getOverview({})).projects.find((p) =>
          p.workspaces.some((w) => w.id === result.workspaceRef),
        )!.id,
        workspaceId: result.workspaceRef,
        provider: Provider.CODEX,
        title: "Copied checkout",
        initialMessage: "where",
      })
    ).thread!;

    await f.settled(thread);
    expect(thread.cwd).toBe(join(dir, "recover"));
    await s.release();
  }, 30_000);
});
