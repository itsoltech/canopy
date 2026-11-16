import { expect, test } from "bun:test";
import { Provider, ProviderConfigurationMode, ProviderProfileKind } from "@canopy/contracts";
import { CLAUDE_USER_CONFIGURATION_CAPABILITY } from "@canopy/domain/release/protocol";
import { connectWorker, startGateway, take } from "./helpers.ts";

for (const supported of [false, true]) {
  test(`WorkerLink negotiates Claude policy on initial config and pushes (${supported ? "capable" : "legacy"})`, async () => {
    const configuration = {
      version: 7n,
      profiles: [
        {
          id: "configured",
          providers: [Provider.CLAUDE],
          kind: ProviderProfileKind.NATIVE,
          userConfiguration: { mode: ProviderConfigurationMode.SHARED, sourcePath: "~/claude" },
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
        capabilities: supported ? [CLAUDE_USER_CONFIGURATION_CAPABILITY] : [],
      },
    });

    try {
      const connection = await gateway.nextConnection();
      const [initial] = await take(worker.messages, 1);

      expect(initial?.payload.case).toBe("config");

      if (initial?.payload.case !== "config") throw new Error("Expected initial configuration.");
      expect(initial.payload.value.profiles[0]?.disabled).toBe(!supported);
      expect(initial.payload.value.profiles[1]?.disabled).toBe(false);
      expect(initial.payload.value.profiles[2]?.disabled).toBe(!supported);
      expect(configuration.profiles[0]).not.toHaveProperty("disabled");
      gateway.link.pushConfig("worker-1", { ...configuration, version: 8n });
      const [pushed] = await take(worker.messages, 1);

      expect(pushed?.payload.case).toBe("config");

      if (pushed?.payload.case !== "config") throw new Error("Expected updated configuration.");
      expect(pushed.payload.value.profiles[0]?.disabled).toBe(!supported);
      worker.send({
        case: "configApplied",
        value: {
          version: 8n,
          applied: true,
          profiles: [
            {
              id: "configured",
              providers: [Provider.CLAUDE],
              available: supported,
              detail: supported ? "" : "disabled",
            },
            { id: "native", providers: [Provider.CODEX], available: true },
          ],
        },
      });
      const [reported] = await take(connection.messages, 1);

      if (reported?.payload.case !== "configApplied") throw new Error("Expected configuration report.");
      expect(reported.payload.value.profiles[0]?.detail).toBe(
        supported ? "" : "Update this worker to use local or shared Claude configuration.",
      );
      expect(reported.payload.value.profiles[1]?.available).toBe(true);
    } finally {
      worker.close();
      await gateway.link.shutdown();
      await gateway.server.close();
    }
  });
}
