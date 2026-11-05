import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { type Provider, ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { remoteServe, sharedHost, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./computers.ts";
import { startTestGateway } from "./gateway.ts";

/** Separate database, gateway, key, scripted worker and pinned link listener. */
export async function configComputer(
  name: string,
  capabilities?: string[],
  skillSources?: NonNullable<Parameters<typeof startTestGateway>[0]>["skillSources"],
) {
  let gateway = await startTestGateway({ role: "desktop", ...(skillSources && { skillSources }) });
  let store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
  let links = makeLinks();

  function makeLinks() {
    const own = uiHandlers(gateway.core);

    return linkedComputers({
      store,
      host: "127.0.0.1",
      heartbeatMs: 150,
      core: gateway.core,
      serve: remoteServe(own, gateway.core),
      shared: sharedHost(gateway.core, own),
      ...(capabilities && { capabilities }),
    });
  }

  async function attach() {
    gateway.core.computers = links;
    gateway.core.network = links.options.network;
    await links.start();
    await links.manage(create(ui.ComputerOperationRequestSchema, { action: "rename", name }));
  }

  try {
    await attach();
  } catch (error) {
    await links.close();
    await gateway.close();
    throw error;
  }

  return {
    get gateway() {
      return gateway;
    },
    get store() {
      return store;
    },
    get links() {
      return links;
    },
    get node() {
      return links.hello().nodeId;
    },
    settings: async () => (await gateway.api.getSettings({})).user!,
    update: async (
      change: Omit<
        MessageInitShape<typeof ui.UpdateUserSettingsRequestSchema>,
        "expectedVersion" | "$typeName" | "$unknown"
      >,
    ) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await gateway.api.updateUserSettings({
            ...change,
            expectedVersion: (await gateway.api.getSettings({})).user!.version,
          });
        } catch (error) {
          if (attempt >= 5 || !(error instanceof ConnectError) || error.code !== Code.FailedPrecondition) throw error;
        }
      }
    },
    sharing: (nodeId: string, enabled: boolean) =>
      gateway.api.manageComputer({ action: "share_config", nodeId, enabled }),
    restart: async () => {
      await links.close();

      const storage = {
        pg: gateway.pg,
        secretsKey: gateway.secretsKey,
        workerId: gateway.workerId,
        workerCredential: gateway.workerCredential,
      };

      await gateway.close(true);

      try {
        gateway = await startTestGateway({ role: "desktop", storage, ...(skillSources && { skillSources }) });
      } catch (error) {
        await storage.pg.stop();
        throw error;
      }

      store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);
      links = makeLinks();
      await attach();
    },
    close: async () => {
      await links.close();
      await gateway.close();
    },
  };
}

export type ConfigComputer = Awaited<ReturnType<typeof configComputer>>;

export async function pairConfig(a: ConfigComputer, b: ConfigComputer, shareA = true, shareB = true) {
  const invitation = await a.links.createPairing(shareA);
  await b.links.pair(a.links.addresses[0]!, invitation.code, shareB);
}

type InstanceInput = Omit<
  MessageInitShape<typeof ui.SaveProviderInstanceRequestSchema>,
  "$typeName" | "$unknown" | "create" | "expectedRevision"
>;

export async function instanceOf(computer: ConfigComputer, harness: Provider, id: string) {
  return (await computer.gateway.api.listProviderInstances({})).instances.find(
    (i) => i.harness === harness && i.id === id,
  );
}

export const createInstance = (computer: ConfigComputer, input: InstanceInput) =>
  computer.gateway.api.saveProviderInstance({ allWorkers: true, ...input, create: true });

/** Saves the instance as the settings form does: the whole definition, secrets kept unless replaced. */
export async function editInstance(
  computer: ConfigComputer,
  harness: Provider,
  id: string,
  change: Partial<InstanceInput>,
) {
  const current = (await instanceOf(computer, harness, id))!;

  return computer.gateway.api.saveProviderInstance({
    harness,
    id,
    label: current.label,
    kind: current.kind,
    baseUrl: current.baseUrl,
    proxyId: current.proxyId,
    accentColor: current.accentColor,
    runtime: current.runtime,
    env: current.env.map((v) => (v.secret ? { name: v.name, secret: true } : { name: v.name, value: v.value })),
    ...change,
    expectedRevision: current.revision,
  });
}

export async function secretsOf(computer: ConfigComputer) {
  return computer.store.query<{ id: string; ciphertext: Uint8Array }>(
    "SELECT id::text,ciphertext FROM secrets WHERE owner_user_id=$1::uuid",
    [computer.gateway.userId],
  );
}
