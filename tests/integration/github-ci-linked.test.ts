import { test, expect } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { github, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import {
  GITHUB_ACCOUNTS,
  GITHUB_PR,
  GITHUB_COMMENTS,
  GITHUB_WRITE,
  REMOTE_THREADS,
  THREAD_MIRROR,
  qualifyId,
} from "@canopy/domain/computers";
import { mutationRequest } from "@canopy/domain/github-mutations";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { startTestGateway, eventually, failure, type TestGateway } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { githubBrowser } from "./support/github-pr.ts";
import { ciFixture } from "./support/github-ci.ts";

test.skipIf(!dockerAvailable)(
  "CI writes stay at the linked home, bind confirmation and require both capabilities",
  async () => {
    const fixture = ciFixture();
    const a = await startTestGateway({ role: "desktop", github: { ...fixture.options, clientId: "", slug: "" } });
    const b = await startTestGateway({ role: "desktop", github: fixture.options });

    const caps = () => [
      "presence",
      "unlink",
      REMOTE_THREADS,
      THREAD_MIRROR,
      GITHUB_ACCOUNTS,
      GITHUB_PR,
      GITHUB_COMMENTS,
      GITHUB_WRITE,
    ];

    const aCaps = caps(),
      bCaps = caps();

    const start = (gw: TestGateway, capabilities: string[]) =>
      linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        capabilities,
        serve: remoteServe(uiHandlers(gw.core), gw.core),
      });

    const la = start(a, aCaps),
      lb = start(b, bCaps),
      browser = githubBrowser();

    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;

    try {
      const { pr } = await linkedRead(b, fixture);
      await la.start();
      await lb.start();
      const invitation = await a.api.createComputerPairing({});
      await b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });
      await eventually(async () => la.reachable().includes(lb.hello().nodeId), Boolean);
      const id = qualifyId(pr, lb.hello().nodeId);
      const snapshot = await a.api.getPullRequest({ pullRequestId: id });

      const rerun = () =>
        mutationRequest(snapshot, crypto.randomUUID(), "rerun_checks", {
          runId: "123",
          jobId: "456",
          runAttempt: 1,
          rerunMode: github.PullRequestRerunMode.SINGLE_JOB,
        });

      const r = rerun();
      expect((await a.api.rerunPullRequestChecks(r, browser)).state).toBe("accepted");
      const jobs = await a.api.listPullRequestCheckJobs({ pullRequestId: id, resourceId: "123", refresh: true });
      expect(jobs.run?.id).toBe("123");
      expect(jobs.jobs[0]?.id).toBe("456");
      fixture.state.status = "in_progress";
      const cancel = mutationRequest(snapshot, crypto.randomUUID(), "cancel_run", { runId: "123", runAttempt: 1 });
      const confirmation = await a.api.preparePullRequestMutation(cancel, browser);
      expect(confirmation.confirmationId).toContain("~");
      expect(
        (await a.api.cancelPullRequestCheckRun({ ...cancel, confirmationId: confirmation.confirmationId }, browser))
          .state,
      ).toBe("accepted");
      expect(
        await failure(
          a.api.getPullRequestMutation({ pullRequestId: id, clientRequestId: r.clientRequestId }, githubBrowser()),
        ),
      ).toContain("not found");
      expect(
        (await la.store.query<{ count: string }>("SELECT count(*)::text AS count FROM github_mutation_receipts"))[0]
          ?.count,
      ).toBe("0");
      fixture.state.status = "completed";
      const before = fixture.state.writes.length;
      aCaps.splice(aCaps.indexOf(GITHUB_WRITE), 1);
      expect(await failure(a.api.rerunPullRequestChecks(rerun(), browser))).toBeTruthy();
      aCaps.push(GITHUB_WRITE);
      bCaps.splice(bCaps.indexOf(GITHUB_WRITE), 1);
      expect(await failure(a.api.rerunPullRequestChecks(rerun(), browser))).toBeTruthy();
      bCaps.push(GITHUB_WRITE);
      await la.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
      );
      await lb.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
      );
      await eventually(async () => !la.reachable().length && !lb.reachable().length, Boolean);
      expect(await failure(a.api.rerunPullRequestChecks(rerun(), browser))).toBeTruthy();
      await la.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
      );
      await lb.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
      );
      await eventually(async () => la.reachable().includes(lb.hello().nodeId), Boolean);
      expect(fixture.state.writes.length).toBe(before);
      expect(
        (await a.api.getPullRequestMutation({ pullRequestId: id, clientRequestId: r.clientRequestId }, browser)).state,
      ).toBe("accepted");
    } finally {
      await la.close();
      await lb.close();
      await a.close();
      await b.close();
      fixture.close();
    }
  },
  60_000,
);
