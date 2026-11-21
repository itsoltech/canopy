import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { WelcomeSchema } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import type { GatewayLink } from "@canopy/worker/gateway-link";
import { FailedWorktreeCleanup } from "../../apps/worker/src/git/failed-worktree-cleanup.ts";
import { reserveCheckout } from "../../apps/worker/src/git/worktree-rollback.ts";
import { failure } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

type Fixture = Awaited<ReturnType<typeof worktreeFixture>>;

async function stoppedCheckout(f: Fixture, name: string, directory = "") {
  const path = join(realpathSync(f.dir), name);
  const branch = `canopy/${name}`;
  const commit = git(f.repo, "rev-parse", "HEAD");
  const marker = `Canopy worktree creation ${Bun.randomUUIDv7()}`;
  const reservation = await reserveCheckout(f.repo, path);
  git(f.repo, "update-ref", "--create-reflog", "-m", marker, `refs/heads/${branch}`, commit);
  git(f.repo, "worktree", "add", "-q", "--no-checkout", "--lock", "--reason", marker, path, branch);
  unlinkSync(join(path, ".git"));
  writeFileSync(join(reservation.metadata, "index.lock"), "");

  if (directory) mkdirSync(join(path, directory));
  new FailedWorktreeCleanup(f.data).rememberStopped(
    { path, branch, commit },
    marker,
    reservation,
    BigInt(Date.now() + 1) * 1_000_000n,
  );

  return { path, branch, commit };
}

