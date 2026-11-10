import { test, expect } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { mutationRequest } from "@canopy/domain/github-mutations";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { SERVICE_TOKEN, startTestGateway, failure } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { reviewFixture } from "./support/github-review.ts";
import { reviewRevision } from "@canopy/domain/github-review";

test.skipIf(!dockerAvailable)(
  "two pinned mobile devices mutate explicitly and read GitHub Viewed; revocation blocks writes",
  async () => {
    const fixture = reviewFixture(),
      gw = await startTestGateway({ github: fixture.options });

    const network = new NetworkAccess({
      store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
      host: "127.0.0.1",
    });

    gw.core.network = network;
    const unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);

    try {
      const { pr } = await linkedRead(gw, fixture);
      await network.start();
      await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
      const transport = nodePinnedTransport();

      const native = (token?: string) =>
        routedMobileClient({ connection: gw.core.mobile.networkRoutes(), ...(token && { token }), transport });

      const pair = async (platform: string) => {
        const code = await gw.api.createMobilePairing({});

        const result = await native().pairing.exchangeMobilePairing({
          code: code.code,
          name: `Fixture ${platform}`,
          platform,
        });

        return { api: native(result.deviceToken).api, id: result.device!.id };
      };

      const ios = await pair("ios"),
        android = await pair("android");

      const snapshot = await ios.api.getPullRequest({ pullRequestId: pr });

      const r = mutationRequest(snapshot, crypto.randomUUID(), "create_comment", {
        body: "Posted from a paired phone",
      });

      const receipt = await ios.api.createPullRequestComment(r);
      expect(receipt.state).toBe("succeeded");
      expect(
        (await android.api.listPullRequestTimeline({ pullRequestId: pr, refresh: true })).items.some(
          (i) => i.content.value?.id === receipt.upstreamId,
        ),
      ).toBe(true);
      expect(
        await failure(android.api.getPullRequestMutation({ pullRequestId: pr, clientRequestId: r.clientRequestId })),
      ).toContain("not found");
      expect(
        (
          await ios.api.setPullRequestFileViewed(
            mutationRequest(snapshot, crypto.randomUUID(), "viewed", { path: "src/safe.ts", viewed: true }),
          )
        ).state,
      ).toBe("succeeded");
      expect(
        (await android.api.listPullRequestFiles({ pullRequestId: pr, refresh: true })).files[0]?.viewerViewedState,
      ).toBe("VIEWED");
      expect(
        (
          await android.api.setPullRequestFileViewed(
            mutationRequest(snapshot, crypto.randomUUID(), "viewed", { path: "src/safe.ts", viewed: false }),
          )
        ).state,
      ).toBe("succeeded");
      expect(
        (await ios.api.listPullRequestFiles({ pullRequestId: pr, refresh: true })).files[0]?.viewerViewedState,
      ).toBe("UNVIEWED");

      const inline = mutationRequest(snapshot, crypto.randomUUID(), "add_review_comment", {
        body: "Phone range",
        path: "src/safe.ts",
        side: "RIGHT",
        line: 10,
        startSide: "RIGHT",
        startLine: 8,
        commitSha: snapshot.summary!.headSha,
        sourcePage: 1,
      });

      expect((await ios.api.addPullRequestReviewComment(inline)).state).toBe("succeeded");
      const pending = await android.api.getPullRequestReviewDraft({ pullRequestId: pr, refresh: true });
      expect(pending.totalCount).toBe(1);
      expect(pending.comments[0]).toMatchObject({ side: "RIGHT", startLine: 8, line: 10 });
      expect(
        (
          await android.api.submitPullRequestReview(
            mutationRequest(snapshot, crypto.randomUUID(), "submit_review", {
              resourceId: pending.id,
              reviewRevision: reviewRevision([pending]),
              verdict: "APPROVE",
              body: "Reviewed on another phone",
            }),
          )
        ).state,
      ).toBe("succeeded");
      expect((await ios.api.getPullRequestReviewDraft({ pullRequestId: pr, refresh: true })).id).toBe("");
      await gw.api.revokeMobileDevice({ id: ios.id });
      const before = fixture.writes;
      expect(
        await failure(
          ios.api.createPullRequestComment(
            mutationRequest(snapshot, crypto.randomUUID(), "create_comment", { body: "Revoked phone" }),
          ),
        ),
      ).toContain("Invalid or revoked");
      expect(fixture.writes).toBe(before);
      expect(
        await failure(ios.api.addPullRequestReviewComment({ ...inline, clientRequestId: crypto.randomUUID() })),
      ).toContain("Invalid or revoked");
    } finally {
      unmount();
      await network.close();
      await gw.close();
      fixture.close();
    }
  },
  60_000,
);
