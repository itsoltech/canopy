/**
 * CI check watches (docs/agent-bus.md, "Checki CI"): the scripted worker calls watch_pr_checks for a linked pull
 * request, the gateway polls the GitHub fixture through the visible PR producer, and the agent hears about a failed
 * run as a pr_checks turn; a pushed commit is followed with one more hop; the passing run of that commit ends the
 * watch. Cancelling, replacing and a merged pull request end watches.
 */
import { setModules } from "./support/module-settings.ts";
import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { GitPrContextSchema, PermissionMode, type AgentToolResult, ui } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { codexMessagePermission, composerChoices } from "@canopy/domain/composer-choices";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { pollingFixture } from "./support/github-polling.ts";
import { connectGitHub, githubPrData, githubPrFixture, githubThread } from "./support/github-pr.ts";
import { linkedRead } from "./support/github-read.ts";

const json = (result: AgentToolResult) => JSON.parse(result.content) as JsonObject;

async function startExplicitWatchGateway(options: Parameters<typeof startTestGateway>[0]) {
  const gw = await startTestGateway(options);

  try {
    const { user } = await gw.api.getSettings({});
    const defaults = user?.threadDefaults ?? create(ui.ThreadDefaultsSchema);
    await gw.api.updateUserSettings({
      expectedVersion: user!.version,
      threadDefaults: { ...defaults, notifyOnLinkedPullRequests: false },
    });

    return gw;
  } catch (error) {
    await gw.close();
    throw error;
  }
}

const turns = (gw: TestGateway, threadId: string) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<{ id: string; status: string; trigger: string; hops: number; text: string }>`
        SELECT id, status, trigger, hops, input->>'text' AS text FROM turns WHERE thread_id = ${threadId}::uuid ORDER BY ordinal`;
    }),
  );

const noteTurns = async (gw: TestGateway, threadId: string, count: number) =>
  (
    await eventually(
      () => turns(gw, threadId),
      (t) => t.filter((x) => x.trigger === "pr_checks" && x.status === "completed").length === count,
    )
  ).filter((x) => x.trigger === "pr_checks");

/** Moves the fixture clock past the producer's deadlines and polls until `done`. */
async function pollUntil(gw: TestGateway, fixture: ReturnType<typeof pollingFixture>, done: () => Promise<boolean>) {
  for (let round = 0; round < 12; round++) {
    fixture.advance(20_000);
    await gw.core.checkWatches.tick();

    if (await done()) return;
  }

  throw new Error("the watch did not reach the expected state");
}

