import { expect, test } from "bun:test";
import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { locateTailscale } from "../../apps/gateway/src/network/tailscale/cli.ts";
import { Tailscale } from "../../apps/gateway/src/network/tailscale/tailscale.ts";

const dirs = tempDirs();

test.skipIf(process.platform === "win32")("macOS forces CLI mode for the app bundle with no shell PATH", async () => {
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

  const tailscale = new Tailscale({ platform: "darwin", path: "", macApp: cli, sockets: [] });
  expect((await tailscale.refresh()).state).toBe("connected");
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
