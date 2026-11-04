import { describe, expect, test } from "bun:test";
import { agentCatalog, resolveSpawnTarget, type SpawnInstance, type SpawnTarget } from "./agents.ts";

const codexModels = [
  {
    id: "gpt-6.1-sol",
    label: "GPT-6.1-Sol",
    efforts: ["low", "medium", "high"],
    defaultEffort: "low",
    isDefault: true,
    hidden: false,
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    efforts: ["low", "medium"],
    defaultEffort: "medium",
    isDefault: false,
    hidden: false,
  },
  { id: "gpt-old", label: "GPT old", efforts: [], defaultEffort: "", isDefault: false, hidden: true },
];

const claudeModels = [
  {
    id: "opus",
    resolvedModel: "claude-opus-5-5",
    label: "Opus",
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "",
    isDefault: true,
    hidden: false,
  },
  { id: "haiku", label: "Haiku", efforts: [], defaultEffort: "", isDefault: false, hidden: false },
];

const instances: SpawnInstance[] = [
  { harness: "codex", id: "native", label: "", available: true, models: codexModels, complete: true },
  { harness: "codex", id: "cliproxyapi", label: "CLIProxyAPI", available: true, models: codexModels, complete: true },
  { harness: "claude", id: "native", label: "", available: true, models: claudeModels, complete: true },
  {
    harness: "claude",
    id: "cliproxyapi",
    label: "CLIProxyAPI",
    available: false,
    detail: "not logged in",
    models: [],
    complete: true,
  },
];

const codexCaller: SpawnTarget = { harness: "codex", instance: "native", model: "gpt-5.5", effort: "medium" };
const claudeCaller: SpawnTarget = { harness: "claude", instance: "native", model: "opus", effort: "high" };

const target = (
  args: Parameters<typeof resolveSpawnTarget>[0],
  caller = codexCaller,
  list: SpawnInstance[] | "unreported" = instances,
) => {
  const result = resolveSpawnTarget(args, caller, list === "unreported" ? undefined : list);

  return result.ok ? result.target : result.reason;
};

