import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ModelInfoSchema, Provider, ProviderProfileKind, ui } from "@open-agents/contracts";
import { draftOf, draftProblems, envRow, hasProblems, initialShown, newSince, saveRequest, toggleRequest } from "./profiles.ts";

const stored = create(ui.ProviderProfileSettingsSchema, {
  workerId: "w",
  id: "team",
  displayName: "Team",
  kind: ProviderProfileKind.CLIPROXYAPI,
  providers: [Provider.CODEX],
  baseUrl: "http://127.0.0.1:8317",
  apiKeySet: true,
  env: [
    { name: "PROBE", value: "1" },
    { name: "TOKEN", secret: true },
  ],
  enabled: true,
});

describe("profile form", () => {
  test("an untouched edit keeps the key and secrets: no values are sent for them", () => {
    const request = saveRequest("w", draftOf(stored), 7n);
    expect(request.apiKey).toBeUndefined();
    expect(request.env.map((v) => [v.name, v.secret, v.value])).toEqual([
      ["PROBE", false, "1"],
      ["TOKEN", true, undefined],
    ]);
    expect(request).toMatchObject({ profileId: "team", providers: [Provider.CODEX], expectedConfigVersion: 7n });
  });

  test("replace sends the new key, clear sends an empty one", () => {
    expect(saveRequest("w", { ...draftOf(stored), keyAction: "replace", apiKey: "new" }, 0n).apiKey).toBe("new");
    expect(saveRequest("w", { ...draftOf(stored), keyAction: "clear" }, 0n).apiKey).toBe("");
  });

  test("a device-login profile sends neither URL nor key", () => {
    const request = saveRequest("w", { ...draftOf(stored), kind: ProviderProfileKind.NATIVE, keyAction: "replace", apiKey: "x" }, 0n);
    expect(request.baseUrl).toBe("");
    expect(request.apiKey).toBeUndefined();
  });

  test("problems: name, agents, URL, reserved and duplicate variables, missing secret, renamed kept secret", () => {
    const draft = { ...draftOf(undefined), claude: false, codex: false, baseUrl: "ftp://x" };
    draft.env = [envRow({ name: "HOME", value: "/x" }), envRow({ name: "A", value: "1" }), envRow({ name: "a" }), envRow({ name: "S", secret: true })];
    const problems = draftProblems(draft);
    expect(problems.displayName).toBeDefined();
    expect(problems.providers).toBeDefined();
    expect(problems.baseUrl).toContain("http(s)");
    expect(Object.values(problems.env)).toEqual(["HOME is controlled by the worker.", "a is listed twice.", "Enter the secret value."]);

    const renamed = draftOf(stored);
    renamed.env[1]!.name = "TOKEN2";
    expect(Object.values(draftProblems(renamed).env)).toEqual(["Enter the value again to rename a secret."]);
    expect(hasProblems(draftProblems(draftOf(stored)))).toBe(false);
  });

  test("turning off keeps everything else", () => {
    const request = toggleRequest("w", stored, 3n);
    expect(request.enabled).toBe(false);
    expect(request.apiKey).toBeUndefined();
    expect(request.env.find((v) => v.name === "TOKEN")?.value).toBeUndefined();
  });
});

describe("model selection", () => {
  const models = [{ id: "a" }, { id: "b", hidden: true }, { id: "c" }].map((m) => create(ModelInfoSchema, m));
  test("without a selection the provider's visible models are checked; with one, its choice and new models by show_new", () => {
    expect([...initialShown(models, undefined)]).toEqual(["a", "c"]);
    const selection = create(ui.ModelSelectionSchema, { shown: ["b"], known: ["a", "b"], showNew: true });
    expect([...initialShown(models, selection)]).toEqual(["b", "c"]);
    expect([...newSince(models, selection)]).toEqual(["c"]);
    expect([...initialShown(models, { ...selection, showNew: false })]).toEqual(["b"]);
  });
});
