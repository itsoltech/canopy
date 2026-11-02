import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@open-agents/contracts";
import { applyModelSelections } from "./models.ts";

const catalog = create(ui.WorkerModelsSchema, {
  workerId: "w",
  profiles: [
    { provider: Provider.CODEX, profileId: "team", models: [{ id: "a" }, { id: "b" }, { id: "c", hidden: true }, { id: "new-one" }] },
    { provider: Provider.CLAUDE, profileId: "team", models: [{ id: "opus" }, { id: "sonnet" }] },
    { provider: Provider.CODEX, profileId: "native", models: [{ id: "a" }] },
  ],
});
const visible = (models: ui.WorkerModels, provider: Provider, profile: string) =>
  models.profiles.find((p) => p.provider === provider && p.profileId === profile)!.models.filter((m) => !m.hidden).map((m) => m.id);

describe("applyModelSelections", () => {
  test("no selection: the catalog as the worker sent it", () => {
    expect(applyModelSelections(catalog, [])).toBe(catalog);
    expect(visible(catalog, Provider.CODEX, "team")).toEqual(["a", "b", "new-one"]);
  });

  test("shows the selected models (also one the provider hides), hides the rest, keeps every entry", () => {
    const rule = { profile_id: "team", provider: "codex" as const, shown: ["b", "c"], known: ["a", "b", "c"], show_new: false };
    const filtered = applyModelSelections(catalog, [rule]);
    expect(visible(filtered, Provider.CODEX, "team")).toEqual(["b", "c"]);
    expect(filtered.profiles[0]!.models).toHaveLength(4);
    // Other providers and profiles are untouched.
    expect(visible(filtered, Provider.CLAUDE, "team")).toEqual(["opus", "sonnet"]);
    expect(visible(filtered, Provider.CODEX, "native")).toEqual(["a"]);
  });

  test("models new since the selection follow show_new", () => {
    const rule = { profile_id: "team", provider: "codex" as const, shown: ["a"], known: ["a", "b", "c"], show_new: true };
    expect(visible(applyModelSelections(catalog, [rule]), Provider.CODEX, "team")).toEqual(["a", "new-one"]);
  });
});
