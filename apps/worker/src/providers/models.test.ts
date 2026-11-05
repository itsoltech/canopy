import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDirs } from "@canopy/testing";
import { claudeConfiguredEffort, codexConfiguredEffort, readClaudeUserSettings } from "./default-effort.ts";
import { classifyLegacyModels } from "./model-metadata.ts";
import {
  claudeAgentModels,
  claudeModel,
  codexModel,
  codexProxyModels,
  isAgentModel,
  proxyCapabilities,
  proxyModels,
  proxyModelFits,
} from "./models.ts";

const proxy = {
  kind: "cliproxyapi" as const,
  id: "cliproxy",
  baseUrl: new URL("http://proxy.internal:8317"),
  apiKey: "sk-test",
  providers: ["claude" as const, "codex" as const],
  env: {},
  runtime: {},
};

const tempDir = tempDirs();

describe("harness default effort settings", () => {
  test("Codex ignores invalid profile settings without losing the global fallback", () => {
    expect(
      codexConfiguredEffort(`
      profile = "chosen"
      model_reasoning_effort = " HIGH "
      unrelated_date = 2026-01-01T00:00:00Z
      [profiles.chosen]
      model_reasoning_effort = 42
      [profiles.other]
      model_reasoning_effort = "low"
    `),
    ).toBe("high");
    expect(
      codexConfiguredEffort(`
      profile = "chosen"
      model_reasoning_effort = "low"
      [profiles.chosen]
      model_reasoning_effort = " XHIGH "
      [profiles.other]
      model_reasoning_effort = false
    `),
    ).toBe("xhigh");
  });

  test("Claude ignores invalid model entries and retains model, global and environment precedence", () => {
    const home = tempDir("canopy-effort-");
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({
        effortLevel: " HIGH ",
        modelSettings: {
          invalid: null,
          broken: { effortLevel: 42 },
          "claude-sonnet-4-5": { effortLevel: " LOW " },
        },
      }),
    );
    const settings = readClaudeUserSettings(home);

    expect(claudeConfiguredEffort(settings, {}, ["claude-sonnet-4-5-20250929[1m]"])).toBe("low");
    expect(claudeConfiguredEffort(settings, {}, ["broken"])).toBe("high");
    expect(claudeConfiguredEffort(settings, { CLAUDE_CODE_EFFORT_LEVEL: "max" }, ["broken"])).toBe("max");
    expect(claudeConfiguredEffort(settings, { CLAUDE_CODE_EFFORT_LEVEL: "auto" }, ["broken"])).toBeUndefined();
  });
});

