import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ProfileModelsSchema, Provider } from "@canopy/contracts";
import { modelProblem, turnEffort } from "./models.ts";

const catalog = create(ProfileModelsSchema, {
  provider: Provider.CLAUDE,
  profileId: "native",
  models: [
    { id: "opus", aliases: ["default"], isDefault: true, displayName: "Default", efforts: ["low", "medium", "high"] },
    { id: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", efforts: ["low", "max"] },
    { id: "claude-3-7-sonnet", displayName: "Claude 3.7 Sonnet", efforts: [] },
    { id: "sonnet", displayName: "Sonnet", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  ],
});

describe("model and effort against a catalog", () => {
  test("offered models (also by the model an alias resolves to) and their efforts", () => {
    expect(modelProblem(catalog, Provider.CLAUDE, "native", "haiku", "max")).toBeUndefined();
    expect(modelProblem(catalog, Provider.CLAUDE, "native", "default", "high")).toBeUndefined();
    expect(turnEffort(catalog, "default", "max")).toBe("");
    expect(modelProblem(catalog, Provider.CLAUDE, "native", "claude-haiku-5-5", "low")).toBeUndefined();
    expect(modelProblem(catalog, Provider.CLAUDE, "native", "opus-9", "")).toBe(
      'Claude on profile "native" does not offer the model "opus-9"',
    );
    expect(modelProblem(catalog, Provider.CLAUDE, "native", "haiku", "high")).toBe(
      'Haiku supports the reasoning efforts low, max, not "high"',
    );
    // No model: the profile's default judges the effort; a model without effort data does not.
    expect(modelProblem(catalog, Provider.CLAUDE, "native", "", "max")).toBe(
      'Default supports the reasoning efforts low, medium, high, not "max"',
    );
    expect(modelProblem(catalog, Provider.CLAUDE, "native", "claude-3-7-sonnet", "max")).toBeUndefined();
  });

  test("without a complete catalog only the shape is checked", () => {
    expect(modelProblem(undefined, Provider.CODEX, "native", "anything", "ultra")).toBeUndefined();
    expect(
      modelProblem(
        create(ProfileModelsSchema, { ...catalog, detail: "the proxy did not answer" }),
        Provider.CLAUDE,
        "native",
        "opus-9",
        "",
      ),
    ).toBeUndefined();
    expect(modelProblem(undefined, Provider.CODEX, "native", "", "Very High!")).toBe(
      'invalid reasoning effort "Very High!"',
    );
    expect(modelProblem(undefined, Provider.CODEX, "native", "x".repeat(201), "")).toBe("model or effort is too long");
  });
});

describe("the effort a turn is started with", () => {
  test("a model without efforts gets none, also when the thread has a default", () => {
    expect(turnEffort(catalog, "claude-3-7-sonnet", "high")).toBe("");
  });

  test("an effort the model does not offer falls back to its default effort, else to none", () => {
    expect(turnEffort(catalog, "sonnet", "max")).toBe("medium");
    expect(turnEffort(catalog, "haiku", "high")).toBe(""); // no default effort
    expect(turnEffort(catalog, "", "max")).toBe(""); // the profile's default model judges
    expect(turnEffort(catalog, "claude-haiku-5-5", "max")).toBe("max"); // offered, found by the resolved model
  });

  test("unknown models and missing catalogs keep the effort as chosen", () => {
    expect(turnEffort(catalog, "my-proxy-model", "high")).toBe("high");
    expect(turnEffort(undefined, "claude-3-7-sonnet", "high")).toBe("high");
    expect(
      turnEffort(
        create(ProfileModelsSchema, { ...catalog, detail: "the proxy did not answer" }),
        "claude-3-7-sonnet",
        "high",
      ),
    ).toBe("");
    expect(turnEffort(catalog, "claude-3-7-sonnet", "")).toBe("");
  });
});
