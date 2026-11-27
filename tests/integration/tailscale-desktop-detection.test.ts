import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * Puts the macOS app CLI at its bundle path as a link to the system shell, run in a directory whose `status` file
 * the shell reads as its script. macOS assesses a just-written executable on its first launch and can hold exec
 * past any deadline, so the fixture never launches a new file.
 */
async function bundleCli(script: string, run: (cli: string) => Promise<void>) {
  const root = dirs("canopy-ts-mac-");
  const cli = join(root, "Tailscale.app", "Contents", "MacOS", "Tailscale");
  mkdirSync(dirname(cli), { recursive: true });
  symlinkSync("/bin/sh", cli);
  writeFileSync(join(root, "status"), script, { mode: 0o600 });
  const cwd = process.cwd();
  process.chdir(root);

  try {
    await run(cli);
  } finally {
    process.chdir(cwd);
  }
}

const macOS = { platform: "darwin" as const, path: "" };

test.skipIf(process.platform === "win32")("macOS forces CLI mode for the app bundle with no shell PATH", async () => {
  // `status` is the shell's script, so the CLI's second argument is the script's only one.
  const script = `[ "$TAILSCALE_BE_CLI" = 1 ] || exit 1
[ "$#" = 1 ] && [ "$1" = --json ] || exit 2
[ -z "$PATH" ] || exit 3
printf '%s\\n' '{"BackendState":"Running"}'
`;

  await bundleCli(script, async (cli) => {
    expect(locateTailscale({ ...macOS, macApp: cli })?.cli).toBe(cli);
    // Below the test timeout, so a failure shows the command's own result.
    const status = await runCli(cli, ["status", "--json"], { ...macOS, timeoutMs: 3000 });
    expect(status).toMatchObject({ ok: true });
    expect(parseStatus(status.stdout).state).toBe("connected");
  });
});

test.skipIf(process.platform === "win32")("a CLI that ignores termination fails at its deadline", async () => {
  // The shell outlives SIGTERM, and its background child keeps the output open after the shell is gone.
  const script = `trap '' TERM
/bin/sleep 10 &
printf '%s' "$!" > child.pid
wait
`;

  await bundleCli(script, async (cli) => {
    const status = await runCli(cli, ["status", "--json"], { ...macOS, timeoutMs: 2000 });
    // The shell had ignored SIGTERM and started its child before the deadline.
    const child = Number(readFileSync("child.pid", "utf8"));
    process.kill(child, "SIGKILL");
    expect(status.ok).toBe(false);
  });
});

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
