import { join, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import {
  Provider,
  ProviderAccountEntrySchema,
  ProviderAccountsReportSchema,
  type GetProviderAccounts,
} from "@canopy/contracts";
import { Context, Effect } from "effect";
import { instanceShadowHome, type AppliedConfig } from "../config/remote.ts";
import { prepareClaudeHome } from "../providers/claude/home.ts";
import { directCodexHome, prepareCodexInstanceHome } from "../providers/codex/home.ts";
import { claudeProfileOptions } from "../providers/claude/profile.ts";
import { providersOf, resolveProfiles, type ProfileStatus, type ResolvedProfile } from "../providers/profiles.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { accountResult, loginRevision } from "../providers/account-parser.ts";
import { ClaudeThreads } from "../providers/claude/threads.ts";
import { codexProfileGroup, CommandError } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import type { AccountQuery } from "../providers/account-status.ts";
import { accountText } from "@canopy/domain/provider-accounts";
import { grokAuthPath } from "../providers/grok/home.ts";

type Harness = AccountQuery["harness"];

const providers = { claude: Provider.CLAUDE, codex: Provider.CODEX, grok: Provider.GROK };
const providerOf = (harness: Harness) => providers[harness];

/** Use the same shadow home and login-link policies as the instance's harness runtime. */
function environment(ctx: HostContext, config: AppliedConfig, resolved: ResolvedProfile, harness: Harness) {
  const runtime = resolved.runtime;

  let configDir =
    instanceShadowHome(ctx.state.options.dataDir, harness, resolved.id, runtime) ??
    join(ctx.state.options.dataDir, `${harness}-home`);

  let env: NodeJS.ProcessEnv = { ...process.env, ...resolved.env };
  let loginLinkProblem: string | undefined;
  let cliHome = false;

  if (harness === "claude") {
    const home = prepareClaudeHome({
      dataDir: ctx.state.options.dataDir,
      path: configDir,
      ownLogin: runtime.ownLogin ?? false,
      linkDeviceLogin: config.claude.linkDeviceLogin,
      deviceClaudeHome: runtime.homePath || ctx.state.deviceHomes.claude,
      protectedDeviceHome: ctx.state.deviceHomes.claude,
      ...(!runtime.homePath && { deviceSecureStorage: ctx.state.deviceHomes.claudeSecureStorage }),
    });

    configDir = home.path;

    env = {
      ...claudeProfileOptions(resolved, env).env,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: home.secureStorageDir,
    };
  } else if (harness === "codex") {
    const home = prepareCodexInstanceHome(resolved, {
      dataDir: ctx.state.options.dataDir,
      path: configDir,
      linkDeviceLogin: config.codex.linkDeviceLogin,
      deviceHome: ctx.state.deviceHomes.codex,
    });

    configDir = home.path;
    cliHome = home.login === "cli";

    if (cliHome) env = { ...process.env };
    env["CODEX_HOME"] = configDir;
    loginLinkProblem = home.linkFailed ? home.problem : undefined;
  } else {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    env["GROK_HOME"] = configDir;
    delete env["GROK_AUTH_PATH"];

    // Grok has no read-only account query; only the key variables are inspected, never auth.json.
    if (runtime.ownLogin || config.grok.linkDeviceLogin)
      env["GROK_AUTH_PATH"] = grokAuthPath({
        dataDir: ctx.state.options.dataDir,
        id: resolved.id,
        runtime,
        deviceHome: ctx.state.deviceHomes.grok,
        deviceAuthPath: ctx.state.deviceHomes.grokAuthPath,
      });
  }

  return { configDir, env, loginLinkProblem, cliHome };
}

async function readEntry(
  ctx: HostContext,
  config: AppliedConfig,
  status: ProfileStatus,
  harness: Harness,
  refresh: boolean,
) {
  const provider = providerOf(harness);

  try {
    // A missing login disables the runtime, but its validated configuration can still be queried.
    const resolved =
      status.resolved ??
      resolveProfiles([status.config]).find(
        (p) => p.config.id === status.config.id && providersOf(p.config).includes(harness),
      )?.resolved;

    if (!resolved) {
      const account = accountResult("unknown", "", "The instance configuration is unavailable.");

      if (status.config.kind === "cliproxyapi") {
        account.state = "signed_out";
        account.authMethod = "Proxy";
        account.proxyName = accountText(status.config.displayName || status.config.id, [status.config.apiKey]);
      }

      return create(ProviderAccountEntrySchema, {
        provider,
        profileId: status.config.id,
        account,
      });
    }

    const { env, configDir, loginLinkProblem, cliHome } = environment(ctx, config, resolved, harness);

    const query: AccountQuery = {
      harness,
      id: resolved.id,
      configDir,
      env,
      executable: resolved.runtime.executablePath || config[harness].executable || "",
      args: cliHome ? [] : (resolved.runtime.launchArgs ?? []),
      configVersion: config.version,
      secrets: [
        ...(resolved.kind === "cliproxyapi" ? [resolved.apiKey] : []),
        ...(status.config.env ?? []).filter((v) => v.secret).map((v) => v.value),
        ...Object.entries(env).flatMap(([name, value]) =>
          value && /key|token|secret|password|auth/i.test(name) ? [value] : [],
        ),
      ],
      ...(resolved.kind === "cliproxyapi" && {
        proxy: { name: status.config.displayName || resolved.id, configured: true },
      }),
      ...(harness === "codex" && {
        codexMetadata: async () => {
          const group = codexProfileGroup(resolved.id);

          if (ctx.state.staleRuntimes.has(`codex/${group}`)) return undefined;
          const running = ctx.state.codex.get(group);

          if (!running) return undefined;

          return ctx.state.options.runtime
            .runPromise(Context.get(running.context, CodexThreads).readAccount().pipe(Effect.timeout("3 seconds")))
            .catch(() => undefined);
        },
      }),
    };

    const account =
      loginLinkProblem && resolved.kind === "native"
        ? accountResult("error", configDir, loginLinkProblem)
        : await ctx.state.accounts.read(query, refresh);

    const claude = harness === "claude" ? ctx.state.claude.get(resolved.id) : undefined;

    if (claude && !ctx.state.staleRuntimes.has(`claude/${resolved.id}`))
      await ctx.state.options.runtime.runPromise(
        Context.get(claude.context, ClaudeThreads).readUsage().pipe(Effect.timeout("3 seconds"), Effect.ignore),
      );

    const loginDir =
      resolved.kind === "native"
        ? cliHome || resolved.runtime.ownLogin || !config[harness].linkDeviceLogin
          ? configDir
          : (harness === "claude" && env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]) ||
            resolved.runtime.homePath ||
            ctx.state.deviceHomes[harness] ||
            ""
        : "";

    // Only a custom shadow home is worth showing; the default lives in the worker's data directory.
    return create(ProviderAccountEntrySchema, {
      provider,
      profileId: resolved.id,
      account: {
        ...account,
        configDir: cliHome || resolved.runtime.shadowHomePath ? account.configDir : "",
        loginDir: accountText(loginDir, query.secrets),
        loginExecutable: resolved.kind === "native" ? accountText(query.executable, query.secrets) : "",
        ...(harness === "claude" && {
          loginSecureStorageDir: accountText(env["CLAUDE_SECURESTORAGE_CONFIG_DIR"], query.secrets),
        }),
        // Read on every report, not cached: the gateway compares it with the login a turn was rejected with.
        loginRevision: loginRevision(harness, loginDir),
        loginId: ctx.state.loginOutcomes.get(`${harness}/${resolved.id}`)?.loginId ?? "",
        loginOutcome: ctx.state.loginOutcomes.get(`${harness}/${resolved.id}`)?.outcome ?? "",
      },
    });
  } catch {
    return create(ProviderAccountEntrySchema, {
      provider,
      profileId: status.config.id,
      account: accountResult("error", "", "Could not read account status from the CLI."),
    });
  }
}

