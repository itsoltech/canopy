import { test, expect } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { github, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { mutationRequest } from "@canopy/domain/github-mutations";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { SERVICE_TOKEN, startTestGateway, failure } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { ciFixture } from "./support/github-ci.ts";

test.skipIf(!dockerAvailable)(
  "pinned iOS and Android control CI explicitly; confirmations and receipts are device-bound",
  async () => {
    const fixture = ciFixture(),
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

      const rerun = (rerunMode: github.PullRequestRerunMode) =>
        mutationRequest(snapshot, crypto.randomUUID(), "rerun_checks", {
          runId: "123",
          runAttempt: 1,
          rerunMode,
          ...(rerunMode === github.PullRequestRerunMode.SINGLE_JOB && { jobId: "456" }),
        });

      const r = rerun(github.PullRequestRerunMode.FAILED_JOBS);
      expect((await ios.api.rerunPullRequestChecks(r)).state).toBe("accepted");
      expect((await android.api.rerunPullRequestChecks(rerun(github.PullRequestRerunMode.ALL_JOBS))).state).toBe(
        "accepted",
      );
      expect((await ios.api.rerunPullRequestChecks(rerun(github.PullRequestRerunMode.SINGLE_JOB))).state).toBe(
        "accepted",
      );
      expect(
        await failure(android.api.getPullRequestMutation({ pullRequestId: pr, clientRequestId: r.clientRequestId })),
      ).toContain("not found");
      fixture.state.status = "in_progress";
      const cancel = mutationRequest(snapshot, crypto.randomUUID(), "cancel_run", { runId: "123", runAttempt: 1 });
      const confirmation = await android.api.preparePullRequestMutation(cancel);
      expect(
        await failure(ios.api.cancelPullRequestCheckRun({ ...cancel, confirmationId: confirmation.confirmationId })),
      ).toBeTruthy();
      expect(
        (await android.api.cancelPullRequestCheckRun({ ...cancel, confirmationId: confirmation.confirmationId })).state,
      ).toBe("accepted");
      expect((await ios.api.listPullRequestChecks({ pullRequestId: pr, refresh: true })).checks[0]?.state).toBe(
        "in_progress",
      );
      const before = fixture.state.writes.length;
      await gw.api.revokeMobileDevice({ id: ios.id });
      expect(await failure(ios.api.rerunPullRequestChecks(rerun(github.PullRequestRerunMode.ALL_JOBS)))).toContain(
        "Invalid or revoked",
      );
      expect(fixture.state.writes.length).toBe(before);
    } finally {
      unmount();
      await network.close();
      await gw.close();
      fixture.close();
    }
  },
  60_000,
);
