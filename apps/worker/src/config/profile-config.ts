import { Match } from "effect";
import { Provider, ProviderProfileKind, type WorkerConfig } from "@canopy/contracts";
import type { ProviderProfileConfig } from "../providers/profiles.ts";

export function profileConfig(
  profile: WorkerConfig["profiles"][number],
  index: number,
  issue: (path: string, message: string, fatal?: boolean) => void,
): ProviderProfileConfig | undefined {
  const common = {
    id: profile.id,
    ...(profile.providers.length > 0 && {
      providers: profile.providers.map((p) =>
        Match.value(p).pipe(
          Match.when(Provider.CLAUDE, () => "claude" as const),
          Match.when(Provider.GROK, () => "grok" as const),
          Match.orElse(() => "codex" as const),
        ),
      ),
    }),
    ...(profile.displayName && { displayName: profile.displayName }),
    ...(profile.env.length > 0 && {
      env: profile.env.map((v) => ({ name: v.name, value: v.value, secret: v.secret })),
    }),
    ...(profile.disabled && { disabled: true }),
    ...((profile.executablePath ||
      profile.homePath ||
      profile.shadowHomePath ||
      profile.launchArgs.length > 0 ||
      profile.ownLogin ||
      profile.userConfiguration) && {
      runtime: {
        ...(profile.userConfiguration && {
          userConfiguration: {
            mode: profile.userConfiguration.mode,
            sourcePath: profile.userConfiguration.sourcePath,
            instructions: profile.userConfiguration.instructions,
            skills: profile.userConfiguration.skills,
            hooks: profile.userConfiguration.hooks,
          },
        }),
        ...(profile.executablePath && { executablePath: profile.executablePath }),
        ...(profile.homePath && { homePath: profile.homePath }),
        ...(profile.shadowHomePath && { shadowHomePath: profile.shadowHomePath }),
        ...(profile.launchArgs.length > 0 && { launchArgs: [...profile.launchArgs] }),
        ...(profile.ownLogin && { ownLogin: true }),
      },
    }),
  };

  switch (profile.kind) {
    case ProviderProfileKind.NATIVE:
      return { kind: "native", ...common };
    case ProviderProfileKind.CLIPROXYAPI:
      return {
        kind: "cliproxyapi",
        ...common,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
        ...(profile.proxyCodex && { codex: profile.proxyCodex }),
      };
    default:
      issue(`profiles[${index}].kind`, `unsupported profile kind for "${profile.id}"`);

      return undefined;
  }
}