describe.skipIf(!dockerAvailable)("CI check watches (gateway + scripted worker + GitHub fixture)", () => {
  test("a failed run, a followed commit and the passing run that ends the watch", async () => {
    const fixture = pollingFixture();

    const gw = await startExplicitWatchGateway({
      github: fixture.options,
      worker: { hello: { capabilities: ["full_access"] } },
    });

    try {
      const { thread } = await linkedRead(gw, fixture);
      await eventually(
        () => gw.api.getThread({ threadId: thread }),
        (r) => r.thread?.status === "idle",
      );

      const unknown = await gw.worker.callTool({
        threadId: thread,
        tool: "watch_pr_checks",
        args: { pull_request: "itsoltech/other#42" },
      });

      expect(unknown.isError).toBe(true);
      expect(unknown.content).toContain("Pull requests linked to this thread: itsoltech/canopy#42");

      const started = await gw.worker.callTool({
        threadId: thread,
        tool: "watch_pr_checks",
        args: { pull_request: "#42" },
      });

      expect(started.isError).toBe(false);
      const watchId = String(json(started)["watch_id"]);
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE pr_check_watches SET hops = 100 WHERE id = ${watchId}::uuid`;
        }),
      );

      expect(json(started)).toMatchObject({
        pull_request: "itsoltech/canopy#42",
        watching: true,
        notify_on: ["failure", "complete"],
        checks: { total: 1, pending: 1 },
      });

      // The thread's pull request list marks the watched pull request until the watch ends.
      const marked = (await gw.api.listThreadPullRequests({ threadId: thread })).links[0];
      expect(marked?.watchedUntil && timestampDate(marked.watchedUntil).toISOString()).toBe(
        String(json(started)["until"]),
      );

      // Change the Codex default during a manual turn. The CI wakeup must pick it up without another user message.
      gw.worker.holdTurns = true;

      const { turn } = await gw.api.sendMessage({
        threadId: thread,
        text: "check CI",
        clientRequestId: "before-ci",
        permissionMode: PermissionMode.READ_ONLY,
      });

      await eventually(
        () => turns(gw, thread),
        (rows) => rows.some((row) => row.id === turn!.id && row.status === "running"),
      );
      const before = (await gw.api.getThread({ threadId: thread })).thread!;
      expect(before.permissionModeSelected).toBe(false);
      expect(codexMessagePermission(before)).toBe(PermissionMode.READ_ONLY);

      await gw.api.updateThread({ threadId: thread, permissionMode: PermissionMode.FULL_ACCESS });
      const saved = (await gw.api.getThread({ threadId: thread })).thread!;
      expect(saved.permissionModeSelected).toBe(true);
      expect(composerChoices(saved, []).permissionMode).toBe(PermissionMode.FULL_ACCESS);
      expect(codexMessagePermission(saved)).toBe(PermissionMode.UNSPECIFIED);
      expect(codexMessagePermission(saved, PermissionMode.READ_ONLY)).toBe(PermissionMode.READ_ONLY);
      expect(gw.worker.turnModes.get(turn!.id)?.turn).toBe(PermissionMode.READ_ONLY);
      gw.worker.holdTurns = false;
      gw.worker.finish(thread, turn!.id);
      await eventually(
        () => turns(gw, thread),
        (rows) => rows.some((row) => row.id === turn!.id && row.status === "completed"),
      );

      // The run fails: one note for the commit (complete names the failed check), as a turn of its own.
      fixture.state.running = false;
      await setModules(gw, "bots");
      fixture.state.conclusion = "FAILURE";
      fixture.state.version++;
      fixture.advance(70_000);
      const requestsBefore = fixture.requests.length;
      await gw.core.checkWatches.tick();
      expect(fixture.requests).toHaveLength(requestsBefore);
      expect((await turns(gw, thread)).some((t) => t.trigger === "pr_checks")).toBe(false);
      await setModules(gw, "threads", "bots");
      await pollUntil(gw, fixture, async () => (await turns(gw, thread)).some((t) => t.trigger === "pr_checks"));
      const [failed] = await noteTurns(gw, thread, 1);

      expect(gw.worker.turnModes.get(failed!.id)?.turn).toBe(PermissionMode.FULL_ACCESS);
      expect(failed?.hops).toBe(100);
      expect(failed?.text).toContain(
        "[canopy] CI checks of pull request itsoltech/canopy#42 (head aaaaaaa): 1 failed.",
      );
      expect(failed?.text).toContain('Every check finished; these failed:\n- "Build": failure, Actions, run 123');
      expect(failed?.text).toContain("gh run view <run_id> --log-failed");
      expect(failed?.text).toContain(`Still watching new commits (watch_id ${watchId}`);

      // The agent pushes a fix: the watch follows the new commit and tells nothing while it runs...
      fixture.pushHead("c".repeat(40));
      fixture.state.updatedAt = "2026-11-10T12:05:00Z";
      fixture.state.running = true;
      fixture.state.version++;
      await pollUntil(gw, fixture, async () => {
        const watches = json(await gw.worker.callTool({ threadId: thread, tool: "list_pr_watches", args: {} }));

        return JSON.stringify(watches).includes(fixture.state.head);
      });
      expect((await turns(gw, thread)).filter((t) => t.trigger === "pr_checks")).toHaveLength(1);

      // ...and its passing run ends the watch, one hop further.
      const restricted = await gw.api.updateThread({ threadId: thread, permissionMode: PermissionMode.READ_ONLY });
      expect(codexMessagePermission(restricted.thread!, PermissionMode.FULL_ACCESS)).toBe(PermissionMode.UNSPECIFIED);
      fixture.state.running = false;
      fixture.state.conclusion = "SUCCESS";
      fixture.state.version++;
      await pollUntil(
        gw,
        fixture,
        async () => (await turns(gw, thread)).filter((t) => t.trigger === "pr_checks").length === 2,
      );
      const [, passed] = await noteTurns(gw, thread, 2);

      expect(gw.worker.turnModes.get(passed!.id)?.turn).toBe(PermissionMode.READ_ONLY);
      expect(passed?.text).toContain("(new commit ccccccc): 1 passed.");
      expect(passed?.text).toContain("Every check passed.");
      expect(passed?.text).toContain("This watch is over");
      expect(passed!.hops).toBe(failed!.hops + 1);

      const listed = json(await gw.worker.callTool({ threadId: thread, tool: "list_pr_watches", args: {} }));
      expect(listed["watches"]).toMatchObject([{ watch_id: watchId, status: "ended", end_reason: "passed" }]);
      expect((await gw.api.listThreadPullRequests({ threadId: thread })).links[0]?.watchedUntil).toBeUndefined();

      // The timeline gets the notes from the turns' input (no join), with their counts.
      const updates = await watchUntil(gw.api, thread, (u) => u.some((x) => x.change.case === "snapshot"));
      const snapshot = updates.find((u) => u.change.case === "snapshot")!.change.value as ui.ThreadSnapshot;
      const notes = snapshot.turns.filter((t) => t.sourceKind === "pr_checks").map((t) => t.prChecks[0]);

      expect(notes.map((n) => [n?.event, n?.failed, n?.passed, n?.watching, n?.reason])).toEqual([
        ["complete", 1, 0, true, ""],
        ["complete", 0, 1, false, "passed"],
      ]);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  test("a conflict already confirmed at watch start takes precedence over passing checks", async () => {
    const fixture = pollingFixture();
    fixture.state.running = false;
    fixture.state.mergeable = "CONFLICTING";
    fixture.state.mergeStateStatus = "DIRTY";
    const gw = await startExplicitWatchGateway({ github: fixture.options });

    try {
      const { thread } = await linkedRead(gw, fixture);
      await eventually(
        () => gw.api.getThread({ threadId: thread }),
        (r) => r.thread?.status === "idle",
      );

      const result = await gw.worker.callTool({
        threadId: thread,
        tool: "watch_pr_checks",
        args: { pull_request: "#42" },
      });

      expect(result.isError, result.content).toBe(false);
      const reply = json(result);
      expect(reply).toMatchObject({ watching: false, end_reason: "conflict", head_sha: fixture.state.head });
      expect(reply["note"]).toMatch(/conflict/i);
      expect(reply["note"]).toMatch(/resolve/i);
      expect((await gw.api.listThreadPullRequests({ threadId: thread })).links[0]?.watchedUntil).toBeUndefined();
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  for (const scenario of [
    { name: "the same head with no checks", moveHead: false, checkPages: 0, notify: "complete", mergeable: "UNKNOWN" },
    {
      name: "a new head with passing checks",
      moveHead: true,
      checkPages: 1,
      notify: "failure",
      mergeable: "CONFLICTING",
    },
  ]) {
    test(`a confirmed conflict on ${scenario.name} ends an active watch with one note`, async () => {
      const fixture = pollingFixture();
      fixture.state.running = false;
      fixture.state.checkPages = scenario.checkPages;
      fixture.state.mergeable = "UNKNOWN";
      fixture.state.mergeStateStatus = "UNKNOWN";
      const gw = await startExplicitWatchGateway({ github: fixture.options });

      try {
        const { thread } = await linkedRead(gw, fixture);
        await eventually(
          () => gw.api.getThread({ threadId: thread }),
          (r) => r.thread?.status === "idle",
        );

        const result = await gw.worker.callTool({
          threadId: thread,
          tool: "watch_pr_checks",
          args: { pull_request: "#42", notify_on: [scenario.notify] },
        });

        expect(result.isError, result.content).toBe(false);
        const start = json(result);
        expect(start).toMatchObject({
          watching: true,
          checks: { total: scenario.checkPages, passed: scenario.checkPages },
        });
        await gw.core.checkWatches.tick();

        // The base moves. GitHub still reports null while computing mergeability for this pair of commits.
        fixture.state.base = "d".repeat(40);
        await pollUntil(
          gw,
          fixture,
          async () => (await gw.core.github.prs.cached("itsoltech/canopy", 42))?.baseSha === fixture.state.base,
        );

        const list = async () =>
          json(await gw.worker.callTool({ threadId: thread, tool: "list_pr_watches", args: {} }));

        expect((await list())["watches"]).toMatchObject([{ status: "active", watch_id: start["watch_id"] }]);
        expect((await turns(gw, thread)).filter((t) => t.trigger === "pr_checks")).toHaveLength(0);

        // A computed result can change without a new updated_at, a check-run event or a push.
        if (scenario.moveHead) fixture.pushHead("c".repeat(40));
        fixture.state.mergeable = scenario.mergeable;
        fixture.state.mergeStateStatus = "DIRTY";
        await pollUntil(gw, fixture, async () => (await turns(gw, thread)).some((t) => t.trigger === "pr_checks"));
        const [note] = await noteTurns(gw, thread, 1);
        expect(note?.text).toMatch(/conflict/i);
        expect(note?.text).toMatch(/resolve/i);
        expect((await list())["watches"]).toMatchObject([
          { watch_id: start["watch_id"], status: "ended", end_reason: "conflict", head_sha: fixture.state.head },
        ]);

        fixture.advance(70_000);
        await gw.core.checkWatches.tick();
        const updates = await watchUntil(gw.api, thread, (u) => u.some((x) => x.change.case === "snapshot"));

        const notes = updates.flatMap(({ change }) =>
          change.case === "snapshot" ? change.value.turns.flatMap((turn) => turn.prChecks) : [],
        );

        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({
          watchId: start["watch_id"],
          headSha: fixture.state.head,
          headChanged: scenario.moveHead,
          watching: false,
          event: "ended",
          reason: "conflict",
        });
      } finally {
        await gw.close();
        fixture.close();
      }
    }, 90_000);
  }

  test("fast CI polling sees a same-head conflict when the last running check passes", async () => {
    const fixture = pollingFixture();
    const gw = await startExplicitWatchGateway({ github: fixture.options });

    try {
      const { thread } = await linkedRead(gw, fixture);
      await eventually(
        () => gw.api.getThread({ threadId: thread }),
        (r) => r.thread?.status === "idle",
      );

      const result = await gw.worker.callTool({
        threadId: thread,
        tool: "watch_pr_checks",
        args: { pull_request: "#42", notify_on: ["complete"] },
      });

      expect(result.isError, result.content).toBe(false);
      expect(json(result)).toMatchObject({ watching: true, checks: { pending: 1 } });
      await gw.core.checkWatches.tick();

      // CI goes green before the next slow metadata probe. Meanwhile the base advanced into a conflict.
      fixture.state.running = false;
      fixture.state.base = "d".repeat(40);
      fixture.state.mergeable = "CONFLICTING";
      fixture.state.mergeStateStatus = "DIRTY";
      const before = fixture.requests.length;
      fixture.advance(20_000);
      await gw.core.checkWatches.tick();
      expect(fixture.requests.slice(before).some((r) => r.resource.endsWith("/check-runs") && r.status === 200)).toBe(
        true,
      );
      await pollUntil(gw, fixture, async () => (await turns(gw, thread)).some((t) => t.trigger === "pr_checks"));

      const [note] = await noteTurns(gw, thread, 1);
      expect(note?.text).toMatch(/conflict/i);
      const listed = json(await gw.worker.callTool({ threadId: thread, tool: "list_pr_watches", args: {} }));
      expect(listed["watches"]).toMatchObject([
        { watch_id: json(result)["watch_id"], status: "ended", end_reason: "conflict", head_sha: fixture.state.head },
      ]);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  test("cancel_pr_watch stops the notes; a merged pull request ends a watch with a note", async () => {
    const fixture = pollingFixture();
    const gw = await startExplicitWatchGateway({ github: fixture.options });

    try {
      const { thread } = await linkedRead(gw, fixture);
      await eventually(
        () => gw.api.getThread({ threadId: thread }),
        (r) => r.thread?.status === "idle",
      );

      const watch = async (args: JsonObject) =>
        json(await gw.worker.callTool({ threadId: thread, tool: "watch_pr_checks", args }));

      const cancelled = String((await watch({ pull_request: "42", notify_on: ["each"] }))["watch_id"]);

      const stopped = await gw.worker.callTool({
        threadId: thread,
        tool: "cancel_pr_watch",
        args: { watch_id: cancelled },
      });

      expect(json(stopped)).toMatchObject({ watch_id: cancelled, status: "ended", cancelled: true });

      // A second watch of the same pull request replaces the first active one.
      const first = String((await watch({ pull_request: "#42" }))["watch_id"]);
      const second = String((await watch({ pull_request: "#42", timeout_minutes: 30 }))["watch_id"]);
      const listed = json(await gw.worker.callTool({ threadId: thread, tool: "list_pr_watches", args: {} }));

      expect(listed["watches"]).toMatchObject([
        { watch_id: second, status: "active" },
        { watch_id: first, status: "ended", end_reason: "replaced" },
        { watch_id: cancelled, status: "ended", end_reason: "cancelled" },
      ]);

      fixture.state.pr = "MERGED";
      fixture.state.updatedAt = "2026-11-10T12:07:00Z";
      await pollUntil(gw, fixture, async () => (await turns(gw, thread)).some((t) => t.trigger === "pr_checks"));
      const [merged] = await noteTurns(gw, thread, 1);

      expect(merged?.text).toContain("The pull request was merged, so the watch ended.");
      expect(merged?.text).toContain(`This watch is over (watch_id ${second})`);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  test("link_pull_request links and watches beyond the first page and respects unlink", async () => {
    const fixture = pollingFixture();
    const gw = await startExplicitWatchGateway({ github: fixture.options });

    try {
      const account = await connectGitHub(gw, fixture);
      const thread = await githubThread(gw);
      await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* sql`UPDATE project_workspaces SET git_origin='github.com/itsoltech/canopy'
            WHERE id=(SELECT workspace_id FROM threads WHERE id=${thread}::uuid)`;
        }),
      );
      await eventually(
        () => gw.api.getThread({ threadId: thread }),
        (r) => r.thread?.status === "idle",
      );

      // The target is older than a complete page of existing links.
      fixture.state.updatedAt = "2026-11-01T12:00:00Z";

      for (let number = 1; number <= 21; number++) {
        const current = await gw.api.listThreadPullRequests({ threadId: thread });
        await gw.api.linkThreadPullRequest({
          threadId: thread,
          url: `https://github.com/itsoltech/canopy/pull/${number}`,
          expectedRevision: current.revision,
        });
      }

      const linked = await gw.worker.callTool({
        threadId: thread,
        tool: "link_pull_request",
        args: { pull_request: "https://github.com/itsoltech/canopy/pull/42" },
      });

      expect(linked.isError).toBe(false);
      expect(json(linked)).toMatchObject({
        pull_request: "itsoltech/canopy#42",
        linked: true,
        state: "open",
      });

      const repeated = await gw.worker.callTool({
        threadId: thread,
        tool: "link_pull_request",
        args: { pull_request: "itsoltech/canopy#42" },
      });

      expect(json(repeated)).toMatchObject({ already_linked: true, linked: true });

      const firstPage = await gw.api.listThreadPullRequests({ threadId: thread });
      expect(firstPage.links.some((link) => link.summary?.ref?.number === 42)).toBe(false);
      const links = await gw.api.listThreadPullRequests({ threadId: thread, offset: firstPage.nextOffset });
      const target = links.links.find((link) => link.summary?.ref?.number === 42);
      const pullRequestId = target?.summary?.ref?.id;

      expect(target).toMatchObject({ source: "auto", evidence: "agent_tool" });
      expect(pullRequestId).toBeTruthy();

      const watched = await gw.worker.callTool({
        threadId: thread,
        tool: "watch_pr_checks",
        args: { pull_request: "itsoltech/canopy#42" },
      });

      expect(watched.isError).toBe(false);
      expect(json(watched)).toMatchObject({ watching: true });
      const beforeUnlink = await gw.api.listThreadPullRequests({ threadId: thread });
      await gw.api.unlinkThreadPullRequest({
        threadId: thread,
        pullRequestId: pullRequestId!,
        expectedRevision: beforeUnlink.revision,
      });

      const refused = await gw.worker.callTool({
        threadId: thread,
        tool: "link_pull_request",
        args: { pull_request: "itsoltech/canopy#42" },
      });

      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("previously unlinked");
      expect(refused.content).not.toContain("Settings");

      const audits = await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* sql`SELECT id FROM audit_log WHERE actor_user_id=${gw.userId}::uuid
            AND target_id=${pullRequestId!}::uuid AND action='github.agent_link'`;
        }),
      );

      expect(audits).toHaveLength(1);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  test("link_pull_request rejects unrelated repositories and allows a fork's upstream PR", async () => {
    const fixture = githubPrFixture();
    const gw = await startExplicitWatchGateway({ github: fixture.options });

    try {
      const account = await connectGitHub(gw, fixture);
      const thread = await githubThread(gw);
      await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          yield* sql`UPDATE project_workspaces SET git_origin='github.com/example/unrelated'
            WHERE id=(SELECT workspace_id FROM threads WHERE id=${thread}::uuid)`;
        }),
      );
      await eventually(
        () => gw.api.getThread({ threadId: thread }),
        (r) => r.thread?.status === "idle",
      );

      const args = { threadId: thread, tool: "link_pull_request", args: { pull_request: "itsoltech/canopy#42" } };
      const refused = await gw.worker.callTool(args);

      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("outside this thread's workspace repositories");
      expect(refused.content).not.toContain("Settings");
      expect((await gw.api.listThreadPullRequests({ threadId: thread })).links).toHaveLength(0);

      fixture.pullRequest((number, state, draft) => ({
        ...githubPrData(number, state, draft),
        headRepository: { databaseId: 888, nameWithOwner: "example/unrelated" },
      }));
      // Pause the fresh read so another action changes the link revision before the write.
      const gate = Promise.withResolvers<void>();
      fixture.gate(gate.promise);
      const calls = fixture.calls;
      const linking = gw.worker.callTool({ ...args, args: { pull_request: "itsoltech/canopy#99" } });

      try {
        await eventually(
          async () => fixture.calls,
          (count) => count > calls,
        );
        await gw.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            yield* sql`UPDATE threads SET pull_request_revision=pull_request_revision+1 WHERE id=${thread}::uuid`;
          }),
        );
      } finally {
        gate.resolve();
      }

      const fork = await linking;

      expect(fork.isError, fork.content).toBe(false);
      expect(json(fork)).toMatchObject({ pull_request: "itsoltech/canopy#99", linked: true });
      expect(fixture.calls).toBeGreaterThan(calls + 1);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  test("link_pull_request needs GitHub access and can use the thread's recorded Git context", async () => {
    const fixture = pollingFixture();
    const gw = await startExplicitWatchGateway({ github: fixture.options });

    try {
      const thread = await githubThread(gw);
      await eventually(
        () => gw.api.getThread({ threadId: thread }),
        (r) => r.thread?.status === "idle",
      );
      const call = { threadId: thread, tool: "link_pull_request", args: { pull_request: "itsoltech/canopy#42" } };
      const noRepo = await gw.worker.callTool(call);

      expect(noRepo.isError).toBe(true);
      expect(noRepo.content).toContain("no detected GitHub workspace repository");
      await gw.core.github.run((s) =>
        s.detectionSaveContext(
          gw.userId,
          thread,
          "/repo/github-fixture",
          create(GitPrContextSchema, {
            pushRemote: "origin",
            remotes: [{ name: "origin", pushRepositories: ["github.com/itsoltech/canopy"] }],
          }),
        ),
      );
      const noAccount = await gw.worker.callTool(call);

      expect(noAccount.isError).toBe(true);
      expect(noAccount.content).toContain("Settings → GitHub account");
      const account = await connectGitHub(gw, fixture);
      await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });

      for (const pull_request of ["#42", "https://github.com/itsoltech/canopy/pull/42?x=1"]) {
        const malformed = await gw.worker.callTool({ ...call, args: { pull_request } });

        expect(malformed.isError).toBe(true);
        expect(malformed.content).toContain("URL or owner/repo#123");
      }

      const linked = await gw.worker.callTool(call);

      expect(linked.isError).toBe(false);
      expect(json(linked)).toMatchObject({ linked: true, pull_request: "itsoltech/canopy#42" });
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);
});
