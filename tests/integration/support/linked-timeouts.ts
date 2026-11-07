import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import {
  AGENT_BUS,
  LAN_ROUTES,
  REMOTE_APP_UPDATE,
  REMOTE_BOTS,
  REMOTE_THREADS,
  THREAD_MIRROR,
} from "@canopy/domain/computers";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../../apps/gateway/src/computers/store.ts";
import { computersAdvertise } from "../../../apps/gateway/src/computers/runtime-lan.ts";
import { serveComputerUpdates } from "../../../apps/gateway/src/updates/linked.ts";
import { linkedComputers } from "./computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./gateway.ts";

/** TCP path that can silently discard bytes on existing sockets, as an expired NAT mapping does. */
export async function networkPath(port: number) {
  const sockets = new Set<Socket>();
  const frozen = new Set<Socket>();
  let blocked = false;

  const server = createServer((client) => {
    const upstream = connect(port, "127.0.0.1");
    sockets.add(client).add(upstream);
    client.on("data", (data) => blocked || frozen.has(client) || upstream.write(data));
    upstream.on("data", (data) => blocked || frozen.has(upstream) || client.write(data));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      sockets.delete(client);
      frozen.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      frozen.delete(upstream);
      client.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: This server listens on a loopback TCP port.
  const address = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    address,
    stopAccepting: () => server.close(),
    freeze: (all = false) => {
      for (const socket of sockets) frozen.add(socket);
      blocked = all;
    },
    thaw: () => {
      frozen.clear();
      blocked = false;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Two real gateways, separate databases and scripted workers, linked exclusively through controllable TCP paths. */
export async function linkedTimeouts(mirrors = false) {
  const a = await startTestGateway({ role: "desktop" });
  const b = await startTestGateway({ role: "desktop" });
  let release: (() => void) | undefined;
  let stalled: Promise<void> | undefined;
  const requests = new Map<string, number>();
  const count = (method: string) => requests.set(method, (requests.get(method) ?? 0) + 1);

  const links = (gateway: TestGateway) => {
    const serve = remoteServe(uiHandlers(gateway.core), gateway.core);

    return linkedComputers({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      host: "127.0.0.1",
      heartbeatMs: 1000,
      capabilities: [
        "presence",
        "unlink",
        LAN_ROUTES,
        REMOTE_THREADS,
        REMOTE_BOTS,
        REMOTE_APP_UPDATE,
        AGENT_BUS,
        ...(mirrors ? [THREAD_MIRROR] : []),
      ],
      serve: async function* (method, request, signal, node) {
        if (gateway === b) count(method.name);

        if (gateway === b && stalled) {
          const aborted = Promise.withResolvers<void>();
          const abort = () => aborted.resolve();
          signal.addEventListener("abort", abort, { once: true });

          try {
            await Promise.race([stalled, aborted.promise]);
          } finally {
            signal.removeEventListener("abort", abort);
          }

          if (signal.aborted) return;
        }

        yield* serve(method, request, signal, node);
      },
      updates: async (node, method, request) => {
        if (gateway === b) count(method.name);

        if (gateway === b && stalled) await stalled;

        return serveComputerUpdates(gateway.core, node, method, request);
      },
    });
  };

  const la = links(a);
  const lb = links(b);
  a.core.computers = la;
  a.core.network = la.options.network;
  b.core.computers = lb;
  b.core.network = lb.options.network;
  await la.start();
  await lb.start();
  const pa = await networkPath(la.options.network.port!);
  const pb = await networkPath(lb.options.network.port!);
  la.options.network.origins = () => [pa.address];
  lb.options.network.origins = () => [pb.address];
  computersAdvertise(la);
  computersAdvertise(lb);
  await la.manage(create(ui.ComputerOperationRequestSchema, { action: "rename", name: "Laptop A" }));
  await lb.manage(create(ui.ComputerOperationRequestSchema, { action: "rename", name: "Studio B" }));
  const node = lb.hello().nodeId;
  const invitation = await a.api.createComputerPairing({});
  await b.api.linkComputer({ address: pa.address, code: invitation.code });
  await eventually(async () => la.reachable().includes(node), Boolean, 15_000);

  const account = (
    await a.api.saveConnectorAccount({
      connectorType: "custom",
      name: "Local connector",
      url: "https://example.com/mcp",
      authKind: "headers",
      transport: "http",
    })
  ).account!;

  const bot = (
    await a.api.createBot({
      clientRequestId: crypto.randomUUID(),
      configuration: {
        name: "Local bot",
        shape: "round",
        color: "#22aaff",
        provider: Provider.CODEX,
        providerInstance: "native",
        model: "gpt-6.1-sol",
        workerId: a.workerId,
      },
    })
  ).bot!;

  const thread = async (gateway: TestGateway) => {
    const project = (await gateway.api.createProject({ name: "Local work" })).project!;

    const workspace = (
      await gateway.api.createWorkspace({
        projectId: project.id,
        workerId: gateway.workerId,
        rootPath: "/repo/repo-a",
        label: "Work",
      })
    ).workspace!;

    return (
      await gateway.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        title: "Local thread",
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;
  };

  const localThread = await thread(a);
  const remoteThread = await thread(b);

  return {
    a,
    b,
    la,
    lb,
    pa,
    pb,
    node,
    account,
    bot,
    localThread,
    remoteThread,
    requests,
    stall: () => {
      stalled = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    resume: () => {
      release?.();
      stalled = undefined;
    },
    close: async () => {
      release?.();
      await Promise.allSettled([pa.close(), pb.close()]);
      await Promise.allSettled([la.close(), lb.close()]);
      await a.close();
      await b.close();
    },
  };
}
