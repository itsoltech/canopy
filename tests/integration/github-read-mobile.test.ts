import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { SERVICE_TOKEN, failure, startTestGateway } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { pollingFixture } from "./support/github-polling.ts";

describe.skipIf(!dockerAvailable)("GitHub full read over paired mobile transport", () => {
  test("reads pages, logs and code, watches and prepares context through a revocable pinned device", async () => {
    const fixture = pollingFixture(true);
    const gw = await startTestGateway({ github: fixture.options });

    const network = new NetworkAccess({
      store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
      host: "127.0.0.1",
    });

    gw.core.network = network;
    const unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    const controller = new AbortController();

    try {
      const { pr, thread } = await linkedRead(gw, fixture);
      await network.start();
      await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
      const transport = nodePinnedTransport();

      const native = (token?: string) =>
        routedMobileClient({
          connection: gw.core.mobile.networkRoutes(),
          ...(token && { token }),
          transport,
        });

      const pairing = await gw.api.createMobilePairing({});

      const paired = await native().pairing.exchangeMobilePairing({
        code: pairing.code,
        name: "Fixture phone",
        platform: "ios",
      });

      const api = native(paired.deviceToken).api;
      let cursor = "";
      let count = 0;

      do {
        const page = await api.listPullRequestTimeline({ pullRequestId: pr, cursor });
        count += page.items.length;
        cursor = page.page?.nextCursor ?? "";
      } while (cursor);

      expect(count).toBe(153);
      const checks = await api.listPullRequestChecks({ pullRequestId: pr });
      expect(checks.page?.nextCursor).toBeTruthy();
      const jobs = await api.listPullRequestCheckJobs({ pullRequestId: pr, resourceId: "123" });
      expect(jobs.jobs).toHaveLength(30);
      const log = await api.getPullRequestJobLog({ pullRequestId: pr, resourceId: "1" });
      expect(log.text).toContain("[redacted]");
      expect(log.text).not.toContain("private-value");
      const files = await api.listPullRequestFiles({ pullRequestId: pr });
      expect(files.files).toHaveLength(30);
      const patch = await api.getPullRequestDiff({ pullRequestId: pr, path: "src/safe.ts", resourceId: "1" });
      expect(patch.patch).toContain("+new");

      for await (const update of api.watchPullRequest(
        { pullRequestId: pr, visibility: "view" },
        { signal: controller.signal },
      )) {
        expect(update.snapshot?.summary?.ref?.id).toBe(pr);
        break;
      }

      controller.abort();
      const context = await api.preparePullRequestContext({ pullRequestId: pr, threadId: thread, action: "question" });
      const attachment = await api.getAttachment({ attachmentId: context.attachment!.id });
      expect(Buffer.from(attachment.data).toString()).toContain("Untrusted GitHub data");
      await gw.api.revokeMobileDevice({ id: paired.device!.id });
      expect(await failure(api.listPullRequestTimeline({ pullRequestId: pr }))).toContain("Invalid or revoked");
    } finally {
      controller.abort();
      unmount();
      await network.close();
      await gw.close();
      fixture.close();
    }
  }, 60_000);
});
