import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as http2 from "node:http2";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { openListener, type Listener } from "../../apps/gateway/src/network/listener.ts";
import { eventually } from "./support/gateway.ts";

/** A phone suspended in the background, or one whose NAT mapping expired, never closes its connection. Its live
 * streams must end on the computer instead of staying open (with their subscriptions) forever. */
describe("network access listener liveness", () => {
  let listener: Listener;
  let path: Server;
  const sockets = new Set<Socket>();
  let frozen = false;
  let open = 0;

  beforeAll(async () => {
    listener = await openListener({
      host: "127.0.0.1",
      port: 0,
      identity: await generateIdentity(),
      liveness: { intervalMs: 200, timeoutMs: 300 },
      // A quiet live stream: headers, then nothing until the phone leaves.
      route: () => (request, response) => {
        open++;
        request.once("close", () => open--);
        response.writeHead(200, { "content-type": "application/connect+proto" });
      },
    });

    // The network between phone and computer; frozen, it drops every byte without closing anything.
    path = createServer((phone) => {
      const computer = connect(listener.port, "127.0.0.1");
      sockets.add(phone).add(computer);
      phone.on("data", (data) => frozen || computer.write(data));
      computer.on("data", (data) => frozen || phone.write(data));
      phone.on("error", () => computer.destroy());
      computer.on("error", () => phone.destroy());
    });
    await new Promise<void>((resolve) => path.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => path?.close(() => resolve()));
    await listener?.close();
  });

  test("a quiet stream stays open while the phone answers, and ends once it stops", async () => {
    // SAFETY: the path listens on a TCP host/port.
    const port = (path.address() as AddressInfo).port;
    const phone = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    phone.on("error", () => {});

    try {
      const stream = phone.request({ ":method": "POST", ":path": "/canopy.ui.v1.GatewayService/WatchOverview" });
      stream.on("error", () => {});
      await new Promise((resolve) => stream.once("response", resolve));
      expect(open).toBe(1);

      // Several PING rounds: an answering phone keeps its quiet stream.
      await Bun.sleep(1000);
      expect(open).toBe(1);

      frozen = true;
      const started = performance.now();
      expect(
        await eventually(
          async () => open,
          (count) => count === 0,
        ),
      ).toBe(0);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      phone.destroy();
    }
  });
});
