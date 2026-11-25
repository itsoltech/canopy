import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { PrChecksNote } from "@canopy/domain";
import { createRequest } from "@canopy/domain/github-lifecycle";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { lifecycleFixture } from "./support/github-lifecycle.ts";
import { pollingFixture } from "./support/github-polling.ts";
import { connectGitHub, githubBrowser, githubThread } from "./support/github-pr.ts";
import { linkedRead } from "./support/github-read.ts";

const repo = "itsoltech/canopy";
const url = "https://github.com/itsoltech/canopy/pull/42";
const gitRepository = "github.com/itsoltech/canopy";

interface Delivery {
  automatic: boolean;
  body: PrChecksNote;
  status: string;
  turnStatus: string | null;
  text: string | null;
}

const deliveries = (gw: TestGateway, threadId: string) =>
  gw.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql<Delivery>`
        SELECT w.call_id IS NULL AS automatic, n.body, n.status, t.status AS "turnStatus", t.input->>'text' AS text
        FROM pr_check_notes n JOIN pr_check_watches w ON w.id=n.watch_id
        LEFT JOIN turns t ON t.id=n.turn_id
        WHERE n.thread_id=${threadId}::uuid ORDER BY n.created_at, n.id`;
    }),
  );

async function completedNotes(gw: TestGateway, thread: string, count: number) {
  const rows = await eventually(
    () => deliveries(gw, thread),
    (notes) => notes.length >= count && notes.every((n) => n.status === "delivered" && n.turnStatus === "completed"),
  );

  expect(rows.map(({ status, turnStatus }) => [status, turnStatus])).toEqual(
    Array.from({ length: count }, () => ["delivered", "completed"]),
  );

  return rows;
}

async function idle(gw: TestGateway, threadId: string) {
  const result = await eventually(
    () => gw.api.getThread({ threadId }),
    (r) => r.thread?.status === "idle",
  );

  expect(result.thread?.status).toBe("idle");

  return result.thread!;
}

interface Clock {
  advance(ms: number): void;
}

async function tick(gw: TestGateway, clock: Clock, ms: number) {
  clock.advance(ms);
  await gw.core.checkWatches.tick();
}

/** Both the shared GitHub producer and the durable watch judge run on this fixture's clock. */
async function pollUntil(gw: TestGateway, clock: Clock, ready: () => Promise<boolean>) {
  for (let round = 0; round < 16; round++) {
    await tick(gw, clock, 20_000);

    if (await ready()) return;
  }

  throw new Error("GitHub fixture did not reach the expected check or notification state");
}

const cached = (gw: TestGateway) => gw.core.github.prs.cached(repo, 42);

const observedChecks = (gw: TestGateway, fixture: ReturnType<typeof pollingFixture>, state: string, count: number) =>
  pollUntil(gw, fixture, async () => {
    const summary = (await cached(gw))?.summary;

    return summary?.checksState === state && summary.checksCount === count;
  });

const pollForNotes = (gw: TestGateway, clock: Clock, thread: string, count: number) =>
  pollUntil(gw, clock, async () => (await deliveries(gw, thread)).length >= count);

async function setGlobal(gw: TestGateway, enabled: boolean) {
  const { user } = await gw.api.getSettings({});
  const defaults = user?.threadDefaults ?? create(ui.ThreadDefaultsSchema);
  await gw.api.updateUserSettings({
    expectedVersion: user!.version,
    threadDefaults: { ...defaults, notifyOnLinkedPullRequests: enabled },
  });
}

async function setProject(gw: TestGateway, projectId: string, enabled: boolean) {
  const project = (await gw.api.getSettings({})).projects.find((p) => p.projectId === projectId);
  const defaults = project?.threadDefaults ?? create(ui.ThreadDefaultsSchema);
  await gw.api.updateProjectSettings({
    projectId,
    expectedVersion: project?.version ?? 0n,
    threadDefaults: { ...defaults, notifyOnLinkedPullRequests: enabled },
  });
}

