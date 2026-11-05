import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { admit, type FrontPolicy } from "../../apps/gateway/src/network/tailscale/front.ts";
import {
  choosePort,
  ownsEntry,
  serveOffArgs,
  serveOnArgs,
  serveStatusArgs,
} from "../../apps/gateway/src/network/tailscale/serve.ts";
import { Tailscale } from "../../apps/gateway/src/network/tailscale/tailscale.ts";
import { webOrigin } from "../../apps/gateway/src/runtime.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { fakeTailscale } from "./support/tailscale.ts";

const dirs = tempDirs();
const MAGIC = "laptop.example-tailnet.ts.net";
const OWNER = "owner@example.com";
const rejected = (call: Promise<unknown>) => call.catch((cause: unknown) => ConnectError.from(cause));

const update = (action: string, extra: { enabled?: boolean; port?: number } = {}) =>
  create(ui.UpdateNetworkAccessRequestSchema, { action, ...extra });

const OTHER_WEB = { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } };

describe("serve commands and ports", () => {
  test("exact argument arrays, and none of them is ever Funnel", () => {
    expect(serveStatusArgs()).toEqual(["serve", "status", "--json"]);
    expect(serveOnArgs(443, "http://127.0.0.1:25000")).toEqual([
      "serve",
      "--bg",
      "--yes",
      "--https=443",
      "http://127.0.0.1:25000",
    ]);
    expect(serveOffArgs(8447)).toEqual(["serve", "--https=8447", "off"]);

    for (const args of [serveStatusArgs(), serveOnArgs(443, "http://127.0.0.1:1"), serveOffArgs(443)])
      expect(args.join(" ")).not.toMatch(/funnel/i);
  });

  test("443 when free, then 8447; a chosen port is refused when another entry has it; Canopy's own is free", () => {
    expect(choosePort({}, undefined, null)).toBe(443);
    expect(choosePort({ TCP: { "443": { HTTPS: true } } }, undefined, null)).toBe(8447);
    expect(() => choosePort({ TCP: { "443": {}, "8447": {} } }, undefined, null)).toThrow("Choose another port");
    expect(() => choosePort({ TCP: { "9443": { TCPForward: "127.0.0.1:22" } } }, undefined, 9443)).toThrow(
      "Port 9443 is already used by another Tailscale Serve entry",
    );
    expect(() => choosePort({ Foreground: { s1: { TCP: { "443": { HTTPS: true } } } } }, undefined, 443)).toThrow(
      "Port 443 is already used",
    );

    const own = { port: 443, host: MAGIC, target: "http://127.0.0.1:25000" };

    const config = {
      TCP: { "443": { HTTPS: true } },
      Web: { [`${MAGIC}:443`]: { Handlers: { "/": { Proxy: own.target } } } },
    };

    expect(ownsEntry(config, own)).toBe(true);
    expect(choosePort(config, own, null)).toBe(443);
    expect(ownsEntry({ ...config, Web: { [`${MAGIC}:443`]: OTHER_WEB } }, own)).toBe(false);
  });

  test("the web origin setting must be an origin", () => {
    expect(webOrigin({})).toBeUndefined();
    expect(webOrigin({ CANOPY_WEB_ORIGIN: "http://127.0.0.1:3000" })).toBe("http://127.0.0.1:3000");

    for (const bad of ["127.0.0.1:3000", "http://127.0.0.1:3000/app", "ftp://x"])
      expect(() => webOrigin({ CANOPY_WEB_ORIGIN: bad })).toThrow("CANOPY_WEB_ORIGIN");
  });
});

describe("the front lets in only the owner through Canopy's entry", () => {
  const policy: FrontPolicy = { host: MAGIC, port: 443, login: OWNER, web: "http://127.0.0.1:5999" };
  const request = (headers: Record<string, string>) => new Request("http://127.0.0.1:1/", { headers });
  const owner = { host: MAGIC, "tailscale-user-login": OWNER };

  test("owner in, everybody else out", () => {
    expect(admit(request(owner), policy)).toBeUndefined();
    expect(
      admit(request({ ...owner, origin: `https://${MAGIC}`, "sec-fetch-site": "same-origin" }), policy),
    ).toBeUndefined();
    expect(admit(request({ host: MAGIC }), policy)?.status).toBe(403);
    expect(admit(request({ ...owner, "tailscale-user-login": "guest@example.com" }), policy)?.status).toBe(403);
    expect(admit(request({ ...owner, "tailscale-funnel-request": "?1" }), policy)?.status).toBe(403);
    expect(admit(request({ ...owner, host: "127.0.0.1:5999" }), policy)?.status).toBe(421);
    expect(admit(request({ ...owner, origin: "https://evil.example" }), policy)?.status).toBe(403);
    expect(admit(request({ ...owner, "sec-fetch-site": "cross-site" }), policy)?.status).toBe(403);
  });

  test("a non-standard port is part of the host; a tagged server lets the tailnet in", () => {
    const custom = { ...policy, port: 8447 };
    expect(admit(request(owner), custom)?.status).toBe(421);
    expect(admit(request({ ...owner, host: `${MAGIC}:8447` }), custom)).toBeUndefined();
    expect(admit(request({ host: MAGIC }), { ...policy, login: undefined })).toBeUndefined();
  });
});