describe("spawn_thread on any provider", () => {
  test("without provider the subagent is a copy of the caller (its model and effort unless narrowed)", () => {
    expect(target({})).toEqual(codexCaller);
    expect(target({ model: "gpt-6.1-sol" })).toEqual({ ...codexCaller, model: "gpt-6.1-sol" });
    expect(target({ provider: "codex/native", effort: "low" })).toEqual({ ...codexCaller, effort: "low" });
    expect(target({ provider: "codex" })).toEqual(codexCaller);
  });

  test("Codex -> Claude and Claude -> Codex: the other harness with its default model and effort", () => {
    expect(target({ provider: "claude/native" })).toEqual({
      harness: "claude",
      instance: "native",
      model: "opus",
      effort: "",
    });
    expect(target({ provider: "claude", model: "opus", effort: "max" })).toEqual({
      harness: "claude",
      instance: "native",
      model: "opus",
      effort: "max",
    });
    expect(target({ provider: "codex" }, claudeCaller)).toEqual({
      harness: "codex",
      instance: "native",
      model: "gpt-6.1-sol",
      effort: "low",
    });
    expect(target({ provider: "codex:cliproxyapi", model: "gpt-5.5" }, claudeCaller)).toEqual({
      harness: "codex",
      instance: "cliproxyapi",
      model: "gpt-5.5",
      effort: "medium",
    });
  });

  test("Claude -> Claude and Codex -> Codex on another instance", () => {
    expect(target({ provider: "codex/cliproxyapi" })).toEqual({
      harness: "codex",
      instance: "cliproxyapi",
      model: "gpt-6.1-sol",
      effort: "low",
    });
    expect(target({ provider: "claude/cliproxyapi" }, claudeCaller)).toBe(
      "claude/cliproxyapi is not available on this worker: not logged in",
    );
  });

  test("Grok can be chosen from Claude/Codex, and Grok can delegate back with catalog validation", () => {
    const list: SpawnInstance[] = [
      ...instances,
      {
        harness: "grok",
        id: "proxy",
        label: "Grok proxy",
        available: true,
        complete: true,
        models: [
          {
            id: "grok-4.6",
            label: "Grok 4.6",
            efforts: ["low", "high"],
            defaultEffort: "high",
            isDefault: true,
            hidden: false,
          },
        ],
      },
    ];

    const grok: SpawnTarget = { harness: "grok", instance: "proxy", model: "grok-4.6", effort: "high" };

    for (const caller of [claudeCaller, codexCaller])
      expect(target({ provider: "grok/proxy" }, caller, list)).toEqual(grok);
    expect(target({ provider: "claude/native" }, grok, list)).toMatchObject({ harness: "claude", model: "opus" });
    expect(target({ provider: "codex/native" }, grok, list)).toMatchObject({
      harness: "codex",
      model: "gpt-6.1-sol",
      effort: "low",
    });
    expect(target({ provider: "grok/proxy", effort: "ultra" }, claudeCaller, list)).toContain("ultra");
  });

  test("an alias, a hidden model and a model without efforts are accepted like in the pickers", () => {
    expect(target({ provider: "claude", model: "claude-opus-5-5" })).toMatchObject({ model: "claude-opus-5-5" });
    expect(target({ provider: "codex/cliproxyapi", model: "gpt-old" })).toMatchObject({ model: "gpt-old", effort: "" });
    // A model without efforts takes none, also when the call names one.
    expect(target({ provider: "claude", model: "haiku" })).toMatchObject({ model: "haiku", effort: "" });
  });

  test("the model must be in the instance's catalog and the effort among the model's", () => {
    expect(target({ provider: "claude", model: "gpt-5.5" })).toBe(
      'claude/native does not offer the model "gpt-5.5"; call list_agents for its models',
    );
    expect(target({ provider: "codex/cliproxyapi", model: "gpt-5.5", effort: "high" })).toBe(
      'GPT-5.5 supports the reasoning efforts low, medium, not "high"',
    );
    expect(target({ model: "nope" })).toContain('codex/native does not offer the model "nope"');
    expect(target({ effort: "Hard!" })).toBe('invalid reasoning effort "Hard!"');
  });

  test("unknown or ambiguous providers are refused with a pointer to list_agents", () => {
    expect(target({ provider: "gemini/native" })).toContain('no provider "gemini/native" on this worker');
    expect(target({ provider: "codex/missing" })).toContain("call list_agents");
    expect(target({ provider: "cliproxyapi" })).toBe(
      '"cliproxyapi" is an instance of several providers: say codex/cliproxyapi or claude/cliproxyapi',
    );
    // A bare id that is the caller's own instance means the caller's.
    expect(target({ provider: "native" })).toEqual(codexCaller);
  });

  test("lenient where the worker cannot tell: no catalog, an incomplete one; before the first report only the caller's own", () => {
    const unknownModels = instances.map(({ models: _models, ...i }) => i);
    expect(target({ provider: "claude", model: "anything" }, codexCaller, unknownModels)).toEqual({
      harness: "claude",
      instance: "native",
      model: "anything",
      effort: "",
    });
    const partial = instances.map((i) => ({ ...i, complete: false }));
    expect(target({ provider: "claude", model: "anything", effort: "low" }, codexCaller, partial)).toMatchObject({
      model: "anything",
      effort: "low",
    });
    expect(target({ provider: "claude" }, codexCaller, "unreported")).toContain("has not reported its providers yet");
    expect(target({ model: "x" }, codexCaller, "unreported")).toEqual({ ...codexCaller, model: "x" });
  });
});

describe("list_agents", () => {
  test("available instances with their visible models, the caller's own and how to use them", () => {
    const catalog = agentCatalog(codexCaller, instances);
    expect(catalog.you).toEqual({ provider: "codex/native", model: "gpt-5.5", effort: "medium" });
    expect(catalog.agents.map((a) => a.provider)).toEqual(["codex/native", "codex/cliproxyapi", "claude/native"]);
    expect(catalog.agents[2]).toEqual({
      provider: "claude/native",
      name: "Claude · device login",
      models: [
        { id: "opus", name: "Opus", efforts: ["low", "medium", "high", "max"], default: true },
        { id: "haiku", name: "Haiku" },
      ],
    });
    expect(catalog.agents[0]?.models.map((m) => m.id)).toEqual(["gpt-6.1-sol", "gpt-5.5"]);
    expect(catalog.note).toContain("spawn_thread");
  });

  test("an instance without a reported catalog says so", () => {
    const catalog = agentCatalog(claudeCaller, [
      { harness: "claude", id: "native", label: "", available: true, complete: false },
    ]);

    expect(catalog.agents[0]).toMatchObject({
      models: [],
      note: "no model list reported: omit model to use the default",
    });
    expect(agentCatalog(claudeCaller, undefined).agents).toEqual([]);
  });
});
