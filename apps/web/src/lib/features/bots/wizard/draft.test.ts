import { describe, expect, test } from "bun:test";
import { appearanceError, nameError, selectionError, type BotProviderInstance } from "./draft.ts";
import type { ModelOption } from "#lib/features/models/catalog.ts";
import { hexToHsv, hsvToHex } from "./color.ts";

describe("bot draft validation", () => {
  test("requires a name and compares trimmed, case-insensitive Unicode names", () => {
    expect(nameError(" \t\n", [])).toBeDefined();
    expect(nameError("  CANOPY bot  ", ["Canopy Bot"])).toContain("already exists");
    expect(nameError("Cafe\u0301", ["Café"])).toContain("already exists");
    expect(nameError("Orbit", ["Canopy Bot"])).toBeUndefined();
  });

  test("edit can keep its original name, but cannot claim another bot's name", () => {
    expect(nameError("orbit", ["Orbit", "Canopy Bot"], "Orbit")).toBeUndefined();
    expect(nameError("Canopy Bot", ["Orbit", "Canopy Bot"], "Orbit")).toBeDefined();
    expect(nameError("Orbit", ["Orbit", "ORBIT"], "Orbit")).toBeDefined();
  });

  test("incomplete custom hex cannot be submitted", () => {
    expect(appearanceError({ name: "Orbit", shape: "round", color: "#1" }, [])).toContain("colour");
    expect(appearanceError({ name: "Orbit", shape: "round", color: "#abc" }, [])).toBeUndefined();
  });

  const model: ModelOption = {
    key: "CODEX:personal:gpt", provider: "CODEX", profileId: "personal", profileName: "Personal", accent: "", favoriteIndex: undefined,
    model: "gpt", name: "GPT", description: "", resolvedModel: "", isDefault: true, efforts: [{ id: "high", label: "High" }], defaultEffort: "high", origin: "catalog", listDetail: "",
  };
  const instances: BotProviderInstance[] = [{ id: "personal", name: "Personal", provider: "CODEX", models: [model] }];
  test("availability and supported effort are checked again at submit time", () => {
    expect(selectionError(instances, "personal", model, "high")).toBeUndefined();
    expect(selectionError(instances, "personal", model, undefined)).toBeUndefined();
    expect(selectionError([], "personal", model, "high")).toBeDefined();
    expect(selectionError(instances, "removed", model, "high")).toBeDefined();
    expect(selectionError(instances, "personal", undefined, undefined)).toBeDefined();
    expect(selectionError(instances, "personal", { ...model, key: "stale" }, undefined)).toBeDefined();
    expect(selectionError(instances, "personal", model, "ultra")).toContain("effort");
  });
});

describe("custom colour conversion", () => {
  test("hex and HSV round-trip all hue sectors, black, white and greys", () => {
    for (const color of ["#ff0000", "#ffff00", "#00ff00", "#00ffff", "#0000ff", "#ff00ff", "#000000", "#ffffff", "#a1a1aa", "#a3e635"]) {
      const hsv = hexToHsv(color);
      expect(hsvToHex(hsv.hue, hsv.saturation, hsv.value)).toBe(color);
    }
    expect(hsvToHex(360, 100, 100)).toBe("#ff0000");
  });
});
