import { describe, expect, test } from "bun:test";
import type { v2 } from "@open-agents/codex-protocol";
import { claudeAgentModels, claudeModel, codexModel, codexProxyModels, isAgentModel, proxyCapabilities, proxyModels } from "./models.ts";

const proxy = { kind: "cliproxyapi" as const, id: "cliproxy", baseUrl: new URL("http://proxy.internal:8317"), apiKey: "sk-test", providers: ["claude" as const, "codex" as const], env: {}, runtime: {} };

describe("model catalogs", () => {
  test("Codex model/list entries keep their efforts and default", () => {
    const model = {
      id: "gpt-6.1-sol",
      model: "gpt-6.1-sol",
      displayName: "GPT-6.1-Sol",
      description: "",
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "xhigh", description: "" }],
      defaultReasoningEffort: "low",
    } as unknown as v2.Model;
    expect(codexModel(model)).toEqual({ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "", hidden: false, isDefault: true, efforts: ["low", "xhigh"], defaultEffort: "low" });
    // The device owner's configured default wins when the model offers it, else the model's own stays.
    expect(codexModel(model, "xhigh").defaultEffort).toBe("xhigh");
    expect(codexModel(model, "minimal").defaultEffort).toBe("low");
  });

  test("Claude supportedModels: aliases resolve, the default row is the default, no effort support = no efforts", () => {
    expect(claudeModel({ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "", supportsEffort: true, supportedEffortLevels: ["low", "max"] })).toEqual({
      id: "haiku",
      resolvedModel: "claude-haiku-5-5",
      displayName: "Haiku",
      description: "",
      isDefault: false,
      efforts: ["low", "max"],
    });
    expect(claudeModel({ value: "default", resolvedModel: "default", displayName: "Default", description: "" })).toMatchObject({ isDefault: true, efforts: [] });
    expect(claudeModel({ value: "claude-3-7-sonnet", displayName: "3.7", description: "", supportsEffort: false })).toMatchObject({ efforts: [] });
    // Claude Code reports no default: only a configured one the model offers.
    const opus = { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "", supportedEffortLevels: ["low", "high", "xhigh"] as ("low" | "high" | "xhigh")[] };
    expect(claudeModel(opus, "xhigh").defaultEffort).toBe("xhigh");
    expect(claudeModel(opus, "max").defaultEffort).toBeUndefined();
    expect(claudeModel(opus).defaultEffort).toBeUndefined();
    expect(claudeModel({ value: "claude-3-7-sonnet", displayName: "3.7", description: "", supportsEffort: false }, "high").defaultEffort).toBeUndefined();
  });

  test("agent models: reported output modalities first, name words only without them; no efforts is fine", () => {
    // Metadata decides.
    expect(isAgentModel(["gemini-3-flash"], { outputModalities: ["text"], generationMethods: ["generateContent"] })).toBe(true);
    expect(isAgentModel(["gemini-3.1-flash-image"], { outputModalities: ["text", "image"] })).toBe(false);
    expect(isAgentModel(["grok-imagine-video-1.5-lite"], { outputModalities: ["video"] })).toBe(false);
    expect(isAgentModel(["text-embedding-4"], { generationMethods: ["embedContent"] })).toBe(false);
    // Text-only output beats a name word.
    expect(isAgentModel(["voice-agent-chat"], { outputModalities: ["text"] })).toBe(true);
    // No metadata: name words (id or display name).
    for (const id of ["gpt-image-2.5", "grok-imagine-image", "grok-tts", "grok-voice-tts-1.0", "gpt-realtime-2", "gpt-4o-mini-transcribe", "omni-moderation-latest", "text-embedding-3-large", "dall-e-3", "sora-2", "whisper-1"]) {
      expect([id, isAgentModel([id])]).toEqual([id, false]);
    }
    expect(isAgentModel(["claude-fable-5-dd-2-egami-tpg", "GPT Image 2"])).toBe(false);
    for (const id of ["grok-4.7", "grok-4.20-0309-non-reasoning", "grok-composer-2.5-fast", "gemini-3.5-flash-lite", "claude-3-5-haiku-20241022", "gpt-oss-120b-medium", "codex-auto-review"]) {
      expect([id, isAgentModel([id])]).toEqual([id, true]);
    }
  });

  test("Claude through a proxy: models that cannot run a turn are left out, matched by id, alias or display name", () => {
    const row = (value: string, displayName: string, resolvedModel?: string) => ({ value, displayName, description: "", ...(resolvedModel && { resolvedModel }) });
    const listed = [
      row("default", "Default (recommended)", "claude-opus-5-5"),
      row("claude-fable-5-dd-7.4-korg", "Grok 4.7"),
      row("claude-fable-5-dd-egami-hsalf-1.3-inimeg", "Gemini 3.1 Flash Image"),
      row("claude-fable-5-dd-stt-korg", "Grok TTS"),
      row("claude-fable-5-dd-tsaf-5.2-resopmoc-korg", "Composer 2.5 Fast"),
    ];
    const capabilities = [
      { id: "grok-4.7", displayName: "Grok 4.7", outputModalities: ["text"] },
      { id: "gemini-3.1-flash-image", displayName: "Gemini 3.1 Flash Image", outputModalities: ["text", "image"] },
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5", outputModalities: ["text"] },
    ];
    expect(claudeAgentModels(listed, capabilities).map((m) => m.value)).toEqual(["default", "claude-fable-5-dd-7.4-korg", "claude-fable-5-dd-tsaf-5.2-resopmoc-korg"]);
    // Without the proxy's capabilities the display names' words still catch the image and speech rows.
    expect(claudeAgentModels(listed).map((m) => m.value)).toEqual(["default", "claude-fable-5-dd-7.4-korg", "claude-fable-5-dd-tsaf-5.2-resopmoc-korg"]);
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
      ["claude-opus-5", false, []],
      ["grok-4.7", false, []],
    ]);
    expect(merged[2]?.description).toBe("CLIProxyAPI (xai)");
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
      ["gemini-3-flash", []],
      ["grok-composer-2.5-fast", []],
    ]);
  });

  test("the proxy's /v1/models with the profile key; failures never show its address or key", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const ok = (async (url: URL, init: RequestInit) => {
      seen.push({ url: url.href, auth: new Headers(init.headers).get("authorization") });
      if (url.pathname === "/v1beta/models") {
        return Response.json({
          models: [
            { name: "models/gpt-6.1-sol", displayName: "GPT 6.1 Sol", supportedGenerationMethods: ["generateContent"], supportedInputModalities: ["text", "image"], supportedOutputModalities: ["text"] },
            { name: "models/grok-tts", displayName: "Grok TTS", supportedGenerationMethods: ["generateContent"] },
          ],
        });
      }
      return Response.json({ data: [{ id: "gpt-6.1-sol", owned_by: "openai" }, { id: "grok-tts", owned_by: "xai" }, { id: 42 }] });
    }) as unknown as typeof fetch;
    expect(await proxyModels(proxy, ok)).toEqual([
      { id: "gpt-6.1-sol", ownedBy: "openai", displayName: "GPT 6.1 Sol", outputModalities: ["text"], generationMethods: ["generateContent"] },
      { id: "grok-tts", ownedBy: "xai", displayName: "Grok TTS", generationMethods: ["generateContent"] },
    ]);
    expect(seen.sort((a, b) => a.url.localeCompare(b.url))).toEqual([
      { url: "http://proxy.internal:8317/v1/models", auth: "Bearer sk-test" },
      { url: "http://proxy.internal:8317/v1beta/models", auth: "Bearer sk-test" },
    ]);
    // /v1beta/models is optional: without it the models come without capabilities.
    const noGemini = (async (url: URL) => (url.pathname === "/v1beta/models" ? new Response("no", { status: 404 }) : Response.json({ data: [{ id: "grok-4.7", owned_by: "xai" }] }))) as unknown as typeof fetch;
    expect(await proxyModels(proxy, noGemini)).toEqual([{ id: "grok-4.7", ownedBy: "xai" }]);
    expect(await proxyCapabilities(proxy, noGemini).catch((e: Error) => e.message)).toBe("the proxy answered 404 to GET /v1beta/models");

    const down = (async () => {
      throw new Error("connect ECONNREFUSED proxy.internal:8317 (key sk-test)");
    }) as unknown as typeof fetch;
    const message = await proxyModels(proxy, down).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(message).toBe("the proxy did not answer GET /v1/models: connect ECONNREFUSED <proxy> (key <key>)");
    const denied = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await proxyModels(proxy, denied).catch((e: Error) => e.message)).toBe("the proxy answered 401 to GET /v1/models");
  });
});
