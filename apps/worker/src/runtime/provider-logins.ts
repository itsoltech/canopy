import { mkdirSync, realpathSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { Provider, type CompleteLogin, type LogoutProvider } from "@canopy/contracts";
import { runProcess } from "@canopy/process-governor";
import { Match } from "effect";
import { instanceShadowHome } from "../config/remote.ts";
import { providersOf } from "../providers/profiles.ts";
import { startCliLogin, type CliLogin } from "../providers/cli-login.ts";
import { startCodexDeviceLogin } from "../providers/codex/login.ts";
import { codexAppServerLaunch } from "../providers/codex/launch.ts";
import { prepareCodexHome } from "../providers/codex/home.ts";
import { prepareClaudeHome } from "../providers/claude/home.ts";
import { grokAuthPath } from "../providers/grok/home.ts";
import { CommandError, type CommandOutput } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";

type Login = Omit<CliLogin, "requiresCode"> & { requiresCode?: boolean };

/** A store, rather than an instance alias, owns a single auth mutation at a time. */
export class ProviderLogins {
  readonly #running = new Map<string, Promise<Login>>();
  readonly #logout = new Map<string, Promise<void>>();
  readonly #codes = new Map<string, { key: string; submit: (code: string) => void }>();
  constructor(readonly ctx: HostContext) {}

  target(provider: Provider, id: string) {
    const config = this.ctx.state.config;

    if (!config || this.ctx.state.closing)
      throw new CommandError("WORKER_NOT_CONFIGURED", "The worker is not ready. Reconnect, then retry.", false);

    const harness: "claude" | "codex" | "grok" | undefined =
      provider === Provider.CLAUDE
        ? "claude"
        : provider === Provider.CODEX
          ? "codex"
          : provider === Provider.GROK
            ? "grok"
            : undefined;

    if (!harness) throw new CommandError("UNSUPPORTED", "Choose an agent CLI.", true);

    const status = config.profiles.find(
      (p) => p.config.id === (id || "native") && providersOf(p.config).includes(harness),
    );

    if (!status || status.config.disabled || status.config.kind !== "native")
      throw new CommandError("UNKNOWN_PROFILE", "Choose an enabled device-login instance.", true);
    const runtime = status.config.runtime ?? {};

    if (!runtime.ownLogin && !config[harness].linkDeviceLogin)
      throw new CommandError("UNSUPPORTED", "Device login is disabled. Use an instance with its own login.", true);
    const executable = runtime.executablePath || config[harness].executable;

    if (!config[harness].enabled || !executable)
      throw new CommandError(
        "PROVIDER_UNAVAILABLE",
        "The agent CLI is unavailable. Check its installation, then retry.",
        false,
      );

    const home = resolve(
      runtime.ownLogin
        ? instanceShadowHome(this.ctx.state.options.dataDir, harness, status.config.id, runtime)!
        : runtime.homePath ||
            this.ctx.state.deviceHomes[harness] ||
            join(this.ctx.state.options.dataDir, `${harness}-home`),
    );

    mkdirSync(home, { recursive: true, mode: 0o700 });

    if (runtime.ownLogin && harness === "codex")
      prepareCodexHome({ dataDir: this.ctx.state.options.dataDir, path: home, ownLogin: true, linkDeviceLogin: false });

    if (runtime.ownLogin && harness === "claude")
      prepareClaudeHome({
        dataDir: this.ctx.state.options.dataDir,
        path: home,
        ownLogin: true,
        linkDeviceLogin: false,
      });
    const env: NodeJS.ProcessEnv = { ...process.env };

    // Auth commands deliberately receive no profile secrets or arbitrary launch arguments.
    if (harness === "claude") {
      env["CLAUDE_CONFIG_DIR"] = home;
      env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] =
        runtime.ownLogin || runtime.homePath ? home : (this.ctx.state.deviceHomes.claudeSecureStorage ?? home);
    } else if (harness === "codex") env["CODEX_HOME"] = home;
    else {
      env["GROK_HOME"] = home;
      env["GROK_AUTH_PATH"] = grokAuthPath({
        dataDir: this.ctx.state.options.dataDir,
        id: status.config.id,
        runtime,
        deviceHome: this.ctx.state.deviceHomes.grok,
        deviceAuthPath: this.ctx.state.deviceHomes.grokAuthPath,
      });
    }

    const authPath = harness === "grok" ? env["GROK_AUTH_PATH"] : undefined;

    const store = authPath
      ? dirname(authPath)
      : harness === "claude"
        ? env["CLAUDE_SECURESTORAGE_CONFIG_DIR"] || home
        : home;

    mkdirSync(store, { recursive: true, mode: 0o700 });

    const key = `${harness}/${realpathSync(store)}${authPath ? `/${basename(authPath)}` : ""}`;

    return { harness, home, executable, env, id: status.config.id, key, config };
  }

  async start(provider: Provider, id: string): Promise<NonNullable<CommandOutput["login"]>> {
    const target = this.target(provider, id);

    if (this.#logout.has(target.key))
      throw new CommandError("LOGIN_BUSY", "Sign-out is running. Wait, then retry.", false);
    let pending = this.#running.get(target.key);

    if (!pending) {
      pending = this.#start(target).catch(() => {
        throw new CommandError(
          "LOGIN_FAILED",
          "The CLI did not provide a sign-in link. Sign in from a terminal.",
          false,
        );
      });
      this.#running.set(target.key, pending);
      void pending.catch(() => this.#running.delete(target.key));
    }

    const login = await pending;
    const outcomeKey = `${target.harness}/${target.id}`;

    if (this.ctx.state.loginOutcomes.get(outcomeKey)?.loginId !== login.loginId) {
      this.ctx.state.loginOutcomes.set(outcomeKey, { loginId: login.loginId, outcome: "pending" });
      void login.done
        .then(async (result) => {
          if (this.ctx.state.loginOutcomes.get(outcomeKey)?.loginId === login.loginId)
            this.ctx.state.loginOutcomes.set(outcomeKey, {
              loginId: login.loginId,
              outcome: result.success ? "signed_in" : "failed",
            });
          await this.#refresh(target);
        })
        .catch(() => {});
    }

    return {
      verificationUrl: login.verificationUrl,
      userCode: login.userCode,
      loginId: login.loginId,
      requiresCode: login.requiresCode ?? false,
    };
  }

  async #start(target: ReturnType<ProviderLogins["target"]>): Promise<Login> {
    const login =
      target.harness === "codex"
        ? await startCodexDeviceLogin({
            launch: codexAppServerLaunch([], target.env, target.executable, target.config.nativeTools),
            clientVersion: this.ctx.state.options.clientVersion,
            signal: this.ctx.state.authAbort.signal,
          })
        : await startCliLogin({
            harness: target.harness,
            executable: target.executable,
            env: target.env,
            cwd: target.home,
            signal: this.ctx.state.authAbort.signal,
          });

    if ("submit" in login && login.submit) this.#codes.set(login.loginId, { key: target.key, submit: login.submit });
    void login.done.finally(() => {
      this.#running.delete(target.key);
      this.#codes.delete(login.loginId);
    });

    return login;
  }

  complete(request: CompleteLogin): void {
    const target = this.target(request.provider, request.profileId);
    const waiting = this.#codes.get(request.loginId);
    const outcome = this.ctx.state.loginOutcomes.get(`${target.harness}/${target.id}`);

    if (!waiting || waiting.key !== target.key || outcome?.loginId !== request.loginId)
      throw new CommandError("LOGIN_NOT_FOUND", "This sign-in is no longer waiting. Start it again.", false);

    try {
      waiting.submit(request.code.trim());
    } catch {
      throw new CommandError(
        "LOGIN_CODE_INVALID",
        "The sign-in code is invalid or already submitted. Start sign-in again.",
        false,
      );
    }

    this.#codes.delete(request.loginId);
  }

  async logout(request: LogoutProvider): Promise<void> {
    const target = this.target(request.provider, request.profileId);

    if (this.#running.has(target.key))
      throw new CommandError("LOGIN_BUSY", "Sign-in is running. Finish it before signing out.", false);
    const running = this.#logout.get(target.key);

    if (running) return running;
    const task = this.#signOut(target).finally(() => this.#logout.delete(target.key));
    this.#logout.set(target.key, task);

    return task;
  }

  async #signOut(target: ReturnType<ProviderLogins["target"]>) {
    const result = await runProcess(
      {
        argv: [target.executable, ...(target.harness === "claude" ? ["auth", "logout"] : ["logout"])],
        env: target.env,
        cwd: target.home,
        timeoutMs: 15_000,
        maxBytes: 64 * 1024,
        signal: this.ctx.state.authAbort.signal,
      },
      { kind: "probe" },
    ).catch(() => undefined);

    if (result?.code !== 0)
      throw new CommandError("LOGOUT_FAILED", "The CLI did not sign out. Check it in a terminal, then refresh.", false);
    await this.#refresh(target);
  }

  async #refresh(target: ReturnType<ProviderLogins["target"]>) {
    for (const profile of target.config.profiles) {
      if (!providersOf(profile.config).includes(target.harness)) continue;

      if (profile.config.disabled || profile.config.kind !== "native") continue;

      if (!profile.config.runtime?.ownLogin && !target.config[target.harness].linkDeviceLogin) continue;

      const current = this.target(
        Match.value(target.harness).pipe(
          Match.when("claude", () => Provider.CLAUDE),
          Match.when("codex", () => Provider.CODEX),
          Match.orElse(() => Provider.GROK),
        ),
        profile.config.id,
      );

      if (current.key === target.key) {
        const key = `${target.harness}/${current.id}`;
        this.ctx.state.loginGenerations.set(key, (this.ctx.state.loginGenerations.get(key) ?? 0) + 1);
      }
    }

    this.ctx.state.accounts.invalidate();
    await this.ctx.ops.probe().catch(() => {});
    await this.ctx.ops.reconcileRuntimes().catch(() => {});
  }
}