/** An OS keyring exposes no file revision. An explicit refresh reloads each alias of that store. */
function refreshKeyring(ctx: HostContext, config: AppliedConfig, profileId: string): boolean {
  const homes = new Map<string, string>();

  for (const status of config.profiles) {
    if (status.codexLoginRevision !== "" || !status.resolved) continue;
    const home = directCodexHome(status.config, config.codex.linkDeviceLogin, ctx.state.deviceHomes.codex);

    if (!home || loginRevision("codex", home)) continue;

    try {
      homes.set(status.config.id, realpathSync(home));
    } catch {
      homes.set(status.config.id, resolve(home));
    }
  }

  const selected = profileId ? homes.get(profileId) : undefined;
  let changed = false;

  for (const [id, home] of homes) {
    if (profileId && home !== selected) continue;
    const key = `codex/${id}`;
    ctx.state.loginGenerations.set(key, (ctx.state.loginGenerations.get(key) ?? 0) + 1);
    changed = true;
  }

  return changed;
}

export async function providerAccounts(ctx: HostContext, request: GetProviderAccounts) {
  let config = ctx.state.config;

  // Account-only Refresh skips ProbeProviders. Recheck availability and drain any process that still holds
  // the prior login, including other instances that use the same device home.
  if (
    request.refresh &&
    (!request.provider || request.provider === Provider.CODEX) &&
    config?.version === request.configVersion
  ) {
    const keyring = refreshKeyring(ctx, config, request.profileId);

    const changed = config.profiles.some(
      (p) =>
        (!request.profileId || p.config.id === request.profileId) &&
        p.codexLoginRevision !== undefined &&
        p.loginHomePath &&
        p.codexLoginRevision !== loginRevision("codex", p.loginHomePath),
    );

    if (keyring || changed) ctx.state.accounts.invalidate();

    if (changed) {
      await ctx.ops.probe();
      config = ctx.state.config;
    } else if (keyring) await ctx.ops.reconcileRuntimes();
  }

  if (!config || config.version !== request.configVersion)
    throw new CommandError("CONFIG_CHANGED", "Provider configuration changed; refresh again.", false);

  const entries = await Promise.all(
    config.profiles.flatMap((status) =>
      providersOf(status.config).flatMap((harness) => {
        if (
          status.config.disabled ||
          (request.provider && request.provider !== providerOf(harness)) ||
          (request.profileId && request.profileId !== status.config.id)
        )
          return [];

        return [readEntry(ctx, config, status, harness, request.refresh)];
      }),
    ),
  );

  return create(ProviderAccountsReportSchema, { configVersion: config.version, entries });
}
