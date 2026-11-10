import { test, expect } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import {
  GITHUB_ACCOUNTS,
  GITHUB_PR,
  GITHUB_COMMENTS,
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
import { mutationFixture } from "./support/github-mutations.ts";

test.skipIf(!dockerAvailable)(
  "linked home binds mutations, qualifies confirmation IDs and refuses offline replay",
  async () => {
    const fixture = mutationFixture();
    const a = await startTestGateway({ role: "desktop", github: { ...fixture.options, clientId: "", slug: "" } });
    const b = await startTestGateway({ role: "desktop", github: fixture.options });

    const start = (gw: TestGateway) =>
      linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        capabilities: [
          "presence",
          "unlink",
          REMOTE_THREADS,
          THREAD_MIRROR,
          GITHUB_ACCOUNTS,
          GITHUB_PR,
          GITHUB_COMMENTS,
        ],
        serve: remoteServe(uiHandlers(gw.core), gw.core),
      });

    const la = start(a),
      lb = start(b),
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

      const r = mutationRequest(snapshot, crypto.randomUUID(), "create_comment", {
        body: "Explicitly posted at the linked home",
      });

      const receipt = await a.api.createPullRequestComment(r, browser);
      expect(receipt.state).toBe("succeeded");

      const remove = mutationRequest(snapshot, crypto.randomUUID(), "delete_comment", {
        resourceId: receipt.upstreamId,
        commentKind: "issue",
      });

      const prepared = await a.api.preparePullRequestMutation(remove, browser);
      expect(prepared.confirmationId).toContain("~");
      expect(
        (await a.api.deletePullRequestComment({ ...remove, confirmationId: prepared.confirmationId }, browser)).state,
      ).toBe("succeeded");

      const aRows = await la.store.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM github_mutation_receipts",
      );

      expect(aRows[0]?.count).toBe("0");
      await la.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
      );
      await lb.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
      );
      await eventually(async () => !la.reachable().length && !lb.reachable().length, Boolean);
      const before = fixture.writes;
      expect(
        await failure(
          a.api.setPullRequestFileViewed(
            mutationRequest(snapshot, crypto.randomUUID(), "viewed", { path: "src/safe.ts", viewed: true }),
            browser,
          ),
        ),
      ).toBeTruthy();
      await la.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
      );
      await lb.options.network.update(
        create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
      );
      await eventually(async () => la.reachable().includes(lb.hello().nodeId), Boolean);
      expect(fixture.writes).toBe(before);
      expect(
        (await a.api.getPullRequestMutation({ pullRequestId: id, clientRequestId: r.clientRequestId }, browser)).state,
      ).toBe("succeeded");
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