describe.skipIf(!dockerAvailable)("automatic GitHub notifications for linked pull requests", () => {
  test("waits through check fanout, deduplicates across a restart and follows new heads", async () => {
    const fixture = pollingFixture();
    fixture.state.mergeable = "UNKNOWN";
    fixture.state.mergeStateStatus = "UNKNOWN";
    let gw = await startTestGateway({ github: fixture.options });

    try {
      const { thread } = await linkedRead(gw, fixture);
      await idle(gw, thread);
      await gw.core.checkWatches.tick();

      expect((await gw.api.listThreadPullRequests({ threadId: thread })).links[0]?.watchedUntil).toBeUndefined();
      expect(await deliveries(gw, thread)).toEqual([]);

      // Build fails before the second workflow's check appears.
      fixture.state.running = false;
      fixture.state.conclusion = "FAILURE";
      fixture.state.version++;
      await observedChecks(gw, fixture, "failure", 1);
      expect(await deliveries(gw, thread)).toEqual([]);

      fixture.state.tests = "pending";
      fixture.state.version++;
      await observedChecks(gw, fixture, "pending", 2);
      await tick(gw, fixture, 150_000);
      expect(await deliveries(gw, thread)).toEqual([]);

      fixture.state.tests = "success";
      fixture.state.version++;
      await observedChecks(gw, fixture, "failure", 2);
      await tick(gw, fixture, 20_000);
      expect(await deliveries(gw, thread)).toEqual([]);
      await pollForNotes(gw, fixture, thread, 1);
      const firstNotes = await completedNotes(gw, thread, 1);
      const [failed] = firstNotes;
      expect(failed).toMatchObject({
        automatic: true,
        body: {
          head_sha: fixture.state.head,
          event: "complete",
          counts: { total: 2, passed: 1, failed: 1, pending: 0 },
          checks: [expect.objectContaining({ name: "Build", run_id: "123" })],
        },
      });
      expect(gw.worker.inputs.get(thread)).toHaveLength(1);
      expect(failed?.text).toBe(gw.worker.inputs.get(thread)?.[0]);
      expect(failed?.text).toContain("run 123");
      expect(failed?.text).not.toContain("watch_id");

      const { pg, secretsKey, workerId, workerCredential } = gw;
      await gw.close(true);
      gw = await startTestGateway({ github: fixture.options, storage: { pg, secretsKey, workerId, workerCredential } });
      await idle(gw, thread);
      await tick(gw, fixture, 150_000);
      await tick(gw, fixture, 150_000);
      expect(await deliveries(gw, thread)).toEqual(firstNotes);
      expect(gw.worker.inputs.get(thread)).toBeUndefined();

      fixture.pushHead("c".repeat(40));
      fixture.state.running = true;
      fixture.state.conclusion = "SUCCESS";
      fixture.state.version++;
      await pollUntil(gw, fixture, async () => (await cached(gw))?.summary?.headSha === fixture.state.head);
      expect(await deliveries(gw, thread)).toEqual(firstNotes);

      fixture.state.running = false;
      fixture.state.version++;
      await pollForNotes(gw, fixture, thread, 2);
      const bothNotes = await completedNotes(gw, thread, 2);
      const [, passed] = bothNotes;
      expect(passed).toMatchObject({
        automatic: true,
        body: {
          head_sha: fixture.state.head,
          event: "complete",
          counts: { total: 2, passed: 2, failed: 0, pending: 0 },
        },
      });
      expect(gw.worker.inputs.get(thread)).toHaveLength(1);
      expect(passed?.text).toBe(gw.worker.inputs.get(thread)?.[0]);
      expect(passed?.text).toContain(": 2 passed.");

      fixture.state.pr = "MERGED";
      await pollUntil(gw, fixture, async () => (await cached(gw))?.summary?.state === "merged");
      await tick(gw, fixture, 150_000);
      expect(await deliveries(gw, thread)).toEqual(bothNotes);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  test("reports the final checks once when GitHub auto-merges between polls", async () => {
    const fixture = pollingFixture();
    const gw = await startTestGateway({ github: fixture.options });

    try {
      const { thread } = await linkedRead(gw, fixture);
      await idle(gw, thread);
      await gw.core.checkWatches.tick();
      expect(await deliveries(gw, thread)).toEqual([]);

      fixture.state.pr = "MERGED";
      fixture.state.running = false;
      fixture.state.version++;
      await pollUntil(gw, fixture, async () => (await cached(gw))?.summary?.state === "merged");
      const notes = await completedNotes(gw, thread, 1);
      expect(notes).toMatchObject([
        {
          automatic: true,
          body: { event: "complete", reason: "", counts: { total: 1, passed: 1, failed: 0, pending: 0 } },
        },
      ]);

      await tick(gw, fixture, 150_000);
      expect(await deliveries(gw, thread)).toEqual(notes);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  test("reports a confirmed conflict with no checks and stays quiet when the PR closes", async () => {
    const fixture = pollingFixture();
    fixture.state.checkPages = 0;
    fixture.state.mergeable = "UNKNOWN";
    fixture.state.mergeStateStatus = "UNKNOWN";
    const gw = await startTestGateway({ github: fixture.options });

    try {
      const { thread } = await linkedRead(gw, fixture);
      await idle(gw, thread);
      await tick(gw, fixture, 150_000);
      expect(await deliveries(gw, thread)).toEqual([]);

      fixture.state.mergeable = "CONFLICTING";
      fixture.state.mergeStateStatus = "DIRTY";
      await pollForNotes(gw, fixture, thread, 1);
      const notes = await completedNotes(gw, thread, 1);
      const [conflict] = notes;
      expect(conflict).toMatchObject({
        automatic: true,
        body: { reason: "conflict", head_sha: fixture.state.head },
      });
      expect(gw.worker.inputs.get(thread)).toHaveLength(1);
      expect(conflict?.text).toBe(gw.worker.inputs.get(thread)?.[0]);

      fixture.state.pr = "CLOSED";
      await pollUntil(gw, fixture, async () => (await cached(gw))?.summary?.state === "closed");
      await tick(gw, fixture, 150_000);
      expect(await deliveries(gw, thread)).toEqual(notes);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  test("uses the project override in both directions", async () => {
    const fixture = pollingFixture();
    fixture.state.running = false;
    const gw = await startTestGateway({ github: fixture.options });

    try {
      const { thread: inherited } = await linkedRead(gw, fixture);
      await idle(gw, inherited);
      const projectThread = await idle(gw, await githubThread(gw));
      await setProject(gw, projectThread.projectId, false);
      await gw.api.linkThreadPullRequest({ threadId: projectThread.id, url });
      await pollForNotes(gw, fixture, inherited, 1);
      const inheritedNotes = await completedNotes(gw, inherited, 1);
      expect(await deliveries(gw, projectThread.id)).toEqual([]);

      await setGlobal(gw, false);
      await setProject(gw, projectThread.projectId, true);
      fixture.pushHead("c".repeat(40));
      await pollForNotes(gw, fixture, projectThread.id, 1);
      expect(await completedNotes(gw, projectThread.id, 1)).toMatchObject([
        { automatic: true, body: { head_sha: fixture.state.head } },
      ]);
      expect(await deliveries(gw, inherited)).toEqual(inheritedNotes);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  test("gives an active explicit watch precedence even when automatic notifications are disabled afterward", async () => {
    const fixture = pollingFixture();
    const gw = await startTestGateway({ github: fixture.options });

    try {
      const { thread } = await linkedRead(gw, fixture);
      await idle(gw, thread);
      await gw.core.checkWatches.tick();

      const watch = await gw.worker.callTool({
        threadId: thread,
        tool: "watch_pr_checks",
        args: { pull_request: "#42", notify_on: ["failure"] },
      });

      expect(watch.isError, watch.content).toBe(false);
      expect((await gw.api.listThreadPullRequests({ threadId: thread })).links[0]?.watchedUntil).toBeDefined();

      fixture.state.running = false;
      fixture.state.conclusion = "FAILURE";
      fixture.state.version++;
      await pollForNotes(gw, fixture, thread, 1);
      await completedNotes(gw, thread, 1);
      await tick(gw, fixture, 150_000);
      await tick(gw, fixture, 150_000);
      expect(await deliveries(gw, thread)).toMatchObject([
        { automatic: false, body: { event: "failure", head_sha: fixture.state.head } },
      ]);

      await setGlobal(gw, false);
      fixture.pushHead("c".repeat(40));
      await pollForNotes(gw, fixture, thread, 2);
      expect(await completedNotes(gw, thread, 2)).toMatchObject([
        { automatic: false, body: { event: "failure" } },
        { automatic: false, body: { event: "failure", head_sha: fixture.state.head } },
      ]);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);

  for (const source of ["agent tool", "branch discovery"]) {
    test(`observes a PR linked through ${source}`, async () => {
      const fixture = pollingFixture();
      fixture.state.running = false;

      const gw = await startTestGateway({
        github: fixture.options,
        worker: { hello: { capabilities: ["git_pr_context_v1"] } },
      });

      try {
        const accountId = await connectGitHub(gw, fixture);
        await gw.api.setGitHubRepositoryAccount({ repositoryName: repo, accountId });

        if (source === "agent tool") {
          await gw.core.githubDetection.stop();
        } else {
          const branch = fixture.discoverBranch();
          gw.worker.handlers.set("readGitPrContext", (_value, reply) =>
            reply(true, {
              gitPrContext: {
                branch,
                headOid: fixture.state.head,
                pushRemote: "origin",
                pushRef: branch,
                remotes: [{ name: "origin", fetchRepositories: [gitRepository], pushRepositories: [gitRepository] }],
              },
            }),
          );
        }

        const thread = await idle(gw, await githubThread(gw));

        if (source === "agent tool") {
          await gw.runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE project_workspaces SET git_origin=${gitRepository} WHERE id=${thread.workspaceId}::uuid`;
            }),
          );

          const link = await gw.worker.callTool({
            threadId: thread.id,
            tool: "link_pull_request",
            args: { pull_request: url },
          });

          expect(link.isError, link.content).toBe(false);
        } else {
          await gw.core.github.run((s) => s.detectionRequest(gw.userId, thread.id));
          await gw.core.githubDetection.tick();
        }

        expect((await gw.api.listThreadPullRequests({ threadId: thread.id })).links[0]).toMatchObject({
          evidence: source === "agent tool" ? "agent_tool" : "branch",
          summary: { ref: { number: 42 } },
        });
        await pollForNotes(gw, fixture, thread.id, 1);
        expect(await completedNotes(gw, thread.id, 1)).toMatchObject([
          { automatic: true, body: { number: 42, counts: { passed: 1 } } },
        ]);
      } finally {
        await gw.close();
        fixture.close();
      }
    }, 90_000);
  }

  test("observes a pull request created from the thread", async () => {
    const fixture = lifecycleFixture();
    fixture.state.mergeable = "CONFLICTING";
    fixture.state.mergeStatus = "DIRTY";

    const gw = await startTestGateway({
      github: fixture.options,
      worker: { hello: { capabilities: ["git_pr_context_v1"] } },
    });

    try {
      await gw.core.githubDetection.stop();
      gw.worker.handlers.set("readGitPrContext", (_value, reply) =>
        reply(true, {
          gitPrContext: {
            branch: fixture.state.branch,
            headOid: fixture.state.head,
            pushRemote: "origin",
            pushRef: fixture.state.branch,
            remotes: [{ name: "origin", fetchRepositories: [gitRepository], pushRepositories: [gitRepository] }],
          },
        }),
      );
      await connectGitHub(gw, fixture);
      const { id: threadId } = await idle(gw, await githubThread(gw));
      const context = await gw.api.getPullRequestCreateContext({ threadId });
      const browser = githubBrowser();
      const request = createRequest(context, Bun.randomUUIDv7(), "A new pull request", "", false, false);
      const confirmation = await gw.api.preparePullRequestMutation(request, browser);

      const result = await gw.api.createPullRequest(
        { ...request, confirmationId: confirmation.confirmationId },
        browser,
      );

      expect(result.createdPullRequest?.number).toBe(100);
      expect((await gw.api.listThreadPullRequests({ threadId })).links[0]?.evidence).toBe("product_create");

      await pollForNotes(gw, fixture, threadId, 1);
      expect(await completedNotes(gw, threadId, 1)).toMatchObject([
        { automatic: true, body: { number: 100, reason: "conflict" } },
      ]);
    } finally {
      await gw.close();
      fixture.close();
    }
  }, 90_000);
});
