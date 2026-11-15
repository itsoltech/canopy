/**
 * Generated branch names with a provisional start (docs/worktrees.md, "Nazwy gałęzi"): real gateway, PostgreSQL,
 * gRPC link, WorkerHost and git. GenerateText is stubbed at the worker; everything else (claims, the worker's
 * rename rules, live heads) runs for real.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  MentionKind,
  MentionSchema,
  Provider,
  TurnOutcome,
  ui,
  type GenerateText,
  type Mention,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { Journal } from "@canopy/worker/journal";
import sharp from "sharp";
import { eventually } from "./support/gateway.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";

describe.skipIf(!dockerAvailable)("generated branch names over the worker link", () => {
  const dir = tempDir("canopy-branch-names-");
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  const prompts: string[] = [];
  const logs: string[] = [];
  let holdTurn = false;
  let pendingTurn: { threadId: string; turnId: string } | undefined;
  let failRename = false;
  /** The model's next answers; an Error fails the generation. */
  let replies: (string | Error | Promise<string>)[] = [];

  beforeAll(async () => {
    f = await worktreeFixture(dir, {
      capabilities: ["git_heads", "provisional_branches", "generate_text"],
      log: (message) => logs.push(message),
    });
    const host = f.host;
    const handle = host.handleCommand.bind(host);
    host.handleCommand = async (command) => {
      if (holdTurn && command.kind.case === "startTurn") {
        const { thread, turnId } = command.kind.value;
        pendingTurn = { threadId: thread!.threadId, turnId };

        const event = await f.runtime.runPromise(
          Journal.use((j) => j.append(thread!.threadId, { turnId, body: { case: "turnStarted", value: {} } })),
        );

        f.send({ case: "threadEvent", value: event });

        return { commandId: command.commandId, ok: true };
      }

      if (failRename && command.kind.case === "renameWorktreeBranch")
        return { commandId: command.commandId, ok: false, errorMessage: "private worker diagnostic" };

      if (command.kind.case !== "generateText") return handle(command);
      const request: GenerateText = command.kind.value;

      if (!request.prompt.includes("Name a git branch")) return handle(command);
      prompts.push(request.prompt);
      const reply = await (replies.shift() ?? "unclear");

      return reply instanceof Error
        ? { commandId: command.commandId, ok: false, errorCode: "GENERATION_FAILED" }
        : { commandId: command.commandId, ok: true, generatedText: reply };
    };

    await f.settings({ branchNaming: ui.BranchNaming.SEMANTIC, branchPrefix: "canopy" });
  }, 60_000);

  afterAll(async () => {
    await f?.close();
  });

  const thread = (threadId: string) => f.gw.api.getThread({ threadId }).then((r) => r.thread!);

  const start = async (
    initialMessage: string,
    attachments: { initialAttachmentIds?: string[]; initialMentions?: Mention[] } = {},
  ) => {
    const running = holdTurn;

    const created = (
      await f.gw.api.createThread({
        projectId: f.project.id,
        workspaceId: f.workspace.id,
        provider: Provider.CODEX,
        initialMessage,
        workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
        baseRef: "main",
        ...attachments,
      })
    ).thread!;

    await eventually(
      () => thread(created.id),
      (t) => (running ? t.status === "running" : t.status !== "starting" && t.lastTurnStatus !== ""),
    );

    return created;
  };

  /** A follow-up message and the end of its turn (the stand-in agent cannot run it, so it fails at once). */
  const say = async (threadId: string, text: string) => {
    const before = prompts.length;
    await f.gw.api.sendMessage({ threadId, text, clientRequestId: Bun.randomUUIDv7() });
    await eventually(
      () => thread(threadId),
      (t) => t.status !== "running" && t.status !== "starting",
    );

    return before;
  };

  const settled = async () => Bun.sleep(400);

  test("a clear first message: the provisional name gives way to the generated one, live, in the same folder", async () => {
    replies = ["fix/login-redirect-loop"];
    const created = await start("Fix the login redirect loop after sign-out");
    expect(created.worktree?.branch).toMatch(/^canopy\/fix-the-login-[0-9a-hjkmnp-tv-z]{4}$/);
    expect(created.worktree?.provisionalBranch).toBe(true);

    const renamed = await eventually(
      () => thread(created.id),
      (t) => t.worktree?.branch === "fix/login-redirect-loop",
    );

    expect(renamed.worktree).toMatchObject({ provisionalBranch: false, path: created.worktree!.path });
    expect(git(created.cwd, "symbolic-ref", "--short", "HEAD")).toBe("fix/login-redirect-loop");
    expect(prompts.at(-1)).toContain("User: Fix the login redirect loop after sign-out");
  }, 30_000);

  test("an attachment and a fenced name: renames while the first turn is still running", async () => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#333" } })
      .png()
      .toBuffer();

    const file = (await f.gw.api.uploadAttachment({ name: "CleanShot 2026-11-15.png", data: new Uint8Array(image) }))
      .attachment!;

    const label = `[${file.name}]`;
    replies = ["```text\nfix/background-jobs-badge-position\n```"];
    holdTurn = true;

    try {
      const created = await start(`${label} I think this badge should be closer to the composer`, {
        initialAttachmentIds: [file.id],
        initialMentions: [
          create(MentionSchema, {
            kind: MentionKind.ATTACHMENT,
            name: file.id,
            label: file.name,
            start: 0,
            end: label.length,
            source: "image",
          }),
        ],
      });

      const renamed = await eventually(
        () => thread(created.id),
        (t) => t.worktree?.branch === "fix/background-jobs-badge-position",
      );

      expect(renamed.status).toBe("running");
      expect(renamed.worktree).toMatchObject({ provisionalBranch: false, path: created.cwd });
      expect(git(created.cwd, "symbolic-ref", "--short", "HEAD")).toBe("fix/background-jobs-badge-position");
      expect(prompts.at(-1)).toContain("this badge should be closer to the composer");
      expect(prompts.at(-1)).not.toContain(f.host.attachmentsRoot);
    } finally {
      holdTurn = false;

      if (pendingTurn) {
        const { threadId, turnId } = pendingTurn;
        pendingTurn = undefined;

        const event = await f.runtime.runPromise(
          Journal.use((j) =>
            j.append(threadId, { turnId, body: { case: "turnFinished", value: { outcome: TurnOutcome.COMPLETED } } }),
          ),
        );

        f.send({ case: "threadEvent", value: event });
      }
    }
  }, 30_000);

  test("a turn ending during generation retains the latest conversation for the next attempt", async () => {
    const first = Promise.withResolvers<string>();
    replies = [first.promise, "fix/composer-badge-spacing"];
    const created = await start("hello");

    try {
      await say(created.id, "Move the background jobs badge closer to the composer");
      const deferred = `worktree ${created.worktree!.id}: branch name check deferred until current generation completes`;
      expect(
        await eventually(
          async () => logs,
          (messages) => messages.includes(deferred),
        ),
      ).toContain(deferred);
    } finally {
      first.resolve("```\nunclear\n```");
    }

    const renamed = await eventually(
      () => thread(created.id),
      (t) => t.worktree?.branch === "fix/composer-badge-spacing",
    );

    expect(renamed.worktree?.provisionalBranch).toBe(false);
    expect(prompts.at(-1)).toContain("User: Move the background jobs badge closer to the composer");
    expect(git(created.cwd, "symbolic-ref", "--short", "HEAD")).toBe("fix/composer-badge-spacing");
    expect(
      await f.sql((sql) => sql`SELECT branch_attempts FROM worktrees WHERE id=${created.worktree!.id}::uuid`),
    ).toMatchObject([{ branch_attempts: 2 }]);
  }, 30_000);

  test("invalid output and failed renames record safe reasons and preserve the branch", async () => {
    for (const answer of ["fix/first-line\nprivate model response", "```\nfix/second-line\n***\n``` "]) {
      replies = [answer];
      const invalid = await start("Move the badge");
      const reason = `worktree ${invalid.worktree!.id}: branch name response invalid; kept`;
      expect(
        await eventually(
          async () => logs,
          (messages) => messages.includes(reason),
        ),
      ).toContain(reason);
      expect((await thread(invalid.id)).worktree?.branch).toBe(invalid.worktree!.branch);
    }

    replies = ["fix/badge-spacing"];
    failRename = true;

    try {
      const failed = await start("Fix the badge spacing");
      const reason = `worktree ${failed.worktree!.id}: branch rename failed; kept`;
      expect(
        await eventually(
          async () => logs,
          (messages) => messages.includes(reason),
        ),
      ).toContain(reason);
      expect(git(failed.cwd, "symbolic-ref", "--short", "HEAD")).toBe(failed.worktree!.branch);
      expect((await thread(failed.id)).worktree?.provisionalBranch).toBe(true);
    } finally {
      failRename = false;
    }

    expect(logs.join("\n")).not.toContain("private model response");
    expect(logs.join("\n")).not.toContain("private worker diagnostic");
  }, 30_000);

  test("a vague first message keeps the provisional name; the next turn's request names it", async () => {
    replies = ["unclear"];
    const created = await start("siema");
    expect(created.worktree?.branch).toMatch(/^canopy\/siema-[0-9a-hjkmnp-tv-z]{4}$/);
    await eventually(
      async () => prompts.length,
      () => replies.length === 0,
    );
    await settled();
    expect((await thread(created.id)).worktree).toMatchObject({
      branch: created.worktree!.branch,
      provisionalBranch: true,
    });

    replies = ["test/fix-flaky-upload"];
    await say(created.id, "Please fix the flaky upload test");

    const renamed = await eventually(
      () => thread(created.id),
      (t) => t.worktree?.branch === "test/fix-flaky-upload",
    );

    expect(renamed.worktree?.provisionalBranch).toBe(false);
    expect(prompts.at(-1)).toContain("User: siema");
    expect(prompts.at(-1)).toContain("User: Please fix the flaky upload test");
  }, 30_000);

  test("a generated name another branch has, locally or on the remote, gets a number", async () => {
    git(f.repo, "branch", "feat/local-taken");
    const other = join(dir, "other");
    git(dir, "clone", "-q", f.origin, other);
    git(other, "switch", "-q", "-c", "feat/remote-taken");
    commit(other, "remote.txt");
    git(other, "push", "-q", "origin", "feat/remote-taken");
    git(f.repo, "fetch", "-q", "origin");

    replies = ["feat/local-taken"];
    const local = await start("Add the local thing");
    await eventually(
      () => thread(local.id),
      (t) => t.worktree?.branch === "feat/local-taken-2",
    );

    replies = ["feat/remote-taken"];
    const remote = await start("Add the remote thing");
    expect(
      (
        await eventually(
          () => thread(remote.id),
          (t) => t.worktree?.branch === "feat/remote-taken-2",
        )
      ).worktree?.branch,
    ).toBe("feat/remote-taken-2");
  }, 30_000);

  test("no rename after a push, after a switch, after a rename by hand; failures keep the name", async () => {
    // Pushed without an upstream: the remote has the provisional name.
    replies = ["unclear"];
    const pushed = await start("hello there");
    await eventually(
      async () => prompts.length,
      () => replies.length === 0,
    );
    git(pushed.cwd, "push", "-q", "origin", "HEAD");
    replies = ["feat/pushed-work"];
    await say(pushed.id, "Add the pushed work");
    await eventually(
      () => thread(pushed.id),
      (t) => t.worktree?.provisionalBranch === false,
    );
    expect((await thread(pushed.id)).worktree?.branch).toBe(pushed.worktree!.branch);
    expect(git(pushed.cwd, "symbolic-ref", "--short", "HEAD")).toBe(pushed.worktree!.branch);

    // Switched away and back: HEAD is on the name again, but the worktree's reflog shows the switch.
    replies = ["unclear"];
    const switched = await start("good morning");
    await eventually(
      async () => prompts.length,
      () => replies.length === 0,
    );
    git(switched.cwd, "switch", "-q", "-c", "scratch");
    git(switched.cwd, "switch", "-q", switched.worktree!.branch);
    await settled();
    replies = ["feat/switched-work"];
    await say(switched.id, "Add the switched work");
    await eventually(
      () => thread(switched.id),
      (t) => t.worktree?.provisionalBranch === false,
    );
    expect((await thread(switched.id)).worktree?.branch).toBe(switched.worktree!.branch);

    // Renamed by hand (or by the agent): the gateway keeps it without asking the model.
    replies = ["unclear"];
    const named = await start("hi");
    await eventually(
      async () => prompts.length,
      () => replies.length === 0,
    );
    git(named.cwd, "branch", "-m", "my-own-name");
    await eventually(
      () => thread(named.id),
      (t) => t.worktree?.branch === "my-own-name",
    );
    const asked = prompts.length;
    replies = ["feat/should-not-apply"];
    await say(named.id, "Add the named work");
    await eventually(
      () => thread(named.id),
      (t) => t.worktree?.provisionalBranch === false,
    );
    expect(prompts.length).toBe(asked);
    expect(git(named.cwd, "symbolic-ref", "--short", "HEAD")).toBe("my-own-name");

    // A failed generation keeps the name and the thread; the attempts end after three.
    replies = [new Error("model unavailable")];
    const failing = await start("hey");
    await eventually(
      async () => prompts.length,
      () => replies.length === 0,
    );
    replies = ["unclear", "unclear", "feat/too-late"];
    await say(failing.id, "anything new?");
    await eventually(
      async () => replies.length,
      (n) => n === 2,
    );
    await say(failing.id, "still nothing");
    await eventually(
      async () => replies.length,
      (n) => n === 1,
    );
    await say(failing.id, "one more");
    await settled();
    const kept = await thread(failing.id);
    expect(kept.worktree).toMatchObject({ branch: failing.worktree!.branch, provisionalBranch: true });
    expect(kept.status).not.toBe("failed");
    expect(replies).toEqual(["feat/too-late"]);
  }, 60_000);
});
