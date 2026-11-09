import { Provider, ui } from "@canopy/contracts";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { qualifyId } from "@canopy/domain/computers";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { ComputerStore } from "../../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./gateway.ts";

export async function scenarioComputer() {
  let gateway = await startTestGateway({ role: "desktop" });

  const makeLinks = () =>
    linkedComputers({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      host: "127.0.0.1",
      serve: remoteServe(uiHandlers(gateway.core)),
    });

  let links = makeLinks();

  const attach = async () => {
    gateway.core.computers = links;
    gateway.core.network = links.options.network;
    await links.start();
  };

  await attach();
  const project = (await gateway.api.createProject({ name: "Sync scenario" })).project!.id;

  const workspace = (
    await gateway.api.createWorkspace({ projectId: project, workerId: gateway.workerId, rootPath: "/repo/sync" })
  ).workspace!.id;

  const threads: string[] = [];

  for (let i = 0; i < 3; i++) {
    threads.push(
      (
        await gateway.api.createThread({
          projectId: project,
          workspaceId: workspace,
          provider: Provider.CODEX,
          title: `Scenario ${i}`,
          clientRequestId: crypto.randomUUID(),
        })
      ).thread!.id,
    );
  }

  return {
    get gateway() {
      return gateway;
    },
    get links() {
      return links;
    },
    threads,
    restart: async () => {
      await links.close();
      const { pg, secretsKey, workerId, workerCredential } = gateway;
      await gateway.close(true);
      gateway = await startTestGateway({ role: "desktop", storage: { pg, secretsKey, workerId, workerCredential } });
      links = makeLinks();
      // Stay offline until the scenario explicitly starts the new link runtime.
    },
    attach,
    close: async () => {
      await links.close();
      await gateway.close();
    },
  };
}

export function scenarioWatch(source: AsyncIterable<ui.ThreadUpdate>) {
  let state: ui.ThreadSnapshot | undefined;
  let failure: unknown;

  const done = (async () => {
    try {
      for await (const update of source) state = applyThreadUpdate(state, update);
    } catch (error) {
      failure = error;
    }
  })();

  return {
    done,
    get state() {
      return state;
    },
    get failure() {
      return failure;
    },
    async until(title: string) {
      const result = await eventually(
        async () => state?.thread?.title,
        (value) => value === title,
        15_000,
      );

      if (result !== title) throw new Error("Scenario watch did not converge");
    },
  };
}

export async function scenarioMirror(
  computer: Awaited<ReturnType<typeof scenarioComputer>>,
  node: string,
  thread: string,
  title: string,
) {
  const result = await eventually(
    async () => (await computer.links.mirror.snapshot(node, thread))?.thread?.title,
    (value) => value === title,
    20_000,
  );

  if (result !== title) throw new Error("Scenario mirror did not converge");
}

export const remoteThread = (gateway: TestGateway, node: string, id: string, signal: AbortSignal) =>
  gateway.api.watchThread({ threadId: qualifyId(id, node), incremental: true }, { signal });
