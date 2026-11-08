import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { openListener, type Listener } from "../../apps/gateway/src/network/listener.ts";
import { ProbeError, routedMobileClient, type PinnedTransport } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { connectionReport } from "../../apps/mobile/src/api/route-diagnostics.ts";

/** A waking tunnel delays the first TLS reply on every connection; DNS fails independently and LAN is silent. */
describe("mobile route recovery over a waking tunnel", () => {
  let gateway: Listener;
  let delayed: Server;
  let blackhole: Server;
  let fingerprint = "";
  let address = "";
  let silent = "";
  let requests = 0;
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const logs: string[] = [];
  const dns = "https://gateway.invalid:23456";

  beforeAll(async () => {
    const identity = await generateIdentity();
    fingerprint = identity.fingerprint;

    const adapter = connectNodeAdapter({
      routes: (router) =>
        router.service(ui.GatewayService, {
          getOverview() {
            requests++;

            return create(ui.GetOverviewResponseSchema, {});
          },
        }),
    });

    gateway = await openListener({
      host: "127.0.0.1",
      port: 0,
      identity,
      route: () => adapter,
      log: (line) => logs.push(line),
    });
    delayed = createServer((phone) => {
      const computer = connect(gateway.port, "127.0.0.1");
      sockets.add(phone).add(computer);
      phone.pipe(computer);
      // Delay server -> client once, preserving byte order with pause/resume.
      computer.once("data", (data) => {
        computer.pause();

        const timer = setTimeout(() => {
          timers.delete(timer);

          if (!phone.destroyed) {
            phone.write(data);
            computer.pipe(phone);
            computer.resume();
          }
        }, 3500);

        timers.add(timer);
      });
      phone.on("error", () => computer.destroy());
      computer.on("error", () => phone.destroy());
      phone.on("close", () => {
        computer.destroy();
        sockets.delete(phone);
      });
      computer.on("close", () => sockets.delete(computer));
    });
    blackhole = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await Promise.all([listen(delayed), listen(blackhole)]);
    address = origin(delayed);
    silent = origin(blackhole);
  });

  afterAll(async () => {
    for (const timer of timers) clearTimeout(timer);

    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [delayed, blackhole].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await gateway?.close();
  });

  function transport(): PinnedTransport {
    const real = nodePinnedTransport();

    return {
      ...real,
      probe: (route, pin, signal, ...rest) =>
        route === dns
          ? Promise.reject(new ProbeError("UnknownHostException"))
          : real.probe(route, pin, signal, ...rest),
    };
  }

  test("a 3.5 s first-packet delay connects without declaring the pending route unavailable", async () => {
    const phone = routedMobileClient({
      connection: { fingerprint, addresses: [dns, silent, address] },
      transport: transport(),
    });

    const started = Date.now();
    const before = requests;
    const connecting = phone.api.getOverview({});
    void connecting.catch(() => {});
    await Bun.sleep(2500);
    expect(phone.diagnostics.snapshot().pending).toBe(true);
    await connecting;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(12_000);
    expect(requests - before).toBe(1);
    expect(phone.connection().lastAddress).toBe(address);
    expect(phone.diagnostics.snapshot().routes.find((route) => route.address === dns)?.outcome).toBe("dns");
    expect(phone.diagnostics.snapshot().active).toBe(address);
    expect(logs.some((line) => line.includes("tls=established"))).toBe(true);
    expect(logs.join()).not.toContain(fingerprint);
    expect(connectionReport(phone.diagnostics.snapshot())).not.toContain(fingerprint);
    console.info(`mobile waking tunnel: connected in ${elapsed} ms; requests=${requests - before}`);
  }, 20_000);
});

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

function origin(server: Server) {
  // SAFETY: listen() completed on a TCP host/port.
  return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
