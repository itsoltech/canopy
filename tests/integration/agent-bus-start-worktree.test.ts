import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { THREAD_WORKTREE_SWITCH_CAPABILITY } from "@canopy/domain/release/protocol";
import { WORKTREE_CHECKOUT_DEADLINE } from "@canopy/domain/worktree-timing";
import { tempDir } from "@canopy/testing";
import { git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("agent starts a thread in a worktree", () => {
  const dir = tempDir("canopy-start-worktree-");
  let fixture: Awaited<ReturnType<typeof worktreeFixture>>;

  beforeAll(async () => {
    fixture = await worktreeFixture(dir, {
      capabilities: [WORKTREE_CHECKOUT_DEADLINE, THREAD_WORKTREE_SWITCH_CAPABILITY],
    });
  }, 30_000);

  afterAll(async () => {
    await fixture?.close();
  });

  test("creates an isolated checkout without running repository hooks", async () => {
    const caller = await fixture.tree();
    const hook = join(fixture.repo, ".git", "hooks", "post-checkout");
    const marker = "checkout-hook-ran";
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o700 });

    const args = {
      project: "Lifecycle",
      title: "Independent task",
      prompt: "Read the README.",
      workspace_mode: "new_worktree",
      base_ref: "main",
      notify: false,
    };

    const callId = Bun.randomUUIDv7();
    const invoke = () => fixture.callTool(caller.id, args, callId, { toolName: "start_thread" });
    const reply = await invoke();

    expect(reply.isError, reply.content).toBe(false);
    const { thread_id } = JSON.parse(reply.resultJson) as { thread_id: string };
    const thread = (await fixture.gw.api.getThread({ threadId: thread_id })).thread!;

    expect(thread.kind).toBe(ui.ThreadKind.MAIN);
    expect(thread.cwd).not.toBe(caller.cwd);
    expect(thread.worktree?.id).toBeTruthy();
    expect(git(thread.cwd, "rev-parse", "HEAD")).toBe(git(fixture.repo, "rev-parse", "main"));
    expect(existsSync(join(thread.cwd, marker))).toBe(false);
    const replay = await invoke();

    expect(replay.isError, replay.content).toBe(false);
    expect(JSON.parse(replay.resultJson)).toEqual(JSON.parse(reply.resultJson));
    await fixture.settled(thread);
  }, 15_000);
});
