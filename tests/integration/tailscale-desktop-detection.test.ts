import { expect, test } from "bun:test";
import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { startGrpcServer } from "@canopy/transport";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { tailscaleMessage } from "../../apps/gateway/src/network/tailscale/addresses.ts";
import { locateTailscale, runCli } from "../../apps/gateway/src/network/tailscale/cli.ts";
import { parseStatus } from "../../apps/gateway/src/network/tailscale/status.ts";
import { Tailscale } from "../../apps/gateway/src/network/tailscale/tailscale.ts";
import { desktopGateway } from "../../apps/web/src/lib/server/desktop-gateway.ts";
import { statusJson } from "./support/tailscale.ts";

const dirs = tempDirs();

test.skipIf(process.platform === "win32")(
  "macOS forces CLI mode for the app bundle with no shell PATH",
  async () => {
    const cli = join(dirs("canopy-ts-mac-"), "Tailscale.app", "Contents", "MacOS", "Tailscale");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(
      cli,
      `#!/bin/sh
[ "$TAILSCALE_BE_CLI" = 1 ] || exit 1
[ "$#" = 2 ] && [ "$1" = status ] && [ "$2" = --json ] || exit 2
printf '%s\n' '{"BackendState":"Running"}'
`,
      { mode: 0o700 },
    );

    const options = { platform: "darwin" as const, path: "" };
    expect(locateTailscale({ ...options, macApp: cli })?.cli).toBe(cli);
    // Allow extra time to launch this generated executable on a cold runner.
    const status = await runCli(cli, ["status", "--json"], { ...options, timeoutMs: 10_000 });
    expect(status.ok).toBe(true);
    expect(parseStatus(status.stdout).state).toBe("connected");
  },
  15_000,
);

test("Windows finds the installed CLI outside PATH and distinguishes an unreadable status from a missing install", async () => {
  const windowsProgramFiles = join(dirs("canopy-ts-win-"), "Program Files");
  const cli = join(windowsProgramFiles, "Tailscale", "tailscale.exe");
  // An executable-looking directory must not count as an installation.
  mkdirSync(cli, { recursive: true });
  const tailscale = new Tailscale({ platform: "win32", path: "", windowsProgramFiles, sockets: [] });
  expect((await tailscale.refresh()).state).toBe("not_installed");

  rmdirSync(cli);
  writeFileSync(cli, "fake failed executable", { mode: 0o700 });
  expect((await tailscale.refresh()).state).toBe("not_running");
  expect(tailscale.cli).toBe(cli);

  const path = dirs("canopy-ts-path-");
  const pathCli = join(path, "tailscale.exe");
  writeFileSync(pathCli, "fake PATH executable", { mode: 0o700 });
  expect(locateTailscale({ ...tailscale.options, path })?.cli).toBe(pathCli);
});

test("Connect to Gateway reads the paired host's Tailscale status over pinned TLS", async () => {
  const identity = await generateIdentity();
  const token = "fixture-desktop-client";
  const status = tailscaleMessage(parseStatus(JSON.stringify(statusJson())));

  const host = await startGrpcServer({
    tls: { cert: identity.certificate, key: identity.privateKey },
    routes: (router) =>
      router.service(ui.GatewayService, {
        getClientCapabilities: () => ({
          minProtocol: 1,
          maxProtocol: 1,
          methods: ui.GatewayService.methods.map((method) => method.name),
        }),
        getNetworkAccess(_request, context) {
          if (context.requestHeader.get("authorization") !== `Bearer ${token}`)
            throw new ConnectError("Expected the paired Desktop credential", Code.Unauthenticated);

          return { tailscale: status };
        },
      }),
  });

  try {
    const routes = JSON.stringify({ fingerprint: identity.fingerprint, addresses: [host.url] });
    const client = createClient(ui.GatewayService, desktopGateway(routes, token).transport);

    expect((await client.getNetworkAccess({})).tailscale).toMatchObject({
      state: "connected",
      dnsName: "laptop.example-tailnet.ts.net",
    });
  } finally {
    await host.close(0);
  }
});
