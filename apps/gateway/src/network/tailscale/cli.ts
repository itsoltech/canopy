import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/** The CLI inside the macOS app (App Store and standalone builds); it is not on PATH by default. */
export const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/** tailscaled's LocalAPI socket on Linux (packages and the static build). */
export const LOCALAPI_SOCKETS = ["/var/run/tailscale/tailscaled.sock", "/run/tailscale/tailscaled.sock"];

export type TailscaleLookup = {
  /** PATH to search; the gateway's own by default. */
  path?: string;
  platform?: NodeJS.Platform;
  /** Tests: where the macOS app keeps its CLI. */
  macApp?: string;
  /** Tests: LocalAPI sockets to try when there is no CLI. */
  sockets?: string[];
};

export type TailscaleAccess = { cli: string; socket?: undefined } | { cli?: undefined; socket: string };

function runnable(file: string) {
  try {
    accessSync(file, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

/** Where this host's Tailscale answers: the CLI on PATH, the macOS app's CLI, or the LocalAPI socket. */
export function locateTailscale(lookup: TailscaleLookup = {}): TailscaleAccess | undefined {
  const platform = lookup.platform ?? process.platform;
  const names = platform === "win32" ? ["tailscale.exe"] : ["tailscale"];

  for (const directory of (lookup.path ?? process.env["PATH"] ?? "").split(delimiter).filter(Boolean))
    for (const name of names) if (runnable(join(directory, name))) return { cli: join(directory, name) };

  const app = lookup.macApp ?? MAC_APP_CLI;

  if (platform === "darwin" && runnable(app)) return { cli: app };

  const socket = (lookup.sockets ?? (platform === "linux" ? LOCALAPI_SOCKETS : [])).find((s) => {
    try {
      accessSync(s, constants.R_OK | constants.W_OK);

      return true;
    } catch {
      return false;
    }
  });

  return socket ? { socket } : undefined;
}

export type CliResult = { ok: boolean; stdout: string; stderr: string };

/** Runs the CLI with a fixed argument array (never a shell) and a deadline. A failure is a result, not a throw. */
export function runCli(cli: string, args: readonly string[], options: { path?: string; timeoutMs?: number } = {}) {
  return new Promise<CliResult>((resolve) => {
    execFile(
      cli,
      [...args],
      {
        timeout: options.timeoutMs ?? 10_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ...(options.path !== undefined && { PATH: options.path }) },
      },
      (error, stdout, stderr) => resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

/** GET on tailscaled's LocalAPI over its Unix socket (read-only use). */
export async function localApi(socket: string, path: string, timeoutMs = 5000): Promise<CliResult> {
  try {
    const response = await fetch(`http://local-tailscaled.sock${path}`, {
      unix: socket,
      headers: { "Sec-Tailscale": "localapi" },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await response.text();

    return { ok: response.ok, stdout: response.ok ? body : "", stderr: response.ok ? "" : body };
  } catch (cause) {
    return { ok: false, stdout: "", stderr: cause instanceof Error ? cause.message : "" };
  }
}
