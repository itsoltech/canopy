import { expect, test } from "bun:test";
import type { JsonObject } from "@canopy/domain";
import { parseCodexBotAuthRoute } from "./bot-auth-route.ts";

const unmanaged = { requirements: null };
const native = { model_provider: "openai", cli_auth_credentials_store: "ephemeral" };
const unavailable = "The bot cannot use the selected Codex profile's authentication route.";

test("Codex bot auth distinguishes a configured ChatGPT URL from its auth-dependent default", () => {
  const config = { ...native, chatgpt_base_url: "https://chatgpt.com/backend-api/" };

  expect(parseCodexBotAuthRoute({ config, origins: {} }, unmanaged, true).explicitChatgptBaseUrl).toBeUndefined();
  expect(
    parseCodexBotAuthRoute({ config, origins: { chatgpt_base_url: {} } }, unmanaged, true).explicitChatgptBaseUrl,
  ).toBe(true);
});

test("Codex bot auth reads separate inference, account and catalog endpoints", () => {
  expect(parseCodexBotAuthRoute({ config: native }, unmanaged, true)).toEqual({
    openaiBaseUrl: null,
    chatgptBaseUrl: "https://chatgpt.com/backend-api/",
    modelCatalogUrl: null,
  });
  expect(
    parseCodexBotAuthRoute(
      {
        config: {
          ...native,
          openai_base_url: "https://inference.example/v1",
          chatgpt_base_url: "https://auth.example/backend-api",
          model_providers: { openai: { model_catalog_url: "https://catalog.example/models" } },
        },
      },
      unmanaged,
      true,
    ),
  ).toEqual({
    openaiBaseUrl: "https://inference.example/v1",
    chatgptBaseUrl: "https://auth.example/backend-api",
    modelCatalogUrl: "https://catalog.example/models",
  });
});

test("Codex bot auth rejects unsupported routing and durable destination storage", () => {
  const cases: JsonObject[] = [
    { model_provider: "custom" },
    { model_provider: null },
    { cli_auth_credentials_store: "file" },
    { forced_chatgpt_workspace_id: ["restricted-workspace"] },
    { openai_base_url: "http://inference.example/v1" },
    { openai_base_url: "https://inference.example/v1?fixture=marker" },
    { chatgpt_base_url: "https://fixture@auth.example/backend-api" },
    { chatgpt_base_url: "malformed destination marker" },
  ];

  for (const override of cases)
    expect(() => parseCodexBotAuthRoute({ config: { ...native, ...override } }, unmanaged, true)).toThrow(unavailable);

  const managedCases: JsonObject[] = [
    {},
    { requirements: { modelProvider: "custom" } },
    { requirements: { cliAuthCredentialsStore: "file" } },
    { requirements: { chatgptBaseUrl: "https://auth.example/backend-api" } },
    { requirements: { enforceResidency: "us" } },
    { requirements: { network: { enabled: true } } },
    { requirements: { application: { network: { enabled: true } } } },
  ];

  for (const requirements of managedCases)
    expect(() => parseCodexBotAuthRoute({ config: native }, requirements, true)).toThrow(unavailable);
});
