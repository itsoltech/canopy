import { Provider, ProviderProfileKind } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { startInstanceFixture } from "./instance-fixture.ts";
import { eventually } from "./gateway.ts";

/** Real WorkerHost and gRPC; only the provider CLIs are scripted. */
export async function harnessBots() {
  const f = await startInstanceFixture(true);

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    await f.save(provider, "bot-native");
    await f.gw.api.setInstanceModels({
      harness: provider,
      id: "native",
      models: { custom: ["fixture-model", "other-model"] },
    });
  }

  f.gw.core.bots.start();
  const read = (id: string) => f.gw.core.bots.run((s) => s.conversation(f.gw.userId, id));

  const add = async (provider: Provider, workerId = f.workerId, policy = "safe") =>
    (
      await f.gw.api.createBot({
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name: `Harness ${crypto.randomUUID().slice(0, 8)}`,
          shape: "round",
          color: "#22aaff",
          provider,
          providerInstance: "native",
          model: "fixture-model",
          approvalPolicy: policy,
          workerId,
        },
      })
    ).bot!;

  const send = (id: string, text: string) =>
    f.gw.api.sendBotMessage({ botId: id, text, clientRequestId: crypto.randomUUID() });

  const settled = (id: string) =>
    eventually(
      () => read(id),
      (r) => !r.working,
      10_000,
    );

  const tool = (id: string, name: string, args: JsonObject = {}) =>
    send(id, `TOOL:${name}\nARGS:${JSON.stringify(args)}`);

  const executable = async (provider: Provider, path: string) => {
    await f.gw.api.saveProviderInstance({
      harness: provider,
      id: "native",
      kind: ProviderProfileKind.NATIVE,
      runtime: { binaryPath: path },
    });
    const version = (await f.gw.api.getOverview({})).workers.find((w) => w.id === f.workerId)!.configVersion;
    await eventually(
      async () => f.host.config?.version,
      (v) => v === version,
    );
  };

  return {
    ...f,
    get gw() {
      return f.gw;
    },
    get host() {
      return f.host;
    },
    add,
    read,
    send,
    settled,
    tool,
    executable,
  };
}

export type HarnessBots = Awaited<ReturnType<typeof harnessBots>>;
