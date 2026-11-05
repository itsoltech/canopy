import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { remoteServe, sharedHost, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../../apps/gateway/src/computers/store.ts";
import { configAllowed } from "../../../apps/gateway/src/computers/runtime-config.ts";
import { configComputer } from "./config-sync.ts";
import { linkedComputers } from "./computers.ts";
import { eventually } from "./gateway.ts";
import { startInstanceFixture } from "./instance-fixture.ts";

/** Two independent homes, sharing configuration; B runs a real worker with a fixture harness. */
export async function linkedExecutionFixture() {
  const a = await configComputer("Laptop A");
  const fixture = await startInstanceFixture(true, { role: "desktop" });
  const b = fixture.gw;
  const store = new ComputerStore(b.runtime, b.userId, b.secretsKey);
  await fixture.save(Provider.CLAUDE, "linked-execution");
  await b.api.setInstanceModels({ harness: Provider.CLAUDE, id: "native", models: { custom: ["fixture-model"] } });

  // Independently saved proxies exercise an alias: the two databases retain different local ids.
  const proxy = (
    await a.gateway.api.saveProxy({
      name: "Fixture proxy",
      kind: "cliproxyapi",
      baseUrl: fixture.proxy.baseUrl,
      secret: "fixture-proxy-key",
    })
  ).proxy!;

  function makeLinks() {
    const own = uiHandlers(b.core);

    return linkedComputers({
      store,
      host: "127.0.0.1",
      heartbeatMs: 150,
      core: b.core,
      serve: remoteServe(own, b.core),
      shared: sharedHost(b.core, own),
    });
  }

  let links = makeLinks();

  async function attach() {
    b.core.computers = links;
    b.core.network = links.options.network;
    await links.start();
    await links.manage(create(ui.ComputerOperationRequestSchema, { action: "rename", name: "Studio B" }));
  }

  await attach();
  const invitation = await a.links.createPairing(true);
  await links.pair(a.links.addresses[0]!, invitation.code, true);

  const ready = () =>
    eventually(
      async () => configAllowed(a.links, links.hello().nodeId) && configAllowed(links, a.node),
      Boolean,
      20_000,
    );

  if (!(await ready())) throw new Error("Linked execution fixture did not connect");
  b.core.bots.start(10);

  return {
    a,
    b,
    store,
    fixture,
    proxy,
    get links() {
      return links;
    },
    get node() {
      return links.hello().nodeId;
    },
    reconnect: async () => {
      links = makeLinks();
      await attach();

      if (!(await ready())) throw new Error("Linked execution fixture did not reconnect");
    },
    close: async () => {
      await b.core.bots.stop();
      await links.close();
      await fixture.close();
      await a.close();
    },
  };
}

export type LinkedExecutionFixture = Awaited<ReturnType<typeof linkedExecutionFixture>>;
