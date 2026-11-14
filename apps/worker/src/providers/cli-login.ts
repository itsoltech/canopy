import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { randomUUID } from "node:crypto";
import { governNodeSpawn, killProcessTree } from "@canopy/process-governor";

export interface CliLogin {
  verificationUrl: string;
  userCode: string;
  loginId: string;
  requiresCode: boolean;
  submit?: (code: string) => void;
  done: Promise<{ success: boolean }>;
}

/** Only official CLI output is consumed. Retention is bounded and no output or authorization code is logged. */
export async function startCliLogin(options: {
  harness: "claude" | "grok";
  executable: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  signal: AbortSignal;
}): Promise<CliLogin> {
  options.signal.throwIfAborted();

  const child = governNodeSpawn("probe", () =>
    spawn(options.executable, options.harness === "claude" ? ["auth", "login"] : ["login", "--device-auth"], {
      env: { ...options.env, BROWSER: "false" },
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    }),
  );

  const ready = Promise.withResolvers<CliLogin>();
  const completed = Promise.withResolvers<{ success: boolean }>();
  let output = "";
  let bytes = 0;
  let started = false;
  let stopped = false;
  let submitted = false;

  const stop = () => {
    stopped = true;

    if (child.pid) void killProcessTree(child.pid);
  };

  const timer = setTimeout(stop, 15 * 60_000);

  const startup = setTimeout(() => {
    if (!started) stop();
  }, 45_000);

  options.signal.addEventListener("abort", stop, { once: true });

  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(startup);
    options.signal.removeEventListener("abort", stop);
    output = "";
  };

  const append = (chunk: Buffer) => {
    bytes += chunk.length;

    if (bytes > 64 * 1024) return stop();

    if (started || stopped) return;
    output += chunk.toString();
    const parsed = loginPrompt(options.harness, output);

    if (!parsed) return;
    started = true;
    output = "";
    ready.resolve({
      ...parsed,
      loginId: randomUUID(),
      requiresCode: options.harness === "claude",
      done: completed.promise,
      ...(options.harness === "claude" && {
        submit: (code: string) => {
          if (submitted || stopped || !/^[\w#.-]{1,4096}$/.test(code))
            throw new Error("The sign-in code is invalid or already submitted. Start sign-in again.");
          submitted = true;
          child.stdin.end(code + "\n");
        },
      }),
    });
  };

  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.stdin.on("error", () => {});
  child.once("error", () => {
    cleanup();
    ready.reject(new Error("Could not start the sign-in CLI. Check its installation, then retry."));
    completed.resolve({ success: false });
  });
  child.once("close", (code) => {
    cleanup();

    if (!started) ready.reject(new Error("The CLI did not provide a sign-in link. Sign in from a terminal."));
    completed.resolve({ success: !stopped && code === 0 });
  });

  return ready.promise;
}

function loginPrompt(harness: "claude" | "grok", output: string) {
  // ANSI colour escapes may straddle chunks; parse only a complete URL on a trusted provider origin.
  const plain = stripVTControlCharacters(output);

  for (const candidate of plain.matchAll(/https:\/\/[^\s<>]+/g)) {
    let url: URL;

    try {
      url = new URL(candidate[0]);
    } catch {
      continue;
    }

    if (url.username || url.password || url.port) continue;

    if (!plain.includes(candidate[0] + "\n") && !plain.includes(candidate[0] + "\r")) continue;

    if (harness === "claude") {
      if (!["claude.ai", "claude.com", "console.anthropic.com"].includes(url.hostname)) continue;

      if (!url.pathname.endsWith("/oauth/authorize") || !url.searchParams.has("state")) continue;

      return { verificationUrl: url.href, userCode: "" };
    }

    if (!["accounts.x.ai", "auth.x.ai", "grok.com", "x.ai"].includes(url.hostname)) continue;

    const code =
      plain.match(/(?:code\s*[:=]?\s+)([A-Z0-9-]{6,32})[ \t]*\r?\n/i)?.[1] ?? url.searchParams.get("user_code");

    if (code && /^[A-Z0-9-]{6,32}$/.test(code) && /\/(?:sign-in|login|device|activate)/.test(url.pathname))
      return { verificationUrl: url.href, userCode: code };
  }

  return undefined;
}
