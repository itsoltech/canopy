import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { connectGitHub, githubPrData, githubPrFixture, githubThread } from "./support/github-pr.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("automatic archival after every linked PR merges", () => {
  let gw: TestGateway;
  let fixture: ReturnType<typeof githubPrFixture>;
  let account: string;
  beforeEach(async () => {
    fixture = githubPrFixture();
    gw = await startTestGateway({ github: fixture.options });
    account = await connectGitHub(gw, fixture);
    await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
  }, 60_000);
  afterEach(async () => {
    await gw?.close();
    fixture?.close();
  });

  const sql = (query: string, values: readonly (string | boolean)[] = []) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (db) => db.unsafe(query, values)));

  const globalPolicy = async (value: boolean) => {
    const settings = (await gw.api.getSettings({})).user!;
    await gw.api.updateUserSettings({
      expectedVersion: settings.version,
      threadDefaults: { ...settings.threadDefaults!, autoArchiveOnMerge: value },
    });
  };

  const projectPolicy = async (project: string, value?: boolean) => {
    const settings = (await gw.api.getSettings({})).projects.find((p) => p.projectId === project);
    await gw.api.updateProjectSettings({
      projectId: project,
      expectedVersion: settings?.version ?? 0n,
      threadDefaults: { ...create(ui.ThreadDefaultsSchema), autoArchiveOnMerge: value },
    });
  };

  const linked = async (...numbers: number[]) => {
    const id = await githubThread(gw);
    await waitFor(async () => (await gw.api.getThread({ threadId: id })).thread?.status === "idle");

    for (const number of numbers) {
      const current = await gw.api.listThreadPullRequests({ threadId: id });
      await gw.api.linkThreadPullRequest({
        threadId: id,
        expectedRevision: current.revision,
        url: `https://github.com/itsoltech/canopy/pull/${number}`,
      });
    }

    return (await gw.api.getThread({ threadId: id })).thread!;
  };

  const waitFor = (read: () => Promise<boolean>) => eventually(read, Boolean);

  const archived = async (id: string) => Boolean((await gw.api.getThread({ threadId: id })).thread!.archivedAt);
  const sweep = () => gw.core.github.background.tick();

  test("default is off; global changes apply to existing threads and version conflicts reject stale writes", async () => {
    const thread = await linked(43);
    await sweep();
    expect(await archived(thread.id)).toBe(false);
    const old = (await gw.api.getSettings({})).user!;
    await globalPolicy(true);
    expect(
      await failure(gw.api.updateUserSettings({ expectedVersion: old.version, threadDefaults: old.threadDefaults })),
    ).toContain("settings changed elsewhere");
    await sweep();
    expect(await archived(thread.id)).toBe(true);
    expect((await gw.api.getThread({ threadId: thread.id })).thread!.archivedBy).toBe("merge");
    expect(
      await sql("SELECT id FROM audit_log WHERE target_id=$1::uuid AND action='thread.auto_archive_on_merge'", [
        thread.id,
      ]),
    ).toHaveLength(1);
    await sweep();
    expect(
      await sql("SELECT id FROM audit_log WHERE target_id=$1::uuid AND action='thread.auto_archive_on_merge'", [
        thread.id,
      ]),
    ).toHaveLength(1);
  });

  test("an expired summary refreshed in the background records the merge before cache eviction", async () => {
    await globalPolicy(true);
    const thread = await linked(42);
    fixture.pullRequest((number) => githubPrData(number, "MERGED"));
    fixture.advance(65_000);
    const stale = await gw.core.github.prs.load("itsoltech/canopy", 42);
    expect(stale.summary?.state).toBe("open");
    expect(stale.stale).toBe(true);
    await waitFor(async () =>
      (await gw.core.github.run((s) => s.mergeArchiveThreads(gw.userId))).some((t) => t.id === thread.id),
    );
    await sql("DELETE FROM github_pr_cache WHERE owner_user_id=$1::uuid", [gw.userId]);
    await sweep();
    expect(await archived(thread.id)).toBe(true);
  });

  test("the sweep rechecks a cached merge when the last complete summary still says open", async () => {
    await globalPolicy(true);
    const thread = await linked(43);
    await sql(
      `UPDATE github_pull_requests SET summary=jsonb_set(summary,'{state}','"open"')
       WHERE owner_user_id=$1::uuid AND number=43`,
      [gw.userId],
    );
    fixture.partial(true);
    await sweep();
    expect(await archived(thread.id)).toBe(false);
    fixture.partial(false);
    await sweep();
    expect(await archived(thread.id)).toBe(true);
  });

  test("project and thread explicit false win; resetting either restores dynamic inheritance", async () => {
    await globalPolicy(true);
    const thread = await linked(43);
    await projectPolicy(thread.projectId, false);
    await sweep();
    expect(await archived(thread.id)).toBe(false);
    await gw.api.updateThread({ threadId: thread.id, autoArchiveOnMerge: true });
    await sweep();
    expect(await archived(thread.id)).toBe(true);
    await gw.api.setThreadArchived({ threadId: thread.id, archived: false });
    expect((await gw.api.getThread({ threadId: thread.id })).thread!.autoArchiveOnMerge).toBe(false);
    await projectPolicy(thread.projectId);
    expect(
      (await gw.api.getSettings({})).projects.find((p) => p.projectId === thread.projectId)!.threadDefaults!
        .autoArchiveOnMerge,
    ).toBeUndefined();
    await sweep();
    expect(await archived(thread.id)).toBe(false);
    expect(
      await failure(
        gw.api.updateThread({ threadId: thread.id, autoArchiveOnMerge: false, resetAutoArchiveOnMerge: true }),
      ),
    ).toContain("Choose an override");
    await gw.api.updateThread({ threadId: thread.id, resetAutoArchiveOnMerge: true });
    expect(
      (await gw.api.listThreads({ projectId: thread.projectId })).threads.find((t) => t.id === thread.id)!
        .autoArchiveOnMerge,
    ).toBeUndefined();
    await sweep();
    expect(await archived(thread.id)).toBe(true);
  });

  test("all active links must be merged; closed-only and no links never qualify; unlink removes a blocker", async () => {
    await globalPolicy(true);
    const mixed = await linked(43, 44);
    const closed = await linked(44);
    const empty = await linked();
    await sweep();
    expect(await archived(mixed.id)).toBe(false);
    expect(await archived(closed.id)).toBe(false);
    expect(await archived(empty.id)).toBe(false);
    const links = await gw.api.listThreadPullRequests({ threadId: mixed.id });
    const blocker = links.links.find((l) => l.summary?.ref?.number === 44)!.summary!.ref!.id;
    await gw.api.unlinkThreadPullRequest({
      threadId: mixed.id,
      pullRequestId: blocker,
      expectedRevision: links.revision,
    });
    await sweep();
    expect(await archived(mixed.id)).toBe(true);
    expect(await archived(closed.id)).toBe(false);
  });

  test("running and queued work is left intact until idle, then the durable sweep archives", async () => {
    await globalPolicy(true);
    const thread = await linked(43);
    gw.worker.holdTurns = true;

    try {
      const first = (
        await gw.api.sendMessage({ threadId: thread.id, text: "First", clientRequestId: crypto.randomUUID() })
      ).turn!;

      await waitFor(async () => (await gw.api.getThread({ threadId: thread.id })).thread!.status === "running");

      const second = (
        await gw.api.sendMessage({ threadId: thread.id, text: "Second", clientRequestId: crypto.randomUUID() })
      ).turn!;

      await sweep();
      expect(await archived(thread.id)).toBe(false);
      gw.worker.finish(thread.id, first.id);
      await waitFor(
        async () => (await gw.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(thread.id))))?.id === second.id,
      );
      await sweep();
      expect(await archived(thread.id)).toBe(false);
      gw.worker.finish(thread.id, second.id);
      await waitFor(async () => (await gw.api.getThread({ threadId: thread.id })).thread!.status === "idle");
      await sweep();
      expect(await archived(thread.id)).toBe(true);
      expect(
        await sql("SELECT id FROM worker_commands WHERE thread_id=$1::uuid AND kind='interruptTurn'", [thread.id]),
      ).toHaveLength(0);
    } finally {
      gw.worker.holdTurns = false;
    }
  });

  test("busy cascade child defers its parent; restoring the automatic cascade keeps both usable", async () => {
    await globalPolicy(true);
    const parent = await linked(43);

    const child = (
      await gw.api.createThread({
        projectId: parent.projectId,
        parentThreadId: parent.id,
        workspaceId: parent.workspaceId,
        provider: Provider.CODEX,
        title: "Busy child",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

    await waitFor(async () => (await gw.api.getThread({ threadId: child.id })).thread!.status === "idle");
    await sql(
      "INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq) VALUES ($1::uuid,'background','background_task','in_progress','{}'::jsonb,1,1)",
      [child.id],
    );
    await sweep();
    expect(await archived(parent.id)).toBe(false);
    await sql("DELETE FROM thread_items WHERE thread_id=$1::uuid", [child.id]);
    await sweep();
    expect(await archived(parent.id)).toBe(true);
    expect((await gw.api.getThread({ threadId: child.id })).thread!.archivedBy).toBe("cascade");
    await gw.api.setThreadArchived({ threadId: parent.id, archived: false });
    await sweep();
    expect(await archived(parent.id)).toBe(false);
    expect(await archived(child.id)).toBe(false);
    expect((await gw.api.getThread({ threadId: child.id })).thread!.autoArchiveOnMerge).toBe(false);
  });

  test("incomplete, failed and disconnected evidence never qualifies; cache eviction preserves a complete merge", async () => {
    await globalPolicy(true);
    const thread = await linked(43);
    fixture.status(403);
    await sql(
      "UPDATE github_pull_requests SET refresh_detail='Access unavailable' WHERE owner_user_id=$1::uuid AND number=43",
      [gw.userId],
    );
    await sweep();
    expect(await archived(thread.id)).toBe(false);
    fixture.status(200);
    fixture.partial(true);
    await sql("DELETE FROM github_pr_cache WHERE owner_user_id=$1::uuid", [gw.userId]);
    await sql(
      "UPDATE github_pull_requests SET refresh_detail='', summary=NULL WHERE owner_user_id=$1::uuid AND number=43",
      [gw.userId],
    );
    await sweep();
    expect(await archived(thread.id)).toBe(false);
    fixture.partial(false);
    const pr = (await gw.api.listThreadPullRequests({ threadId: thread.id })).links[0]!.summary!.ref!.id;
    await gw.api.getPullRequest({ pullRequestId: pr, refresh: true });
    await gw.api.disconnectGitHubAccount({ accountId: account });
    await sweep();
    expect(await archived(thread.id)).toBe(false);
    account = await connectGitHub(gw, fixture);
    await gw.api.getPullRequest({ pullRequestId: pr, refresh: true });
    await sql("DELETE FROM github_pr_cache WHERE owner_user_id=$1::uuid", [gw.userId]);
    await sweep();
    expect(await archived(thread.id)).toBe(true);
  });

  for (const access of ["removed", "suspended"])
    test(`a ${access} installation blocks archival of a previously confirmed merge after work finishes`, async () => {
      await globalPolicy(true);
      const thread = await linked(43);
      gw.worker.holdTurns = true;

      try {
        const turn = (
          await gw.api.sendMessage({
            threadId: thread.id,
            text: "Finishing work",
            clientRequestId: crypto.randomUUID(),
          })
        ).turn!;

        await waitFor(async () => (await gw.api.getThread({ threadId: thread.id })).thread!.status === "running");
        await sweep();
        expect(await archived(thread.id)).toBe(false);

        if (access === "removed")
          await sql(
            "DELETE FROM github_installation_repositories WHERE owner_user_id=$1::uuid AND account_id=$2::uuid AND repository_id='777'",
            [gw.userId, account],
          );
        else
          await sql(
            "UPDATE github_installations SET suspended=true WHERE owner_user_id=$1::uuid AND account_id=$2::uuid",
            [gw.userId, account],
          );

        gw.worker.finish(thread.id, turn.id);
        await waitFor(async () => (await gw.api.getThread({ threadId: thread.id })).thread!.status === "idle");
        await sweep();
        expect(await archived(thread.id)).toBe(false);
        await gw.core.github.catalogue.refresh(account, true);
        await sweep();
        expect(await archived(thread.id)).toBe(true);
      } finally {
        gw.worker.holdTurns = false;
      }
    });

  test("another owner's defaults, overrides and poller cannot modify this owner's thread", async () => {
    await globalPolicy(false);
    const thread = await linked(43);

    const owner = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("merge-owner@example.test", "Other owner")),
    );

    const foreign = new GatewayCore({
      runtime: gw.runtime,
      userId: owner,
      instanceId: "foreign-archive",
      sshSecretsKey: gw.secretsKey,
      github: fixture.options,
    });

    try {
      await foreign.updateUserSettings(
        create(ui.UpdateUserSettingsRequestSchema, {
          expectedVersion: 0n,
          threadDefaults: { autoArchiveOnMerge: true },
        }),
      );
      await expect(
        foreign.updateThread(create(ui.UpdateThreadRequestSchema, { threadId: thread.id, autoArchiveOnMerge: true })),
      ).rejects.toThrow();
      await expect(
        foreign.updateProjectSettings(
          create(ui.UpdateProjectSettingsRequestSchema, {
            projectId: thread.projectId,
            threadDefaults: { autoArchiveOnMerge: true },
          }),
        ),
      ).rejects.toThrow();
      expect(await foreign.github.run((s) => s.mergeArchiveThreads(owner))).toHaveLength(0);
      expect(await foreign.github.run((s) => s.mergeArchivePullRequests(owner))).toHaveLength(0);
      await foreign.github.background.tick();
      await sweep();
      expect(await archived(thread.id)).toBe(false);
      expect((await gw.api.getThread({ threadId: thread.id })).thread!.autoArchiveOnMerge).toBeUndefined();
    } finally {
      await foreign.stopSweep();
    }
  });
});