/** A plain HTTP request to the front with the headers tailscaled would send (fetch can't set Host). */
function viaServe(port: number, path: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;

          // Server-sent events never end: the first event is enough.
          if (path === "/events" && body.includes("\n\n")) res.destroy();
        });
        res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });

      req.on("error", reject);
      req.end();
    },
  );
}

describe.skipIf(!dockerAvailable)("HTTPS over Tailscale on a gateway", () => {
  let gw: TestGateway;
  let store: ComputerStore;
  let network: NetworkAccess;
  const fake = fakeTailscale(dirs("canopy-ts-https-"), { dnsName: MAGIC, certDomains: null });
  const tailscale = new Tailscale({ path: fake.path, sockets: [], platform: "linux", pollMs: 60_000, ttlMs: 0 });

  // The web BFF stand-in: it echoes what reached it, streams events and redirects to its own origin.
  const web = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/events")
        return new Response(
          new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("data: hello\n\n")) }),
          { headers: { "content-type": "text/event-stream" } },
        );

      if (url.pathname === "/go") return Response.redirect(`${url.origin}/next`, 303);

      return Response.json({ url: request.url, headers: Object.fromEntries(request.headers) });
    },
  });

  const webOriginValue = `http://127.0.0.1:${web.port}`;

  function open() {
    network = new NetworkAccess({ store, role: "desktop", host: "127.0.0.1", tailscale, webOrigin: webOriginValue });

    return network.start();
  }

  const https = async () => (await network.update(update("refresh_tailscale"))).tailscale!.https!;
  const servePorts = () => Object.keys(fake.serve().TCP ?? {}).sort();

  /** The loopback port Canopy's entry points at (the one entry that isn't the other app's). */
  const frontPort = () => {
    const proxies = Object.values(fake.serve().Web ?? {}).map((w) => w.Handlers["/"]?.Proxy ?? "");

    return Number(new URL(proxies.find((p) => p !== OTHER_WEB.Handlers["/"].Proxy)!).port);
  };

  beforeAll(async () => {
    gw = await startTestGateway({ role: "desktop" });
    store = new ComputerStore(gw.runtime, gw.userId, gw.secretsKey);
    await tailscale.start();
    await open();
  }, 60_000);

  afterAll(async () => {
    tailscale.close();
    await network?.close();
    await web.stop(true);
    await gw?.close();
  }, 15_000);

  test("without HTTPS certificates the switch explains the one admin action and changes nothing", async () => {
    expect(await https()).toMatchObject({
      enabled: false,
      state: "off",
      unavailable: "Turn on HTTPS certificates in the Tailscale admin console.",
      adminUrl: "https://login.tailscale.com/admin/dns",
      allowedLogin: OWNER,
    });
    expect(await rejected(network.update(update("set_tailscale_https", { enabled: true })))).toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(fake.calls().filter((args) => args[0] === "serve")).toEqual([]);
  });

  test("turning it on adds exactly one entry on 443 to the front; only the owner gets through", async () => {
    fake.setStatus({ dnsName: MAGIC });
    fake.setServe({ TCP: { "8443": { HTTPS: true } }, Web: { [`${MAGIC}:8443`]: OTHER_WEB } });
    await network.update(update("refresh_tailscale"));
    const on = (await network.update(update("set_tailscale_https", { enabled: true }))).tailscale!.https!;

    expect(on).toMatchObject({ enabled: true, state: "on", port: 443, portAutomatic: true, url: `https://${MAGIC}` });
    const front = frontPort();
    expect(fake.calls().filter((args) => args[0] === "serve" && args[1] !== "status")).toEqual([
      ["serve", "--bg", "--yes", "--https=443", `http://127.0.0.1:${front}`],
    ]);
    expect(servePorts()).toEqual(["443", "8443"]);

    const owner = {
      host: MAGIC,
      "tailscale-user-login": OWNER,
      origin: `https://${MAGIC}`,
      "x-forwarded-for": "1.2.3.4",
    };

    const passed = await viaServe(front, "/api/x?y=1", owner);
    expect(passed.status).toBe(200);
    const seen: { url: string; headers: Record<string, string> } = JSON.parse(passed.body);
    expect(seen.url).toBe(`${webOriginValue}/api/x?y=1`);
    expect(seen.headers).toMatchObject({ host: `127.0.0.1:${web.port}`, origin: webOriginValue });
    expect(Object.keys(seen.headers).filter((h) => h.startsWith("tailscale-"))).toEqual([]);
    expect(seen.headers["x-forwarded-for"]).toBeUndefined();

    expect((await viaServe(front, "/", { host: MAGIC, "tailscale-user-login": "guest@example.com" })).status).toBe(403);
    expect((await viaServe(front, "/", { ...owner, "tailscale-funnel-request": "?1" })).status).toBe(403);
    expect((await viaServe(front, "/go", owner)).headers["location"]).toBe(`https://${MAGIC}/next`);
    expect((await viaServe(front, "/events", owner)).body).toBe("data: hello\n\n");
  });

  test("a restart keeps the entry and the front's port: no Serve changes", async () => {
    const before = fake.calls().length;
    const front = frontPort();
    await network.close();
    await open();

    expect(await https()).toMatchObject({ state: "on", port: 443 });
    expect(frontPort()).toBe(front);
    expect(
      fake
        .calls()
        .slice(before)
        .filter((args) => args[0] === "serve" && args[1] !== "status"),
    ).toEqual([]);
  });

  test("a port another entry uses is refused; a free one moves only Canopy's entry", async () => {
    expect(await rejected(network.update(update("set_tailscale_https_port", { port: 8443 })))).toMatchObject({
      code: Code.FailedPrecondition,
      rawMessage: "Port 8443 is already used by another Tailscale Serve entry. Choose another port.",
    });
    expect((await https()).port).toBe(443);

    const before = fake.calls().length;
    const moved = (await network.update(update("set_tailscale_https_port", { port: 9443 }))).tailscale!.https!;
    expect(moved).toMatchObject({ state: "on", port: 9443, portAutomatic: false, url: `https://${MAGIC}:9443` });
    expect(
      fake
        .calls()
        .slice(before)
        .filter((args) => args[1] !== "status"),
    ).toEqual([
      ["serve", "--https=443", "off"],
      ["serve", "--bg", "--yes", "--https=9443", `http://127.0.0.1:${frontPort()}`],
    ]);
    expect(servePorts()).toEqual(["8443", "9443"]);
  });

  test("turning it off removes only Canopy's entry; an entry someone changed is left alone", async () => {
    const off = (await network.update(update("set_tailscale_https", { enabled: false }))).tailscale!.https!;
    expect(off).toMatchObject({ enabled: false, state: "off", url: "" });
    expect(servePorts()).toEqual(["8443"]);
    expect(fake.serve().Web?.[`${MAGIC}:8443`]).toEqual(OTHER_WEB);

    await network.update(update("set_tailscale_https", { enabled: true }));
    // Someone points Canopy's port elsewhere: Canopy must not remove it.
    fake.setServe({ ...fake.serve(), Web: { ...fake.serve().Web, [`${MAGIC}:9443`]: OTHER_WEB } });
    const before = fake.calls().length;
    await network.update(update("set_tailscale_https", { enabled: false }));
    expect(
      fake
        .calls()
        .slice(before)
        .filter((args) => args[1] !== "status"),
    ).toEqual([]);
    expect(servePorts()).toEqual(["8443", "9443"]);
    expect(
      await store.query("SELECT tailscale_https, tailscale_serve FROM network_access WHERE owner_user_id=$1::uuid", [
        gw.userId,
      ]),
    ).toEqual([{ tailscale_https: false, tailscale_serve: null }]);
  });

  test("without operator rights the error says how to grant them; nothing is recorded", async () => {
    fake.setServe({});
    fake.denyServe();
    await network.update(update("set_tailscale_https_port", { port: 0 }));
    const failed = (await network.update(update("set_tailscale_https", { enabled: true }))).tailscale!.https!;
    expect(failed.state).toBe("error");
    expect(failed.error).toContain("tailscale set --operator=");
    expect(servePorts()).toEqual([]);

    fake.denyServe(false);
    expect((await https()).state).toBe("on");
    await network.update(update("set_tailscale_https", { enabled: false }));
    expect(servePorts()).toEqual([]);
  });

  test("no command Canopy ran mentions Funnel", () => {
    expect(fake.calls().length).toBeGreaterThan(0);
    expect(fake.calls().filter((args) => args.some((a) => /funnel/i.test(a)))).toEqual([]);
  });
});
