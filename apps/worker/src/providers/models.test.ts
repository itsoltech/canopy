import { describe, expect, test } from "bun:test";
import type { v2 } from "@open-agents/codex-protocol";
import { claudeModel, codexModel, codexProxyModels, proxyModels } from "./models.ts";

const proxy = { kind: "cliproxyapi" as const, id: "cliproxy", baseUrl: new URL("http://proxy.internal:8317"), apiKey: "sk-test", providers: ["claude" as const, "codex" as const] };

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

  test("the proxy's /v1/models with the profile key; failures never show its address or key", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const ok = (async (url: URL, init: RequestInit) => {
      seen.push({ url: url.href, auth: new Headers(init.headers).get("authorization") });
      return Response.json({ data: [{ id: "gpt-6.1-sol", owned_by: "openai" }, { id: 42 }] });
    }) as unknown as typeof fetch;
    expect(await proxyModels(proxy, ok)).toEqual([{ id: "gpt-6.1-sol", ownedBy: "openai" }]);
    expect(seen).toEqual([{ url: "http://proxy.internal:8317/v1/models", auth: "Bearer sk-test" }]);

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
