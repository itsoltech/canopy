import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { locateTailscale } from "../../apps/gateway/src/network/tailscale/cli.ts";
import { parseStatus } from "../../apps/gateway/src/network/tailscale/status.ts";
import { Tailscale } from "../../apps/gateway/src/network/tailscale/tailscale.ts";
import { EMPTY_PATH, fakeTailscale, statusJson } from "./support/tailscale.ts";

const dirs = tempDirs();

/** Detection on the fake CLI only: no LocalAPI sockets, so the real tailscaled is never asked. */
function detector(path: string, extra: ConstructorParameters<typeof Tailscale>[0] = {}) {
  return new Tailscale({ path, sockets: [], platform: "linux", ...extra });
}

describe("tailscale status", () => {
  test("a connected computer: MagicDNS name without the dot, tailnet addresses, certificates, owner", async () => {
    const fake = fakeTailscale(dirs("canopy-ts-"));
    const snapshot = await detector(fake.path).refresh();

    expect(snapshot).toMatchObject({
      state: "connected",
      dnsName: "laptop.example-tailnet.ts.net",
      ipv4: ["192.0.2.10"],
      ipv6: ["2001:db8::10"],
      tailnet: "owner@example.com",
      magicDns: true,
      certDomains: ["laptop.example-tailnet.ts.net"],
      login: "owner@example.com",
      tagged: false,
    });
    expect(fake.calls()).toEqual([["status", "--json"]]);
  });

  test("each backend state is told apart; only a connected computer shares its name and addresses", () => {
    const state = (backend: string) => parseStatus(JSON.stringify(statusJson({ backend })));

    expect(state("NeedsLogin")).toMatchObject({ state: "logged_out", dnsName: "", ipv4: [] });
    expect(state("NeedsMachineAuth").state).toBe("logged_out");
    expect(state("Stopped")).toMatchObject({ state: "stopped", dnsName: "" });
    expect(state("Starting").state).toBe("starting");
    expect(state("NoState").state).toBe("starting");
    expect(parseStatus("not json").state).toBe("not_running");
    expect(parseStatus(JSON.stringify({ Self: {} })).state).toBe("not_running");
  });

  test("tailscaled not running, and no Tailscale at all", async () => {
    const fake = fakeTailscale(dirs("canopy-ts-"), "down");
    expect((await detector(fake.path).refresh()).state).toBe("not_running");
    expect((await detector(EMPTY_PATH).refresh()).state).toBe("not_installed");
  });

  test("tagged computers have no owner login; missing certificates and MagicDNS are reported", () => {
    const tagged = parseStatus(JSON.stringify(statusJson({ tags: ["tag:server"] })));
    expect(tagged).toMatchObject({ tagged: true, login: "" });

    const plain = parseStatus(JSON.stringify(statusJson({ certDomains: null, magicDns: false })));
    expect(plain).toMatchObject({ certDomains: [], magicDns: false, state: "connected" });
  });

  test("on macOS the CLI inside the app is used when tailscale isn't on PATH", async () => {
    const fake = fakeTailscale(dirs("canopy-ts-"));

    expect(locateTailscale({ path: EMPTY_PATH, platform: "darwin", macApp: fake.cli, sockets: [] })).toEqual({
      cli: fake.cli,
    });
    expect(locateTailscale({ path: EMPTY_PATH, platform: "linux", macApp: fake.cli, sockets: [] })).toBeUndefined();

    // Bun's directory only: the fake CLI is a Bun script.
    const bunOnly = dirname(process.execPath);
    expect(locateTailscale({ path: bunOnly, platform: "linux", sockets: [] })).toBeUndefined();
    const snapshot = await detector(bunOnly, { platform: "darwin", macApp: fake.cli }).refresh();
    expect(snapshot.state).toBe("connected");
  });

  test("without a CLI the LocalAPI socket is read", async () => {
    const socket = join(dirs("canopy-ts-sock-"), "tailscaled.sock");
    const paths: string[] = [];

    const server = Bun.serve({
      unix: socket,
      fetch: (request) => {
        paths.push(new URL(request.url).pathname);

        return Response.json(statusJson({ dnsName: "box.example-tailnet.ts.net" }));
      },
    });

    try {
      const snapshot = await new Tailscale({ path: EMPTY_PATH, sockets: [socket], platform: "linux" }).refresh();
      expect(snapshot).toMatchObject({ state: "connected", dnsName: "box.example-tailnet.ts.net" });
      expect(paths).toEqual(["/localapi/v0/status"]);
    } finally {
      await server.stop(true);
    }
  });

  test("readings are cached briefly, refreshed on demand and announced when they change", async () => {
    const fake = fakeTailscale(dirs("canopy-ts-"));
    const tailscale = detector(fake.path, { ttlMs: 60_000 });
    let changes = 0;
    tailscale.onChange(() => changes++);

    await tailscale.read();
    await tailscale.read();
    expect(fake.calls()).toHaveLength(1);

    await Promise.all([tailscale.refresh(), tailscale.refresh()]);
    expect(fake.calls()).toHaveLength(2);
    expect(changes).toBe(1);

    fake.setStatus({ backend: "NeedsLogin" });
    expect((await tailscale.refresh()).state).toBe("logged_out");
    expect(changes).toBe(2);
  });
});
