import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ModelInfoSchema, ProfileModelsSchema, Provider, ProviderProfileSchema, ProviderInfoSchema, ui } from "@open-agents/contracts";
import { effectiveEffort, findOption, modelOptions, shortModelName, threadModelOptions, turnOverride } from "../src/lib/features/models/catalog.ts";

const worker = create(ui.WorkerSchema, {
  id: "w1",
  online: true,
  providers: [create(ProviderInfoSchema, { provider: Provider.CLAUDE, available: true }), create(ProviderInfoSchema, { provider: Provider.CODEX, available: true })],
  profiles: [
    create(ProviderProfileSchema, { id: "native", available: true, providers: [Provider.CLAUDE, Provider.CODEX] }),
    create(ProviderProfileSchema, { id: "proxy", available: true, providers: [Provider.CODEX] }),
  ],
});

const catalog = create(ui.WorkerModelsSchema, {
  workerId: "w1",
  profiles: [
    create(ProfileModelsSchema, {
      provider: Provider.CODEX,
      profileId: "native",
      models: [
        create(ModelInfoSchema, { id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, efforts: ["low", "medium", "high"], defaultEffort: "low" }),
        create(ModelInfoSchema, { id: "secret", displayName: "Secret", hidden: true, efforts: ["low"] }),
      ],
    }),
    create(ProfileModelsSchema, {
      provider: Provider.CODEX,
      profileId: "proxy",
      detail: "the proxy did not answer",
      models: [create(ModelInfoSchema, { id: "grok-4.7", displayName: "grok-4.7" })],
    }),
    create(ProfileModelsSchema, {
      provider: Provider.CLAUDE,
      profileId: "native",
      models: [
        create(ModelInfoSchema, { id: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", isDefault: true, efforts: ["low", "high"] }),
        create(ModelInfoSchema, { id: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", efforts: ["low", "high"] }),
      ],
    }),
  ],
});

describe("modelOptions", () => {
  test("lists the catalog's visible models per provider and profile", () => {
    const options = modelOptions({ worker, catalog, threads: [] });
    expect(options.map((o) => o.key)).toEqual(["CLAUDE::default", "CLAUDE::opus", "CODEX::gpt-6.1-sol", "CODEX:proxy:grok-4.7"]);
    const grok = options.find((o) => o.model === "grok-4.7")!;
    expect(grok.efforts).toEqual([]);
    expect(grok.defaultEffort).toBeUndefined();
    expect(grok.listDetail).toBe("the proxy did not answer");
    expect(grok.name).toBe("grok-4.7");
    expect(options.find((o) => o.model === "gpt-6.1-sol")?.defaultEffort).toBe("low");
    expect(options.find((o) => o.model === "default")?.defaultEffort).toBeUndefined();
  });

  test("falls back to known models with stand-in efforts only without a catalog", () => {
    const options = modelOptions({ worker, catalog: undefined, threads: [] });
    const claude = options.filter((o) => o.provider === "CLAUDE");
    expect(claude.map((o) => o.model)).toEqual(["", "opus", "sonnet", "haiku"]);
    expect(claude[0]?.isDefault).toBe(true);
    expect(claude[0]?.efforts.length).toBeGreaterThan(0);
  });
});

describe("findOption", () => {
  const options = modelOptions({ worker, catalog, threads: [] });
  test("empty model = the profile's default; an alias's resolved model matches", () => {
    expect(findOption(options, "CODEX", "", "")?.model).toBe("gpt-6.1-sol");
    expect(findOption(options, "CLAUDE", "", "claude-opus-5-5")?.model).toBe("default");
    expect(findOption(options, "CODEX", "", "nope")).toBeUndefined();
  });
});

describe("threadModelOptions", () => {
  test("keeps the thread's provider and profile; an unlisted model stays the current one", () => {
    const thread = create(ui.ThreadSchema, { id: "t1", workerId: "w1", provider: Provider.CODEX, providerProfileId: "native", model: "secret" });
    const { options, current } = threadModelOptions(thread, { worker, catalog, threads: [] });
    expect(options.map((o) => o.key)).toEqual(["CODEX::gpt-6.1-sol"]);
    expect(current?.key).toBe("CODEX::secret");
    expect(current?.efforts.map((e) => e.id)).toEqual(["low"]);
  });
});

describe("effectiveEffort", () => {
  const [option] = modelOptions({ worker, catalog, threads: [], only: { provider: "CODEX", profileId: "" } });
  test("the thread's effort when the model takes it, else the model's default", () => {
    expect(effectiveEffort(option!, "high")).toBe("high");
    expect(effectiveEffort(option!, "max")).toBe("low");
    expect(effectiveEffort(option!, undefined)).toBe("low");
  });
});

describe("turnOverride", () => {
  const options = modelOptions({ worker, catalog, threads: [], only: { provider: "CODEX", profileId: "" } });
  const thread = create(ui.ThreadSchema, { provider: Provider.CODEX, providerProfileId: "", model: "" });
  const { current } = threadModelOptions(thread, { worker, catalog, threads: [] });
  test("nothing for the thread's own model without a chosen effort", () => {
    expect(turnOverride(current, current, undefined, "")).toEqual({});
  });
  test("a chosen effort; the model's default when it does not take the thread's effort", () => {
    expect(turnOverride(current, current, "high", "")).toEqual({ effort: "high" });
    expect(turnOverride(options[0], current, undefined, "max")).toEqual({ effort: "low" });
  });
  test("another model goes as the override", () => {
    const custom = threadModelOptions(create(ui.ThreadSchema, { workerId: "w1", provider: Provider.CODEX, model: "secret" }), { worker, catalog, threads: [] }).current;
    expect(turnOverride(custom, current, undefined, "")).toEqual({ model: "secret" });
  });
});

describe("shortModelName", () => {
  test("drops the family prefix, keeps other names", () => {
    expect(shortModelName("GPT-6.1-Sol")).toBe("6.1 Sol");
    expect(shortModelName("GPT-5.5 Codex")).toBe("5.5 Codex");
    expect(shortModelName("Claude Opus 5.5")).toBe("Opus 5.5");
    expect(shortModelName("Default (recommended)")).toBe("Default (recommended)");
    expect(shortModelName("gpt-oss")).toBe("gpt-oss");
    expect(shortModelName("Opus")).toBe("Opus");
  });
});
