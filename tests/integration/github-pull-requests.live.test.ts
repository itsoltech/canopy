import { expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { githubBrowser, githubThread } from "./support/github-pr.ts";
import { startTestGateway } from "./support/gateway.ts";

test.skipIf(process.env["CANOPY_LIVE"] !== "1" || !dockerAvailable)(
  "live read-only PR summary after interactive account connection",
  async () => {
    const gw = await startTestGateway();
    const browser = githubBrowser();
    let account = "";

    try {
      const attempt = (await gw.api.beginGitHubDeviceAuth({ clientRequestId: crypto.randomUUID() }, browser)).attempt;

      if (!attempt) throw new Error("Configure the public GitHub App client ID and slug.");
      console.info(
        `Open ${attempt.verificationUri} and enter ${attempt.userCode}. Connect an account with itsoltech/canopy in its Canopy installation. This test only reads GitHub.`,
      );
      gw.core.github.device.start();
      const expires = Number(attempt.expiresAt!.seconds) * 1000;
      let state = "pending";

      while (state === "pending" && Date.now() < expires) {
        await Bun.sleep(2000);
        const result = (await gw.api.getGitHubDeviceAuth({ attemptId: attempt.id }, browser)).attempt!;
        state = result.state;
        account = result.accountId;
      }

      expect(state).toBe("connected");
      await gw.api.listGitHubInstallations({ accountId: account });
      await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
      const thread = await githubThread(gw);
      const number = Number(process.env["CANOPY_LIVE_GITHUB_PR"] || "485");

      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("CANOPY_LIVE_GITHUB_PR must be a positive PR number.");

      const linked = await gw.api.linkThreadPullRequest({
        threadId: thread,
        url: `https://github.com/itsoltech/canopy/pull/${number}`,
      });

      const ref = linked.links[0]!.summary!.ref!;
      const snapshot = await gw.api.getPullRequest({ pullRequestId: ref.id });
      expect(snapshot.summary!.ref!.repositoryName).toBe("itsoltech/canopy");
      expect(snapshot.summary!.ref!.number).toBe(number);
      expect(snapshot.summary!.title.length).toBeGreaterThan(0);
      console.info(
        `Read itsoltech/canopy #${number}: ${snapshot.completeness}. No GitHub writes performed. The test account will now be disconnected locally.`,
      );
    } finally {
      if (account) await gw.api.disconnectGitHubAccount({ accountId: account });
      await gw.close();
    }
  },
  1_000_000,
);