describe.skipIf(!dockerAvailable || process.platform === "win32")(
  "failed worktree cleanup over the worker link",
  () => {
    test("only the settings inventory checks provenance, and removal requires a current confirmation from the owner", async () => {
      const f = await worktreeFixture(tempDir("canopy-failed-worktree-api-"), {
        capabilities: ["git_worktree_discovery", "failed_worktree_cleanup_v1"],
      });

      try {
        const eligible = await stoppedCheckout(f, "eligible");
        const referenced = await stoppedCheckout(f, "referenced");
        const nested = "nested";
        mkdirSync(join(f.repo, nested));
        commit(f.repo, `${nested}/example.txt`);
        const workspaceCheckout = await stoppedCheckout(f, "workspace-checkout", nested);
        const unrelated = join(realpathSync(f.dir), "unrelated");
        git(f.repo, "worktree", "add", "-qb", "unrelated", unrelated);
        git(f.repo, "worktree", "lock", "--reason", "In use elsewhere", unrelated);
        const list = async () => (await f.gw.api.listWorktrees({ projectId: f.project.id })).entries;
        const settings = await list();
        const row = settings.find((entry) => entry.worktree?.path === eligible.path)!;
        const aliasRow = settings.find((entry) => entry.worktree?.path === referenced.path)!;
        const workspaceRow = settings.find((entry) => entry.worktree?.path === workspaceCheckout.path)!;
        const unknown = settings.find((entry) => entry.worktree?.path === unrelated)!;
        const request = { worktreeId: row.worktree!.id, expectedCleanupToken: row.failedCleanupToken, confirmed: true };
        expect(row.failedCleanupToken).toBeTruthy();
        expect(aliasRow.failedCleanupToken).toBeTruthy();
        expect(workspaceRow.failedCleanupToken).toBeTruthy();
        expect(unknown.failedCleanupToken).toBe("");
        expect(unknown.failedCleanupReason).toMatch(/verify a stopped checkout/i);
        expect(
          (await f.cleanup(false)).entries.find((entry) => entry.worktree?.id === request.worktreeId)
            ?.failedCleanupToken,
        ).toBe("");
        expect(existsSync(eligible.path)).toBe(true);
        expect(await failure(f.gw.api.cleanUpFailedWorktree({ ...request, confirmed: false }))).toMatch(/confirm/i);

        const other = await f.gw.runtime.runPromise(
          GatewayStore.use((s) => s.ensureUser("foreign@example.test", "Other")),
        );

        const project = await f.gw.runtime.runPromise(GatewayStore.use((s) => s.createProject(other, "Other")));

        const workspace = await f.gw.runtime.runPromise(
          GatewayStore.use((s) =>
            s.createWorkspace({ projectId: project.id, workerId: f.workerId, rootPath: f.repo, label: "Other" }),
          ),
        );

        const otherToken = request.expectedCleanupToken.replace(f.workspace.id, workspace.id);
        expect(await failure(f.gw.api.cleanUpFailedWorktree({ ...request, expectedCleanupToken: otherToken }))).toMatch(
          /workspace not found/i,
        );

        const alias = join(f.dir, "registered-alias");
        symlinkSync(referenced.path, alias, "dir");
        await f.gw.runtime.runPromise(
          GatewayStore.use((s) =>
            s.insertWorktree({
              id: Bun.randomUUIDv7(),
              owner_user_id: other,
              project_id: project.id,
              workspace_id: workspace.id,
              worker_id: f.workerId,
              repo_root: f.repo,
              path: alias,
              branch: referenced.branch,
              base_ref: "main",
              base_commit: referenced.commit,
            }),
          ),
        );
        expect(
          await failure(
            f.gw.api.cleanUpFailedWorktree({
              worktreeId: aliasRow.worktree!.id,
              expectedCleanupToken: aliasRow.failedCleanupToken,
              confirmed: true,
            }),
          ),
        ).toMatch(/already registered/i);
        expect(existsSync(referenced.path)).toBe(true);

        const workspaceAlias = join(f.dir, "workspace-alias");
        symlinkSync(workspaceCheckout.path, workspaceAlias, "dir");
        await f.gw.runtime.runPromise(
          GatewayStore.use((s) =>
            s.createWorkspace({
              projectId: project.id,
              workerId: f.workerId,
              rootPath: join(workspaceAlias, nested),
              label: "Workspace without threads",
            }),
          ),
        );
        expect(
          await failure(
            f.gw.api.cleanUpFailedWorktree({
              worktreeId: workspaceRow.worktree!.id,
              expectedCleanupToken: workspaceRow.failedCleanupToken,
              confirmed: true,
            }),
          ),
        ).toContain("A Canopy workspace uses this worktree or a folder inside it.");
        expect((await list()).find((entry) => entry.worktree?.id === workspaceRow.worktree!.id)).toMatchObject({
          failedCleanupToken: "",
          failedCleanupReason: "A Canopy workspace uses this worktree or a folder inside it.",
        });
        expect(existsSync(join(workspaceCheckout.path, nested))).toBe(true);

        const toggle = async (enabled: string[]) => {
          const { user } = await f.gw.api.getSettings({});
          await f.gw.api.updateUserSettings({ expectedVersion: user!.version, modules: { enabled } });
        };

        await toggle(["bots"]);
        expect(await failure(f.gw.api.cleanUpFailedWorktree(request))).toMatch(/Enable Threads/i);
        await toggle(["threads", "bots"]);
        expect(
          await failure(
            f.gw.api.cleanUpFailedWorktree({ ...request, expectedCleanupToken: `${request.expectedCleanupToken}0` }),
          ),
        ).toMatch(/changed/i);
        expect(existsSync(eligible.path)).toBe(true);
        await f.gw.api.cleanUpFailedWorktree(request);
        expect(existsSync(eligible.path)).toBe(false);
        expect(git(f.repo, "rev-parse", `refs/heads/${eligible.branch}`)).toBe(eligible.commit);
        expect((await list()).some((entry) => entry.worktree?.id === request.worktreeId)).toBe(false);
        expect(existsSync(unrelated)).toBe(true);

        const interrupted = await stoppedCheckout(f, "interrupted");

        const workerRequest = {
          repoPath: f.repo,
          path: interrupted.path,
          expiresAtMs: BigInt(Date.now() + 20_000),
        };

        const proof = await f.command({
          commandId: Bun.randomUUIDv7(),
          kind: { case: "failedWorktreeCleanup", value: workerRequest },
        });

        const expectedCleanupToken = proof?.failedWorktreeCleanup?.token ?? "";
        expect(expectedCleanupToken).toBeTruthy();

        const runCleanup = (expiresAtMs: bigint) =>
          f.command({
            commandId: Bun.randomUUIDv7(),
            kind: { case: "failedWorktreeCleanup", value: { ...workerRequest, expiresAtMs, expectedCleanupToken } },
          });

        expect(await runCleanup(BigInt(Date.now() - 1))).toMatchObject({
          ok: false,
          errorCode: "WORKTREE_CLEANUP_EXPIRED",
        });

        const replacement: GatewayLink = {
          welcome: create(WelcomeSchema),
          messages: { async *[Symbol.asyncIterator]() {} },
          closed: Promise.resolve({}),
          close: () => {},
          send: () => {},
        };

        // Dispatch yields to the journal before it reaches GitCommands.
        const pending = runCleanup(workerRequest.expiresAtMs);

        try {
          f.host.attach(replacement);
          expect(await pending).toMatchObject({ ok: false, errorCode: "WORKTREE_CLEANUP_EXPIRED" });
          expect(existsSync(interrupted.path)).toBe(true);
        } finally {
          f.host.detach(replacement);
          await pending;
        }
      } finally {
        await f.close();
      }
    }, 60_000);
  },
);
