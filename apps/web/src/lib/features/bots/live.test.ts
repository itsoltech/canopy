import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, ui } from "@open-agents/contracts";
import { botWizardInstances } from "./live.ts";

test("the wizard offers Claude aliases as the API models they resolve to, and drops unresolved ones", () => {
  const instance = create(ui.ProviderInstanceSchema, { id: "proxy", label: "Proxy", harness: Provider.CLAUDE, kind: ProviderProfileKind.CLIPROXYAPI });
  const catalog = create(ui.WorkerModelsSchema, { workerId: "w", profiles: [{ provider: Provider.CLAUDE, profileId: "proxy", models: [
    { id: "default", resolvedModel: "claude-opus-5-5", isDefault: true }, { id: "opus", resolvedModel: "claude-opus-5-5" }, { id: "sonnet" }, { id: "claude-sonnet-5-5" },
  ] }] });
  const [proxy] = botWizardInstances([instance], [catalog]);
  expect(proxy?.models.map((m) => m.model)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
});
