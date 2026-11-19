import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { eventually, failure } from "./support/gateway.ts";
import { git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("branch admission during managed worktree removal", () => {
  const dir = tempDir("canopy-worktree-admission-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  beforeAll(async () => {
    f = await worktreeFixture(dir, { capabilities: ["archived_branch_cleanup"] });
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  test("a lost acknowledgement fences a stacked thread until reconciliation, leaving unrelated threads available", async () => {
    await f.settings({ deleteLocalBranch: true });
    const source = await f.tree();
    const dependent = await f.tree(source.worktree!.branch);
    const unrelated = await f.tree();

    for (const thread of [source, dependent, unrelated])
      await f.gw.api.setThreadArchived({ threadId: thread.id, archived: true });

    const handle = f.host.handleCommand.bind(f.host);
    let lost = false;
    f.host.handleCommand = async (command) => {
      const result = await handle(command);

      if (command.kind.case === "removeWorktree" && command.kind.value.target?.id === source.worktree!.id && !lost) {
        expect(command.kind.value.deleteArchivedBranch).toBe(true);
        lost = true;
        f.disconnect();

        return undefined;
      }

      return result;
    };

    try {
      expect(await failure(f.remove(source.worktree!.id))).toContain("disconnected");
      expect(lost).toBe(true);
      expect(await failure(f.gw.api.setThreadArchived({ threadId: dependent.id, archived: false }))).toContain(
        "Worktree cleanup is in progress",
      );
      await f.gw.api.setThreadArchived({ threadId: unrelated.id, archived: false });
      await f.connect();
      await eventually(
        () => f.entry(source.worktree!.id),
        (entry) => entry.removed,
      );
      await f.gw.api.setThreadArchived({ threadId: dependent.id, archived: false });
    } finally {
      f.host.handleCommand = handle;
    }
  }, 60_000);
  test("redelivering a legacy deletion request keeps the live thread's branch", async () => {
    await f.settings({ deleteLocalBranch: true });
    const thread = await f.tree();
    const tree = thread.worktree!;
    const entry = await f.entry(tree.id);
    const head = entry.status!.headCommit;

    const legacy = create(CommandSchema, {
      commandId: Bun.randomUUIDv7(),
      kind: {
        case: "removeWorktree",
        value: {
          deleteBranch: true,
          expectedHeadCommit: head,
          target: {
            id: tree.id,
            repoRoot: tree.repoRoot,
            path: tree.path,
            branch: tree.branch,
            baseRef: tree.baseRef,
            baseCommit: head,
          },
        },
      },
    });

    await f.sql(
      (sql) => sql`UPDATE worktrees SET removal_token=${legacy.commandId}::uuid, removal_started_at=now(),
      removal_command=${toBinary(CommandSchema, legacy)} WHERE id=${tree.id}::uuid`,
    );

    const handle = f.host.handleCommand.bind(f.host);
    let redelivered = false;
    f.host.handleCommand = async (command) => {
      if (command.commandId === legacy.commandId && command.kind.case === "removeWorktree") {
        expect(command.kind.value).toMatchObject({
          deleteBranch: false,
          deleteArchivedBranch: false,
          trackBranchForCleanup: false,
        });
        redelivered = true;
      }

      return handle(command);
    };

    try {
      expect((await f.cleanup(false)).entries.find((item) => item.worktree?.id === tree.id)).toMatchObject({
        removed: true,
        branchDeleted: false,
      });
      expect(redelivered).toBe(true);
      expect(git(f.repo, "rev-parse", tree.branch)).toBe(head);
    } finally {
      f.host.handleCommand = handle;
    }
  });
});
