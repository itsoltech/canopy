import { Effect, Option, Schema } from "effect";
import type { JsonValue } from "@canopy/domain";
import type { CodexAppServer, CodexMethods } from "./app-server.ts";

export interface CodexBotAuthRoute {
  readonly openaiBaseUrl: string | null;
  readonly chatgptBaseUrl: string;
  readonly explicitChatgptBaseUrl?: true;
  readonly modelCatalogUrl: string | null;
}

const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const optionalJson = Schema.optionalKey(Schema.Json);
const defaultChatgptBaseUrl = "https://chatgpt.com/backend-api/";

const configResponse = Schema.Struct({
  config: Schema.Struct({
    model_provider: Schema.Literal("openai"),
    openai_base_url: optionalText,
    chatgpt_base_url: optionalText,
    cli_auth_credentials_store: optionalText,
    forced_chatgpt_workspace_id: optionalJson,
    model_providers: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ openai: Schema.optionalKey(Schema.Struct({ model_catalog_url: optionalText })) })),
    ),
  }),
  origins: Schema.optionalKey(Schema.Struct({ chatgpt_base_url: optionalJson })),
});

const requirementsResponse = Schema.Struct({
  requirements: Schema.NullOr(
    Schema.Struct({
      modelProvider: optionalText,
      modelProviders: optionalJson,
      chatgptBaseUrl: optionalText,
      cliAuthCredentialsStore: optionalText,
      enforceResidency: optionalJson,
      network: optionalJson,
      application: Schema.optionalKey(Schema.NullOr(Schema.Struct({ network: optionalJson }))),
    }),
  ),
});

const incompatible = () => new Error("The bot cannot use the selected Codex profile's authentication route.");

function endpoint(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";

  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#") ||
    value.trim() !== value
  )
    throw incompatible();

  return url.href;
}

export function parseCodexBotAuthRoute(
  configResult: CodexMethods["config/read"]["result"] | JsonValue,
  requirementsResult: CodexMethods["configRequirements/read"]["result"] | JsonValue,
  requireEphemeral: boolean,
): CodexBotAuthRoute {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(configResponse)(configResult));
  const managed = Option.getOrUndefined(Schema.decodeUnknownOption(requirementsResponse)(requirementsResult));

  if (!decoded || !managed) throw incompatible();
  const { config, origins } = decoded;
  const requirements = managed.requirements;

  if (config.forced_chatgpt_workspace_id != null) throw incompatible();

  if (
    requireEphemeral &&
    (config.cli_auth_credentials_store !== "ephemeral" ||
      (requirements?.cliAuthCredentialsStore != null && requirements.cliAuthCredentialsStore !== "ephemeral"))
  )
    throw incompatible();

  // This bridge supports the built-in route. It cannot reproduce managed routing constraints.
  if (
    (requirements?.modelProvider != null && requirements.modelProvider !== "openai") ||
    requirements?.modelProviders != null ||
    requirements?.chatgptBaseUrl != null ||
    requirements?.enforceResidency != null ||
    requirements?.network != null ||
    requirements?.application?.network != null
  )
    throw incompatible();
  const catalogUrl = config.model_providers?.openai?.model_catalog_url;

  try {
    const chatgptBaseUrl = endpoint(config.chatgpt_base_url ?? defaultChatgptBaseUrl);

    return {
      openaiBaseUrl: config.openai_base_url ? endpoint(config.openai_base_url) : null,
      chatgptBaseUrl,
      // Codex can choose an auth-specific backend only when the ChatGPT URL is left at its packaged default.
      ...(chatgptBaseUrl === defaultChatgptBaseUrl &&
        config.chatgpt_base_url != null &&
        (config.chatgpt_base_url !== defaultChatgptBaseUrl || origins?.chatgpt_base_url != null) && {
          explicitChatgptBaseUrl: true,
        }),
      modelCatalogUrl: catalogUrl == null ? null : endpoint(catalogUrl),
    };
  } catch {
    throw incompatible();
  }
}

/** Read routing from Codex itself after applying CLI, project and managed configuration layers. */
export function readCodexBotAuthRoute(codex: CodexAppServer["Service"], cwd?: string) {
  return Effect.gen(function* () {
    const config = yield* codex.request("config/read", cwd ? { cwd } : {});
    const requirements = yield* codex.request("configRequirements/read", null);

    return yield* Effect.try({
      try: () => parseCodexBotAuthRoute(config, requirements, cwd !== undefined),
      catch: incompatible,
    });
  }).pipe(Effect.timeout("10 seconds"), Effect.mapError(incompatible));
}

export function checkCodexBotAuthRoute(codex: CodexAppServer["Service"], destination: CodexBotAuthRoute) {
  return readCodexBotAuthRoute(codex).pipe(
    Effect.flatMap((source) =>
      source.openaiBaseUrl === destination.openaiBaseUrl &&
      source.chatgptBaseUrl === destination.chatgptBaseUrl &&
      source.explicitChatgptBaseUrl === destination.explicitChatgptBaseUrl &&
      source.modelCatalogUrl === destination.modelCatalogUrl
        ? Effect.void
        : Effect.fail(incompatible()),
    ),
  );
}
