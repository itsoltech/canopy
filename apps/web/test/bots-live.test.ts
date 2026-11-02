import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, ui } from "@open-agents/contracts";
import { botWizardInstances } from "../src/lib/features/bots/live.ts";

test("bot wizard uses endpoint instances without worker availability and distinguishes harness ids", () => {
  const options = botWizardInstances([
    create(ui.ProviderInstanceSchema, { harness: Provider.CLAUDE, id: "proxy", kind: ProviderProfileKind.CLIPROXYAPI, models: { custom: ["claude-custom"] } }),
    create(ui.ProviderInstanceSchema, { harness: Provider.CODEX, id: "proxy", kind: ProviderProfileKind.CLIPROXYAPI, models: { custom: ["codex-custom", "hidden"], hidden: ["hidden"] } }),
    create(ui.ProviderInstanceSchema, { harness: Provider.CODEX, id: "native", kind: ProviderProfileKind.NATIVE }),
  ], []);
  expect(options.map((i) => i.id)).toEqual(["CLAUDE:proxy", "CODEX:proxy"]);
  expect(options.map((i) => i.models.map((m) => m.model))).toEqual([["claude-custom"], ["codex-custom"]]);
  expect(options[1]?.models[0]?.efforts).toEqual([]);
});

test("bot wizard merges model catalogs without duplicates and retains the selected model's efforts", () => {
  const catalog = create(ui.WorkerModelsSchema, { workerId: "w1", profiles: [{
    provider: Provider.CODEX, profileId: "proxy", models: [
      { id: "gpt", efforts: ["low", "high"], defaultEffort: "high", isDefault: true },
      { id: "hidden", hidden: true },
    ],
  }] });
  const result = botWizardInstances([create(ui.ProviderInstanceSchema, {
    harness: Provider.CODEX, id: "proxy", kind: ProviderProfileKind.CLIPROXYAPI, models: { custom: ["custom"], favorites: ["custom"] },
  })], [catalog, create(ui.WorkerModelsSchema, { ...catalog, workerId: "w2" })]);
  expect(result[0]?.models.map((m) => m.model)).toEqual(["custom", "gpt"]);
  expect(result[0]?.models.find((m) => m.model === "gpt")).toMatchObject({ defaultEffort: "high", efforts: [{ id: "low" }, { id: "high" }] });
});
