import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { dockerAvailable } from "@canopy/db/testing";
import { startTestGateway } from "./support/gateway.ts";

const enabled = process.env["CANOPY_LIVE"] === "1";

test.skipIf(!enabled || !dockerAvailable)(
  "live GitHub App device authorization (interactive)",
  async () => {
    const gw = await startTestGateway();
    const options = { headers: { "canopy-github-client": randomBytes(32).toString("base64url") } };

    try {
      const started = await gw.api.beginGitHubDeviceAuth({ clientRequestId: crypto.randomUUID() }, options);

      if (!started.configured || !started.attempt)
        throw new Error("Configure the public GitHub App client ID and slug.");
      const attempt = started.attempt;
      // Only the public user code is shown; device codes and tokens must never be printed.
      console.info(`Open ${attempt.verificationUri} and enter ${attempt.userCode}. Waiting for authorization…`);
      gw.core.github.device.start();
      const expires = Number(attempt.expiresAt!.seconds) * 1000;
      let state = "pending";

      while (state === "pending" && Date.now() < expires) {
        await Bun.sleep(2000);
        state = (await gw.api.getGitHubDeviceAuth({ attemptId: attempt.id }, options)).attempt!.state;
      }

      expect(state).toBe("connected");
      const accounts = await gw.api.listGitHubAccounts({});
      expect(accounts.accounts).toHaveLength(1);
      await gw.api.listGitHubInstallations({ accountId: accounts.accounts[0]!.id, refresh: true });
      await gw.api.disconnectGitHubAccount({ accountId: accounts.accounts[0]!.id });
    } finally {
      await gw.close();
    }
  },
  1_000_000,
);
