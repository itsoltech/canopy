import { execFile, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

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
  /** Tests: where Windows installs applications. */
  windowsProgramFiles?: string;
  /** Tests: LocalAPI sockets to try when there is no CLI. */
  sockets?: string[];
};

export type TailscaleAccess = { cli: string; socket?: undefined } | { cli?: undefined; socket: string };

function runnable(file: string) {
  try {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
    accessSync(file, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

/** Look for a CLI on PATH or in the desktop install, then for a LocalAPI socket. */
export function locateTailscale(lookup: TailscaleLookup = {}): TailscaleAccess | undefined {
  const platform = lookup.platform ?? process.platform;
  const name = platform === "win32" ? "tailscale.exe" : "tailscale";

  for (const directory of (lookup.path ?? process.env["PATH"] ?? "").split(delimiter).filter(Boolean)) {
    const cli = join(directory, name);

    if (runnable(cli)) return { cli };
  }

  const app = lookup.macApp ?? MAC_APP_CLI;

  if (platform === "darwin" && runnable(app)) return { cli: app };

  if (platform === "win32") {
    const programFiles = lookup.windowsProgramFiles ?? process.env["PROGRAMFILES"];

    if (programFiles && isAbsolute(programFiles)) {
      const cli = join(programFiles, "Tailscale", name);

      if (runnable(cli)) return { cli };
    }
  }

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

/**
 * Runs the CLI with a fixed argument array (never a shell) and a deadline. A failure is a result, not a throw.
 * The deadline does not wait for the exit: a child stuck in exec, or one whose descendants keep its output
 * open, would otherwise hold every Tailscale reading behind it.
 */
export function runCli(
  cli: string,
  args: readonly string[],
  options: Pick<TailscaleLookup, "path" | "platform"> & { timeoutMs: number },
) {
  const platform = options.platform ?? process.platform;
  const done = Promise.withResolvers<CliResult>();
  let child: ChildProcess | undefined;

  const deadline = setTimeout(() => {
    child?.kill("SIGKILL");
    done.resolve({ ok: false, stdout: "", stderr: "The Tailscale command-line tool did not answer in time." });
  }, options.timeoutMs);

  try {
    child = execFile(
      cli,
      [...args],
      {
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          ...(options.path !== undefined && { PATH: options.path }),
          // The macOS app also ships its CLI in this binary. Force CLI mode for scripted calls.
          ...(platform === "darwin" && { TAILSCALE_BE_CLI: "1" }),
        },
      },
      (error, stdout, stderr) => done.resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) }),
    );
  } catch {
    // Bun can also throw synchronously when the executable cannot start.
    done.resolve({ ok: false, stdout: "", stderr: "The Tailscale command-line tool could not start." });
  }

  return done.promise.finally(() => clearTimeout(deadline));
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
