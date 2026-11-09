import { join } from "node:path";
import { mkdirSync } from "node:fs";
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
import { prepareCodexHome } from "../providers/codex/home.ts";
import { claudeProfileOptions } from "../providers/claude/profile.ts";
import { providersOf, resolveProfiles, type ProfileStatus, type ResolvedProfile } from "../providers/profiles.ts";
import { CodexThreads } from "../providers/codex/threads.ts";
import { accountResult } from "../providers/account-parser.ts";
import { codexProfileGroup, CommandError } from "./host-types.ts";
import type { HostContext } from "./host-context.ts";
import type { AccountQuery } from "../providers/account-status.ts";
import { accountText } from "@canopy/domain/provider-accounts";

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

  if (harness === "claude") {
    const home = prepareClaudeHome({
      dataDir: ctx.state.options.dataDir,
      path: configDir,
      ownLogin: runtime.ownLogin ?? false,
      linkDeviceLogin: config.claude.linkDeviceLogin,
      deviceClaudeHome: runtime.homePath || ctx.state.deviceHomes.claude,
    });

    configDir = home.path;
    env = { ...claudeProfileOptions(resolved, env).env, CLAUDE_CONFIG_DIR: configDir };
  } else if (harness === "codex") {
    const home = prepareCodexHome({
      dataDir: ctx.state.options.dataDir,
      path: configDir,
      ownLogin: runtime.ownLogin ?? false,
      linkDeviceLogin: config.codex.linkDeviceLogin,
      deviceCodexHome: runtime.homePath || ctx.state.deviceHomes.codex,
    });

    configDir = home.path;
    env["CODEX_HOME"] = configDir;
  } else {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    env["GROK_HOME"] = configDir;

    // Grok has no read-only account query; only the key variables are inspected, never auth.json.
    if (runtime.ownLogin || config.grok.linkDeviceLogin)
      env["GROK_AUTH_PATH"] = join(
        runtime.ownLogin ? configDir : runtime.homePath || ctx.state.deviceHomes.grok || configDir,
        "auth.json",
      );
  }

  return { configDir, env };
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

    const { env, configDir } = environment(ctx, config, resolved, harness);

    const query: AccountQuery = {
      harness,
      id: resolved.id,
      configDir,
      env,
      executable: resolved.runtime.executablePath || config[harness].executable || "",
      args: resolved.runtime.launchArgs ?? [],
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

    const account = await ctx.state.accounts.read(query, refresh);

    // Only a custom shadow home is worth showing; the default lives in the worker's data directory.
    return create(ProviderAccountEntrySchema, {
      provider,
      profileId: resolved.id,
      account: {
        ...account,
        configDir: resolved.runtime.shadowHomePath ? account.configDir : "",
        loginDir:
          resolved.kind === "native"
            ? accountText(
                resolved.runtime.ownLogin ? configDir : resolved.runtime.homePath || ctx.state.deviceHomes[harness],
                query.secrets,
              )
            : "",
        loginExecutable: resolved.kind === "native" ? accountText(query.executable, query.secrets) : "",
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

export async function providerAccounts(ctx: HostContext, request: GetProviderAccounts) {
  const config = ctx.state.config;

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
