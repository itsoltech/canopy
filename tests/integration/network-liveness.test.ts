import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as http2 from "node:http2";
import { createHash } from "node:crypto";
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
  let delayMs = 0;
  let open = 0;
  let certificate = "";
  let fingerprint = "";
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const logs: string[] = [];

  beforeAll(async () => {
    const identity = await generateIdentity();
    certificate = identity.certificate;
    fingerprint = identity.fingerprint;
    listener = await openListener({
      host: "127.0.0.1",
      port: 0,
      identity,
      liveness: { intervalMs: 200, timeoutMs: 900 },
      log: (message) => logs.push(message),
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
      phone.on("data", (data) => {
        if (frozen) return;

        const timer = setTimeout(() => {
          timers.delete(timer);

          if (!frozen && !computer.destroyed) computer.write(data);
        }, delayMs);

        timers.add(timer);
      });
      computer.on("data", (data) => frozen || phone.write(data));
      phone.on("error", () => computer.destroy());
      computer.on("error", () => phone.destroy());
    });
    await new Promise<void>((resolve) => path.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    for (const timer of timers) clearTimeout(timer);

    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => path?.close(() => resolve()));
    await listener?.close();
  });

  function phoneClient() {
    // SAFETY: the path listens on a TCP host/port. Trust only the generated test computer's certificate.
    const port = (path.address() as AddressInfo).port;

    return http2.connect(`https://127.0.0.1:${port}`, {
      ca: certificate,
      checkServerIdentity: (_host, peer) =>
        createHash("sha256").update(peer.raw).digest("hex") === fingerprint ? undefined : new Error("pin"),
    });
  }

  test("slow pongs outlive the old deadline without closing a healthy session", async () => {
    const phone = phoneClient();
    phone.on("error", () => {});

    try {
      const stream = phone.request({ ":method": "POST", ":path": "/canopy.ui.v1.GatewayService/WatchOverview" });
      stream.on("error", () => {});
      await new Promise((resolve) => stream.once("response", resolve));
      // 450 ms replies exceed the former 300 ms test deadline; a full window tolerates them.
      delayMs = 450;
      await Bun.sleep(1800);
      expect(open).toBe(1);
      expect(logs.some((line) => line.includes("liveness_timeout"))).toBe(false);
    } finally {
      delayMs = 0;
      phone.destroy();
      await eventually(
        async () => open,
        (count) => count === 0,
      );
    }
  });

  test("a quiet stream stays open while the phone answers, and ends once it stops", async () => {
    const phone = phoneClient();
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
      expect(logs.some((line) => line.includes("closed reason=liveness_timeout duration_ms="))).toBe(true);
      expect(logs.join()).not.toContain(fingerprint);
    } finally {
      phone.destroy();
    }
  });

  test("a client GOAWAY records its numeric code and initiator without debug data", async () => {
    frozen = false;
    const phone = phoneClient();
    phone.on("error", () => {});

    try {
      const stream = phone.request({ ":method": "POST", ":path": "/canopy.ui.v1.GatewayService/WatchOverview" });
      stream.on("error", () => {});
      await new Promise((resolve) => stream.once("response", resolve));
      phone.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM, 0, Buffer.from("private-debug-data"));
      expect(
        await eventually(
          async () => logs.some((line) => line.includes("goaway initiator=peer error_code=11")),
          Boolean,
        ),
      ).toBe(true);
      expect(logs.join()).not.toContain("private-debug-data");
    } finally {
      phone.destroy();
    }
  });
});
