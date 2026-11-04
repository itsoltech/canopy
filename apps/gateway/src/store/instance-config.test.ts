import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import {
  applyInstanceModels,
  canonicalJson,
  effectiveProfiles,
  mergeEnv,
  type AssignmentRow,
  type InstanceRow,
} from "./instance-config.ts";

const instance = (over: Partial<InstanceRow>): InstanceRow => ({
  harness: "codex",
  id: "team",
  label: "Team",
  kind: "endpoint",
  base_url: "http://proxy:8317",
  api_key: { secretRef: "k-global" },
  env: [
    { name: "A", value: "1" },
    { name: "TOKEN", value: { secretRef: "s-global" }, secret: true },
  ],
  runtime: { binaryPath: "/usr/bin/codex", launchArgs: ["-c", "x=1"] },
  accent_color: "",
  favorites: [],
  hidden_models: [],
  shown_models: [],
  custom_models: [],
  all_workers: false,
  built_in: false,
  revision: 1,
  updated_at: new Date(),
  ...over,
});

const native = (harness: "claude" | "codex") =>
  instance({
    harness,
    id: "native",
    label: "",
    kind: "native",
    base_url: "",
    api_key: null,
    env: [],
    runtime: {},
    all_workers: true,
    built_in: true,
  });

const on = (worker: string, over: Partial<AssignmentRow> = {}): AssignmentRow => ({
  harness: "codex",
  instance_id: "team",
  worker_id: worker,
  enabled: true,
  overrides: {},
  ...over,
});

describe("effective configuration per worker (global ⊕ override)", () => {
  const all = [native("claude"), native("codex"), instance({})];

  test("an instance enabled on worker A only is absent on B; built-in natives are on both", () => {
    const a = effectiveProfiles(all, [on("A")], new Set());
    const b = effectiveProfiles(all, [on("B", { enabled: false })], new Set());
    expect(a.map((p) => `${p.providers[0]}/${p.id}`)).toEqual([
      "PROVIDER_CLAUDE/native",
      "PROVIDER_CODEX/native",
      "PROVIDER_CODEX/team",
    ]);
    expect(b.map((p) => `${p.providers[0]}/${p.id}`)).toEqual(["PROVIDER_CLAUDE/native", "PROVIDER_CODEX/native"]);
  });

  test("a disabled instance threads use on the worker stays as a stub without secrets", () => {
    const [, , stub] = effectiveProfiles(all, [on("B", { enabled: false })], new Set(["codex/team"]));
    expect(stub).toEqual({
      id: "team",
      kind: "PROVIDER_PROFILE_KIND_CLIPROXYAPI",
      providers: ["PROVIDER_CODEX"],
      disabled: true,
      displayName: "Team",
    });
  });

  test("overrides replace paths, arguments, endpoint and key, and add or replace variables by name", () => {
    const [, , team] = effectiveProfiles(
      all,
      [
        on("A", {
          overrides: {
            binaryPath: "C:\\codex\\codex.exe",
            launchArgs: [],
            baseUrl: "http://proxy-b:8317",
            apiKey: { secretRef: "k-worker" },
            env: [
              { name: "a", value: "2" },
              { name: "B", value: "3" },
            ],
          },
        }),
      ],
      new Set(),
    );

    expect(team).toEqual({
      id: "team",
      kind: "PROVIDER_PROFILE_KIND_CLIPROXYAPI",
      providers: ["PROVIDER_CODEX"],
      baseUrl: "http://proxy-b:8317",
      apiKey: { secretRef: "k-worker" },
      displayName: "Team",
      env: [
        { name: "a", value: "2" },
        { name: "TOKEN", value: { secretRef: "s-global" }, secret: true },
        { name: "B", value: "3" },
      ],
      executablePath: "C:\\codex\\codex.exe",
    });
  });

  test("all workers: enabled unless the worker says otherwise", () => {
    const everywhere = [instance({ all_workers: true })];
    expect(effectiveProfiles(everywhere, [], new Set())).toHaveLength(1);
    expect(effectiveProfiles(everywhere, [on("A", { enabled: false })], new Set())).toHaveLength(0);
  });

  test("mergeEnv keeps order and canonical JSON ignores key order", () => {
    expect(mergeEnv([{ name: "X", value: "1" }], undefined)).toEqual([{ name: "X", value: "1" }]);
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
});

describe("pickers' catalog (instance model choices)", () => {
  const catalog = create(ui.WorkerModelsSchema, {
    workerId: "A",
    profiles: [
      { provider: Provider.CODEX, profileId: "team", models: [{ id: "m1" }, { id: "m2" }, { id: "m3", hidden: true }] },
      { provider: Provider.CODEX, profileId: "native", models: [{ id: "m1" }] },
    ],
  });

  test("hidden, shown (over the provider's hidden), custom models appended, favorites first in order", () => {
    const rules = [
      {
        harness: "codex" as const,
        id: "team",
        favorites: ["m3", "m2"],
        hidden: ["m1"],
        shown: ["m3"],
        custom: ["my-model"],
      },
    ];

    const [team, other] = applyInstanceModels(catalog, rules).profiles;
    expect(team!.models.map((m) => `${m.id}${m.hidden ? " (hidden)" : ""}`)).toEqual([
      "m3",
      "m2",
      "m1 (hidden)",
      "my-model",
    ]);
    expect(other!.models.map((m) => m.id)).toEqual(["m1"]);
  });
});
