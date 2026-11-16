/**
 * CI check watches (docs/agent-bus.md, "Checki CI"): the scripted worker calls watch_pr_checks for a linked pull
 * request, the gateway polls the GitHub fixture through the visible PR producer, and the agent hears about a failed
 * run as a pr_checks turn; a pushed commit is followed with one more hop; the passing run of that commit ends the
 * watch. Cancelling, replacing and a merged pull request end watches.
 */
import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { GitPrContextSchema, type AgentToolResult, type ui } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { pollingFixture } from "./support/github-polling.ts";
import { connectGitHub, githubPrData, githubPrFixture, githubThread } from "./support/github-pr.ts";
import { linkedRead } from "./support/github-read.ts";

const json = (result: AgentToolResult) => JSON.parse(result.content) as JsonObject;

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
    const gw = await startTestGateway({ github: fixture.options });

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

      // The run fails: one note for the commit (complete names the failed check), as a turn of its own.
      fixture.state.running = false;
      fixture.state.conclusion = "FAILURE";
      fixture.state.version++;
      await pollUntil(gw, fixture, async () => (await turns(gw, thread)).some((t) => t.trigger === "pr_checks"));
      const [failed] = await noteTurns(gw, thread, 1);

      expect(failed?.hops).toBe(100);
      expect(failed?.text).toContain(
        "[canopy] CI checks of pull request itsoltech/canopy#42 (head aaaaaaa): 1 failed.",
      );
      expect(failed?.text).toContain('Every check finished; these failed:\n- "Build": failure, Actions, run 123');
      expect(failed?.text).toContain("gh run view <run_id> --log-failed");
      expect(failed?.text).toContain(`Still watching new commits (watch_id ${watchId}`);

      // The agent pushes a fix: the watch follows the new commit and tells nothing while it runs...
      fixture.state.head = "c".repeat(40);
      fixture.state.updatedAt = "2026-11-10T12:05:00Z";
      fixture.state.running = true;
      fixture.state.version++;
      await pollUntil(gw, fixture, async () => {
        const watches = json(await gw.worker.callTool({ threadId: thread, tool: "list_pr_watches", args: {} }));

        return JSON.stringify(watches).includes(fixture.state.head);
      });
      expect((await turns(gw, thread)).filter((t) => t.trigger === "pr_checks")).toHaveLength(1);

      // ...and its passing run ends the watch, one hop further.
      fixture.state.running = false;
      fixture.state.conclusion = "SUCCESS";
      fixture.state.version++;
      await pollUntil(
        gw,
        fixture,
        async () => (await turns(gw, thread)).filter((t) => t.trigger === "pr_checks").length === 2,
      );
      const [, passed] = await noteTurns(gw, thread, 2);

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

  test("cancel_pr_watch stops the notes; a merged pull request ends a watch with a note", async () => {
    const fixture = pollingFixture();
    const gw = await startTestGateway({ github: fixture.options });

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
    const gw = await startTestGateway({ github: fixture.options });

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
    const gw = await startTestGateway({ github: fixture.options });

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
    const gw = await startTestGateway({ github: fixture.options });

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