describe("model catalogs", () => {
  test("Codex model/list entries keep their efforts and default", () => {
    const model = {
      id: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      description: "",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "xhigh", description: "" },
      ],
      defaultReasoningEffort: "low",
    } satisfies Parameters<typeof codexModel>[0];

    expect(codexModel(model)).toEqual({
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      description: "",
      hidden: false,
      legacy: false,
      isDefault: true,
      efforts: ["low", "xhigh"],
      defaultEffort: "low",
    });
    // The device owner's configured default wins when the model offers it, else the model's own stays.
    expect(codexModel(model, "xhigh").defaultEffort).toBe("xhigh");
    expect(codexModel(model, "minimal").defaultEffort).toBe("low");
  });

  test("Claude supportedModels: aliases resolve, the default row is the default, no effort support = no efforts", () => {
    expect(
      claudeModel({
        value: "haiku",
        resolvedModel: "claude-haiku-5-5",
        displayName: "Haiku",
        description: "",
        supportsEffort: true,
        supportedEffortLevels: ["low", "max"],
      }),
    ).toEqual({
      id: "haiku",
      resolvedModel: "claude-haiku-5-5",
      displayName: "Claude Haiku 5.5",
      description: "",
      isDefault: false,
      efforts: ["low", "max"],
    });
    expect(
      claudeModel({ value: "default", resolvedModel: "default", displayName: "Default", description: "" }),
    ).toMatchObject({ isDefault: true, efforts: [] });
    expect(
      claudeModel({ value: "claude-3-7-sonnet", displayName: "3.7", description: "", supportsEffort: false }),
    ).toMatchObject({ efforts: [] });

    // Claude Code reports no default: only a configured one the model offers.
    const opus = {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus",
      description: "",
      supportedEffortLevels: ["low", "high", "xhigh"] as ("low" | "high" | "xhigh")[],
    };

    expect(claudeModel(opus, "xhigh").defaultEffort).toBe("xhigh");
    expect(claudeModel(opus, "max").defaultEffort).toBeUndefined();
    expect(claudeModel(opus).defaultEffort).toBeUndefined();
    expect(
      claudeModel({ value: "claude-3-7-sonnet", displayName: "3.7", description: "", supportsEffort: false }, "high")
        .defaultEffort,
    ).toBeUndefined();
  });

  test("agent models: reported output modalities first, name words only without them; no efforts is fine", () => {
    // Metadata decides.
    expect(
      isAgentModel(["gemini-3-flash"], { outputModalities: ["text"], generationMethods: ["generateContent"] }),
    ).toBe(true);
    expect(isAgentModel(["gemini-3.1-flash-image"], { outputModalities: ["text", "image"] })).toBe(false);
    expect(isAgentModel(["grok-imagine-video-1.5-lite"], { outputModalities: ["video"] })).toBe(false);
    expect(isAgentModel(["text-embedding-4"], { generationMethods: ["embedContent"] })).toBe(false);
    // Text-only output beats a name word.
    expect(isAgentModel(["voice-agent-chat"], { outputModalities: ["text"] })).toBe(true);

    // No metadata: name words (id or display name).
    for (const id of [
      "gpt-image-2.5",
      "grok-imagine-image",
      "grok-tts",
      "grok-voice-tts-1.0",
      "gpt-realtime-2",
      "gpt-4o-mini-transcribe",
      "omni-moderation-latest",
      "text-embedding-3-large",
      "dall-e-3",
      "sora-2",
      "whisper-1",
    ]) {
      expect([id, isAgentModel([id])]).toEqual([id, false]);
    }

    expect(isAgentModel(["claude-fable-5-dd-2-egami-tpg", "GPT Image 2"])).toBe(false);

    for (const id of [
      "grok-4.7",
      "grok-4.20-0309-non-reasoning",
      "grok-composer-2.5-fast",
      "gemini-3.5-flash-lite",
      "claude-3-5-haiku-20241022",
      "gpt-oss-120b-medium",
      "codex-auto-review",
    ]) {
      expect([id, isAgentModel([id])]).toEqual([id, true]);
    }
  });

  test("Claude labels resolve changing SDK aliases without changing saved ids or effort data", () => {
    const alias = { value: "opus", displayName: "Opus", description: "", supportedEffortLevels: ["high" as const] };

    const resolvedNames: readonly (readonly [string, string])[] = [
      ["claude-opus-5-5", "Claude Opus 5.5"],
      ["claude-opus-7-12-20261105[1m]", "Claude Opus 7.12 · 1M context"],
      ["claude-3-7-sonnet-20250219", "Claude Sonnet 3.7"],
    ];

    for (const [resolvedModel, name] of resolvedNames) {
      expect(claudeModel({ ...alias, resolvedModel })).toMatchObject({
        id: "opus",
        resolvedModel,
        displayName: name,
        efforts: ["high"],
      });
    }

    expect(claudeModel({ ...alias, description: "Opus 8.2 · Everyday tasks · $4/$20 per Mtok" }).displayName).toBe(
      "Claude Opus 8.2",
    );
    expect(claudeModel({ ...alias, displayName: "Claude Opus 8.3" }).displayName).toBe("Claude Opus 8.3");
    expect(claudeModel(alias).displayName).toBe("Opus");
    expect(claudeModel({ value: "private-agent", displayName: "Private agent", description: "" })).toMatchObject({
      id: "private-agent",
      displayName: "Private agent",
    });
  });

  test("legacy follows catalog upgrades and older versions within the same family and variant", () => {
    const catalog = [
      { id: "opus", resolvedModel: "claude-opus-8-2", displayName: "Claude Opus 8.2" },
      { id: "claude-opus-8-1" },
      { id: "claude-opus-8-1[1m]" },
      { id: "claude-haiku-7-1" },
      { id: "gpt-9.1-sol" },
      { id: "gpt-9-sol" },
      { id: "private", legacy: true },
      { id: "hidden", hidden: true },
    ];

    expect(classifyLegacyModels(catalog).map((m) => [m.id, m.legacy])).toEqual([
      ["opus", false],
      ["claude-opus-8-1", true],
      ["claude-opus-8-1[1m]", false],
      ["claude-haiku-7-1", false],
      ["gpt-9.1-sol", false],
      ["gpt-9-sol", true],
      ["private", true],
      ["hidden", true],
    ]);
    expect(classifyLegacyModels([{ id: "claude-opus-8-1" }])[0]?.legacy).toBe(false);

    expect(
      codexModel({
        id: "old",
        model: "old",
        displayName: "Old",
        description: "",
        hidden: false,
        isDefault: false,
        upgrade: "new",
        supportedReasoningEfforts: [],
        defaultReasoningEffort: "low",
      }),
    ).toMatchObject({ id: "old", hidden: false, legacy: true });
  });

  test("Claude aliases share one row while context variants and older models stay distinct", () => {
    const row = (value: string, resolvedModel: string, displayName = value) => ({
      value,
      resolvedModel,
      displayName,
      description: "",
      supportedEffortLevels: ["low" as const, "high" as const],
    });

    const catalog = classifyLegacyModels(
      claudeAgentModels([
        row("default", "claude-opus-5-5"),
        row("opus", "claude-opus-5-5"),
        row("opus[1m]", "claude-opus-5-5", "Opus (1M context)"),
        row("sonnet", "claude-sonnet-5-5"),
        row("sonnet[1m]", "claude-sonnet-5-5", "Sonnet (1M context)"),
        row("haiku", "claude-haiku-5-5"),
        row("claude-opus-5-5", "claude-opus-5-5"),
        row("claude-opus-4-6", "claude-opus-4-6"),
        row("claude-opus-4-6[1m]", "claude-opus-4-6"),
        row("claude-sonnet-4-6", "claude-sonnet-4-6"),
        row("claude-haiku-4-5", "claude-haiku-4-5"),
      ]).map((m) => claudeModel(m, "high")),
    );

    expect(catalog.map((m) => [m.id, m.displayName, Boolean(m.isDefault), m.legacy])).toEqual([
      ["opus", "Claude Opus 5.5", true, false],
      ["opus[1m]", "Claude Opus 5.5 · 1M context", false, false],
      ["sonnet", "Claude Sonnet 5.5", false, false],
      ["sonnet[1m]", "Claude Sonnet 5.5 · 1M context", false, false],
      ["haiku", "Claude Haiku 5.5", false, false],
      ["claude-opus-4-6", "Claude Opus 4.6", false, true],
      ["claude-opus-4-6[1m]", "Claude Opus 4.6 · 1M context", false, true],
      ["claude-sonnet-4-6", "Claude Sonnet 4.6", false, true],
      ["claude-haiku-4-5", "Claude Haiku 4.5", false, true],
    ]);
    expect(catalog[0]).toMatchObject({ aliases: ["default"], efforts: ["low", "high"], defaultEffort: "high" });
    expect(new Set(catalog.map((m) => m.displayName)).size).toBe(catalog.length);
    // SDK context metadata can occur in a label, independently of the alias spelling.
    expect(claudeModel(row("long-context", "claude-opus-5-5", "Opus (2M context)")).displayName).toBe(
      "Claude Opus 5.5 · 2M context",
    );
  });

  test("all harness catalogs and proxy additions dedupe before assigning legacy status", () => {
    const codex = classifyLegacyModels(
      codexProxyModels(
        [
          { id: "gpt-9.1-sol", displayName: "GPT 9.1 Sol", efforts: ["high"] },
          { id: "old-alias", displayName: "GPT 9.1 Sol", legacy: true, hidden: true },
        ],
        [
          { id: "gpt-9.1-sol", ownedBy: "openai" },
          { id: "old-alias", ownedBy: "openai", supportedEndpoints: ["responses"] },
          { id: "grok-9.1", ownedBy: "xai", displayName: "Grok 9.1" },
          { id: "grok-alias", ownedBy: "xai", displayName: "Grok 9.1" },
        ],
      ),
    );

    expect(codex.map((m) => [m.id, m.aliases, m.legacy])).toEqual([
      ["gpt-9.1-sol", ["old-alias"], false],
      ["grok-9.1", ["grok-alias"], false],
    ]);

    const grok = classifyLegacyModels([
      { id: "grok-current", displayName: "Grok 9.1", isDefault: true },
      { id: "grok-9.1", displayName: "Grok 9.1" },
      { id: "grok-9", displayName: "Grok 9" },
    ]);

    expect(grok.map((m) => [m.id, Boolean(m.isDefault), m.legacy])).toEqual([
      ["grok-current", true, false],
      ["grok-9", false, true],
    ]);
    expect(grok[0]?.aliases).toEqual(["grok-9.1"]);
  });

  test("one proxy catalog stays scoped by family and wire protocol for every harness", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/v1/models") return new Response(null, { status: 404 });

        if (request.headers.get("authorization") !== "Bearer sk-test") return new Response(null, { status: 401 });

        return Response.json({
          data: [
            { id: "claude-opus-8-2", owned_by: "antigravity", display_name: "Claude Opus 8.2" },
            { id: "gpt-9.1-sol", owned_by: "openai" },
            { id: "grok-8.2", owned_by: "xai" },
            { id: "gemini-8-flash", owned_by: "google", supported_endpoint_types: ["responses"] },
            { id: "private-responses", owned_by: "private", supported_endpoint_types: ["responses"] },
            { id: "private-chat", owned_by: "openai", supported_endpoint_types: ["chat_completions"] },
            { id: "claude-chat-only", owned_by: "anthropic", supported_endpoint_types: ["chat_completions"] },
            { id: "grok-messages-only", owned_by: "xai", supported_endpoint_types: ["messages"] },
            { id: "gpt-image-8", owned_by: "openai" },
            { id: "unknown", owned_by: "private" },
          ],
        });
      },
    });

    try {
      const served = await proxyModels({ ...proxy, baseUrl: new URL(server.url) });

      const ids = (harness: "claude" | "codex" | "grok") =>
        served.filter((m) => proxyModelFits(harness, m)).map((m) => m.id);

      expect(ids("claude")).toEqual(["claude-opus-8-2"]);
      expect(ids("codex")).toEqual(["gpt-9.1-sol", "grok-8.2", "private-responses"]);
      expect(ids("grok")).toEqual(["grok-8.2"]);
      expect(
        codexProxyModels([{ id: "private-chat", efforts: ["high"] }], served).some((m) => m.id === "private-chat"),
      ).toBe(false);
      expect(codexProxyModels([], served).find((m) => m.id === "private-responses")?.id).toBe("private-responses");
      expect(
        claudeAgentModels(
          [
            { value: "opus", resolvedModel: "claude-opus-8-2", displayName: "Opus", description: "" },
            { value: "claude-fable-5-dd-2-8-supo", displayName: "Claude Opus 8.2", description: "" },
            { value: "claude-fable-5-dd-2.8-korg", displayName: "Grok 8.2", description: "" },
          ],
          served,
        ).map((m) => m.value),
      ).toEqual(["opus", "claude-fable-5-dd-2-8-supo"]);
    } finally {
      server.stop(true);
    }
  });

  test("Claude through a proxy: models that cannot run a turn are left out, matched by id, alias or display name", () => {
    const row = (value: string, displayName: string, resolvedModel?: string) => ({
      value,
      displayName,
      description: "",
      ...(resolvedModel && { resolvedModel }),
    });

    const listed = [
      row("default", "Default (recommended)", "claude-opus-5-5"),
      row("claude-fable-5-dd-7.4-korg", "Grok 4.7"),
      row("claude-fable-5-dd-egami-hsalf-1.3-inimeg", "Gemini 3.1 Flash Image"),
      row("claude-fable-5-dd-stt-korg", "Grok TTS"),
      row("claude-fable-5-dd-tsaf-5.2-resopmoc-korg", "Composer 2.5 Fast"),
    ];

    const capabilities = [
      { id: "grok-4.7", ownedBy: "xai", displayName: "Grok 4.7", outputModalities: ["text"] },
      {
        id: "gemini-3.1-flash-image",
        ownedBy: "google",
        displayName: "Gemini 3.1 Flash Image",
        outputModalities: ["text", "image"],
      },
      { id: "claude-opus-5-5", ownedBy: "anthropic", displayName: "Claude Opus 5.5", outputModalities: ["text"] },
    ];

    expect(claudeAgentModels(listed, capabilities).map((m) => m.value)).toEqual(["default"]);
    // Without the proxy's capabilities the display names' words still catch the image and speech rows.
    expect(claudeAgentModels(listed).map((m) => m.value)).toEqual(["default"]);
  });

  test("Codex through a proxy: catalog models the proxy serves, then the proxy's others without efforts", () => {
    const catalog = [
      { id: "gpt-6.1-sol", isDefault: true, efforts: ["low"] },
      { id: "gpt-5.5", efforts: ["medium"] },
    ];

    const merged = codexProxyModels(catalog, [
      { id: "grok-4.7", ownedBy: "xai" },
      { id: "gpt-6.1-sol", ownedBy: "openai" },
      { id: "claude-opus-5", ownedBy: "anthropic" },
    ]);

    expect(merged.map((m) => [m.id, m.isDefault ?? false, m.efforts])).toEqual([
      ["gpt-6.1-sol", true, ["low"]],
      ["grok-4.7", false, []],
    ]);
    expect(merged[1]?.displayName).toBe("Grok 4.7");
  });

  test("Codex through a proxy: the proxy's non-agent models are left out, chat models without efforts stay", () => {
    const merged = codexProxyModels(
      [{ id: "gpt-6.1-sol", isDefault: true, efforts: ["low"] }],
      [
        { id: "gpt-6.1-sol", ownedBy: "openai" },
        { id: "gpt-image-2", ownedBy: "openai" },
        { id: "grok-tts", ownedBy: "xai" },
        { id: "gemini-3.1-flash-image", ownedBy: "antigravity", outputModalities: ["text", "image"] },
        { id: "grok-imagine-video-1.5-lite", ownedBy: "xai", outputModalities: ["video"] },
        { id: "gemini-3-flash", ownedBy: "antigravity", outputModalities: ["text"] },
        { id: "grok-composer-2.5-fast", ownedBy: "xai" },
      ],
    );

    expect(merged.map((m) => [m.id, m.efforts])).toEqual([
      ["gpt-6.1-sol", ["low"]],
      ["grok-composer-2.5-fast", []],
    ]);
  });

  test("the proxy's /v1/models with the profile key; failures never show its address or key", async () => {
    const seen: { url: string; auth: string | null }[] = [];

    const ok = async (url: URL, init: RequestInit) => {
      seen.push({ url: url.href, auth: new Headers(init.headers).get("authorization") });

      if (url.pathname === "/v1beta/models") {
        return Response.json({
          models: [
            {
              name: "models/gpt-6.1-sol",
              displayName: "GPT 6.1 Sol",
              supportedGenerationMethods: ["generateContent"],
              supportedInputModalities: ["text", "image"],
              supportedOutputModalities: ["text"],
            },
            { name: "models/grok-tts", displayName: "Grok TTS", supportedGenerationMethods: ["generateContent"] },
          ],
        });
      }

      return Response.json({
        data: [{ id: "gpt-6.1-sol", owned_by: "openai" }, { id: "grok-tts", owned_by: "xai" }, { id: 42 }],
      });
    };

    expect(await proxyModels(proxy, ok)).toEqual([
      {
        id: "gpt-6.1-sol",
        ownedBy: "openai",
        displayName: "GPT 6.1 Sol",
        outputModalities: ["text"],
        generationMethods: ["generateContent"],
      },
      { id: "grok-tts", ownedBy: "xai", displayName: "Grok TTS", generationMethods: ["generateContent"] },
    ]);
    expect(seen.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: "http://proxy.internal:8317/v1/models", auth: "Bearer sk-test" },
      { url: "http://proxy.internal:8317/v1beta/models", auth: "Bearer sk-test" },
    ]);

    // /v1beta/models is optional: without it the models come without capabilities.
    const noGemini = async (url: URL) =>
      url.pathname === "/v1beta/models"
        ? new Response("no", { status: 404 })
        : Response.json({ data: [{ id: "grok-4.7", owned_by: "xai" }] });

    expect(await proxyModels(proxy, noGemini)).toEqual([{ id: "grok-4.7", ownedBy: "xai" }]);
    expect(await proxyCapabilities(proxy, noGemini).catch((e: Error) => e.message)).toBe(
      "the proxy answered 404 to GET /v1beta/models",
    );

    const down = async () => {
      throw new Error("connect ECONNREFUSED proxy.internal:8317 (key sk-test)");
    };

    const message = await proxyModels(proxy, down).then(
      () => "",
      (e: Error) => e.message,
    );

    expect(message).toBe("the proxy did not answer GET /v1/models: connect ECONNREFUSED <proxy> (key <key>)");
    const denied = async () => new Response("no", { status: 401 });
    expect(await proxyModels(proxy, denied).catch((e: Error) => e.message)).toBe(
      "the proxy answered 401 to GET /v1/models",
    );
  });
});
