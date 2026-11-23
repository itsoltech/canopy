import { expect, test } from "bun:test";
import { DeviceLogin, Provider, ProviderConfigurationMode, ProviderProfileKind } from "@canopy/contracts";
import { CLAUDE_USER_CONFIGURATION_CAPABILITY, CODEX_CLI_HOME_CAPABILITY } from "@canopy/domain/release/protocol";
import { connectWorker, startGateway, take } from "./helpers.ts";

for (const claudeSupported of [false, true]) {
  test(`WorkerLink negotiates independent Claude and Codex policies on initial config and pushes (${claudeSupported ? "Claude" : "Codex"})`, async () => {
    const configuration = {
      version: 7n,
      profiles: [
        {
          id: "configured",
          providers: [Provider.CLAUDE],
          kind: ProviderProfileKind.NATIVE,
          userConfiguration: { mode: ProviderConfigurationMode.SHARED, sourcePath: "~/claude" },
        },
        {
          id: "configured-codex",
          providers: [Provider.CODEX],
          kind: ProviderProfileKind.NATIVE,
          userConfiguration: { mode: ProviderConfigurationMode.SHARED },
        },
        { id: "native", providers: [Provider.CODEX], kind: ProviderProfileKind.NATIVE },
        {
          id: "all-harnesses",
          kind: ProviderProfileKind.NATIVE,
          userConfiguration: { mode: ProviderConfigurationMode.LOCAL },
        },
      ],
    };

    const gateway = await startGateway({ link: { config: async () => configuration } });

    const worker = await connectWorker(gateway.server.url, {
      hello: {
        workerId: "worker-1",
        configVersion: configuration.version,
        capabilities: [claudeSupported ? CLAUDE_USER_CONFIGURATION_CAPABILITY : CODEX_CLI_HOME_CAPABILITY],
      },
    });

    try {
      const connection = await gateway.nextConnection();
      const [initial] = await take(worker.messages, 1);

      expect(initial?.payload.case).toBe("config");

      if (initial?.payload.case !== "config") throw new Error("Expected initial configuration.");
      expect(initial.payload.value.profiles[0]?.disabled).toBe(!claudeSupported);
      expect(initial.payload.value.profiles[1]?.disabled).toBe(claudeSupported);
      expect(initial.payload.value.profiles[2]?.disabled).toBe(false);
      expect(initial.payload.value.profiles[3]?.disabled).toBe(!claudeSupported);
      expect(configuration.profiles[0]).not.toHaveProperty("disabled");
      gateway.link.pushConfig("worker-1", { ...configuration, version: 8n });
      const [pushed] = await take(worker.messages, 1);

      expect(pushed?.payload.case).toBe("config");

      if (pushed?.payload.case !== "config") throw new Error("Expected updated configuration.");
      expect(pushed.payload.value.profiles[0]?.disabled).toBe(!claudeSupported);
      expect(pushed.payload.value.profiles[1]?.disabled).toBe(claudeSupported);
      worker.send({
        case: "configApplied",
        value: {
          version: 8n,
          applied: true,
          profiles: [
            {
              id: "configured",
              providers: [Provider.CLAUDE],
              available: claudeSupported,
              detail: claudeSupported ? "" : "disabled",
            },
            { id: "configured-codex", providers: [Provider.CODEX], available: !claudeSupported },
            { id: "native", providers: [Provider.CODEX], available: true },
          ],
        },
      });
      const [reported] = await take(connection.messages, 1);

      if (reported?.payload.case !== "configApplied") throw new Error("Expected configuration report.");
      expect(reported.payload.value.profiles[0]?.detail).toBe(
        claudeSupported ? "" : "Update this worker to use local or shared Claude configuration.",
      );
      expect(reported.payload.value.profiles[1]?.detail).toBe(
        claudeSupported ? "Update this worker to use the Codex CLI home." : "",
      );
      expect(reported.payload.value.profiles[2]?.available).toBe(true);
      gateway.link.pushConfig("worker-1", {
        ...configuration,
        codex: { enabled: true, deviceLogin: DeviceLogin.NONE },
        version: 9n,
      });
      const [privateConfig] = await take(worker.messages, 1);

      if (privateConfig?.payload.case !== "config") throw new Error("Expected updated device login configuration.");
      expect(privateConfig.payload.value.profiles[1]?.disabled).toBe(false);
      expect(privateConfig.payload.value.profiles[1]?.userConfiguration).toBeUndefined();
      expect(configuration.profiles[1]?.userConfiguration?.mode).toBe(ProviderConfigurationMode.SHARED);
    } finally {
      worker.close();
      await gateway.link.shutdown();
      await gateway.server.close();
    }
  });
}
