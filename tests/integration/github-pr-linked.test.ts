import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { GITHUB_ACCOUNTS, GITHUB_PR, REMOTE_THREADS, THREAD_MIRROR, qualifyId } from "@canopy/domain/computers";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { connectGitHub, githubPrFixture, githubThread } from "./support/github-pr.ts";
import { readFixture } from "./support/github-read.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("linked PR summaries without replicated credentials", () => {
  let a: TestGateway;
  let b: TestGateway;
  let la: ReturnType<typeof linkedComputers>;
  let lb: ReturnType<typeof linkedComputers>;
  let fixture: ReturnType<typeof githubPrFixture>;
  let thread: string;
  let account: string;
  let pr: string;
  const qualified = (id: string) => qualifyId(id, lb.hello().nodeId);
  beforeAll(async () => {
    fixture = readFixture();
    a = await startTestGateway({ role: "desktop", github: { ...fixture.options, clientId: "", slug: "" } });
    b = await startTestGateway({ role: "desktop", github: fixture.options });
    account = await connectGitHub(b, fixture);
    thread = await githubThread(b);
    await b.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });

    const link = await b.api.linkThreadPullRequest({
      threadId: thread,
      url: "https://github.com/itsoltech/canopy/pull/42",
    });

    pr = link.links[0]!.summary!.ref!.id;

    const start = (gw: TestGateway) =>
      linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        capabilities: ["presence", "unlink", REMOTE_THREADS, THREAD_MIRROR, GITHUB_ACCOUNTS, GITHUB_PR],
        serve: remoteServe(uiHandlers(gw.core), gw.core),
      });

    la = start(a);
    lb = start(b);
    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await la.start();
    await lb.start();
    const invitation = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });
    await eventually(
      async () => la.reachable().includes(lb.hello().nodeId),
      (value) => value,
    );
  }, 60_000);
  afterAll(async () => {
    await la?.close();
    await lb?.close();
    await a?.close();
    await b?.close();
    fixture?.close();
  }, 30_000);

  test("A reads B through the home and its small mirror, never receiving account secrets", async () => {
    const data = await a.api.getPullRequest({ pullRequestId: qualified(pr) });
    expect(data.summary!.ref!.id).toBe(qualified(pr));
    expect(data.accountId).toBe(qualified(account));
    expect((await a.api.listPullRequestTimeline({ pullRequestId: qualified(pr) })).items).toHaveLength(50);
    expect((await a.api.listThreadPullRequests({ threadId: qualified(thread) })).links[0]!.summary!.title).toContain(
      "Read-only",
    );
    await eventually(
      async () => (await la.mirror.thread(lb.hello().nodeId, thread))?.newestPullRequest?.ref?.id,
      (id) => id === qualified(pr),
    );
    expect((await a.api.listGitHubAccounts({})).accounts).toHaveLength(0);
    const privateRows = await la.store.query<{ count: string }>("SELECT count(*)::text AS count FROM github_accounts");
    expect(privateRows[0]!.count).toBe("0");
    const output = inspect(data, { depth: null });

    for (const secret of fixture.secrets) expect(output).not.toContain(secret);
  });

  test("GitHub access failures clear PR pages while preserving unrelated verified peer reads", async () => {
    await eventually(
      async () => (await a.api.getOverview({})).workers.some((worker) => worker.nodeId === lb.hello().nodeId),
      (value) => value,
    );
    expect(await failure(a.api.getPullRequest({ pullRequestId: qualified(crypto.randomUUID()) }))).toContain(
      "not found",
    );

    for (const link of [la, lb])
      await link.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
      );

    try {
      await eventually(
        async () => !la.reachable().length && !lb.reachable().length,
        (value) => value,
      );
      expect(await failure(a.api.getPullRequest({ pullRequestId: qualified(pr) }))).toContain("Connect to load");
      expect((await a.api.getOverview({})).workers.some((worker) => worker.nodeId === lb.hello().nodeId)).toBe(true);
    } finally {
      for (const link of [la, lb])
        await link.options.network.update(
          create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
        );
    }

    await eventually(
      async () => la.reachable().includes(lb.hello().nodeId),
      (value) => value,
    );
    await a.api.getPullRequest({ pullRequestId: qualified(pr) });
    await a.api.listPullRequestTimeline({ pullRequestId: qualified(pr) });
  }, 30_000);

  test("offline retains only a dated mirror, rejects writes without replay, and revoke purges the online projection", async () => {
    await la.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
    );
    await lb.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
    );
    await eventually(
      async () => !la.reachable().length && !lb.reachable().length,
      (value) => value,
    );
    const offline = await a.api.listThreadPullRequests({ threadId: qualified(thread) });
    const cachedPage = await a.api.listPullRequestTimeline({ pullRequestId: qualified(pr) });
    expect(cachedPage.page?.stale).toBe(true);
    expect(cachedPage.items).toHaveLength(50);
    expect((await a.api.getPullRequest({ pullRequestId: qualified(pr) })).stale).toBe(true);
    expect(await failure(a.api.listPullRequestTimeline({ pullRequestId: qualified(pr), kind: "commit" }))).toContain(
      "Connect to load",
    );
    expect(offline.stale).toBe(true);
    expect(offline.links[0]!.summary!.verifiedAt).toBeDefined();
    expect(
      await failure(
        a.api.unlinkThreadPullRequest({
          threadId: qualified(thread),
          pullRequestId: qualified(pr),
          expectedRevision: offline.revision,
        }),
      ),
    ).toBeTruthy();
    expect((await b.api.listThreadPullRequests({ threadId: thread })).links).toHaveLength(1);
    await la.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
    );
    await lb.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
    );
    await eventually(
      async () => la.reachable().includes(lb.hello().nodeId),
      (value) => value,
    );
    await b.api.disconnectGitHubAccount({ accountId: account });
    await eventually(
      async () => (await la.mirror.thread(lb.hello().nodeId, thread))?.newestPullRequest,
      (value) => !value,
    );
    expect((await a.api.listThreadPullRequests({ threadId: qualified(thread) })).links[0]!.summary!.title).toBe("");
    expect(await failure(a.api.getPullRequest({ pullRequestId: qualified(pr) }))).toContain("Reconnect");
  });
});
