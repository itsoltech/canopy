import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ModelInfoSchema, Provider, ProviderProfileKind, ui } from "@open-agents/contracts";
import {
  draftOf,
  draftProblems,
  hasProblems,
  idFromLabel,
  joinArgs,
  modelRows,
  overrideDraftOf,
  overrideRequest,
  saveRequest,
  splitArgs,
  statusOn,
  withFavoriteMoved,
  withVisibility,
} from "../src/lib/features/providers/instances.ts";

const instance = create(ui.ProviderInstanceSchema, {
  harness: Provider.CODEX,
  id: "team",
  label: "Team",
  kind: ProviderProfileKind.CLIPROXYAPI,
  baseUrl: "http://127.0.0.1:8317",
  apiKeySet: true,
  env: [{ name: "PROBE", value: "1" }, { name: "TOKEN", secret: true }],
  runtime: { launchArgs: ["-c", 'model_verbosity="low"'] },
  revision: 4n,
  workers: [{ workerId: "a", enabled: true, overrides: { apiKeySet: true, env: [{ name: "B_TOKEN", secret: true }] } }],
});

describe("instance forms", () => {
  test("an untouched edit sends no secret: the key and secret variables are kept by the gateway", () => {
    const request = saveRequest(draftOf(instance), { creating: false, expectedRevision: instance.revision });
    expect(request.apiKey).toBeUndefined();
    expect(request.env.map((v) => [v.name, v.secret, v.value])).toEqual([
      ["PROBE", false, "1"],
      ["TOKEN", true, undefined],
    ]);
    expect(request.runtime?.launchArgs).toEqual(["-c", 'model_verbosity="low"']);
    expect(request).toMatchObject({ harness: Provider.CODEX, id: "team", create: false, expectedRevision: 4n });
  });

  test("a worker's overrides: kept key and secret go without values; empty fields follow the definition", () => {
    const request = overrideRequest(instance, "a", overrideDraftOf(instance.workers[0]));
    expect(request.overrides?.apiKey).toBeUndefined();
    expect(request.overrides?.baseUrl).toBeUndefined();
    expect(request.overrides?.launchArgsSet).toBe(false);
    expect(request.overrides?.env.map((v) => [v.name, v.value])).toEqual([["B_TOKEN", undefined]]);
  });

  test("new instances: id from the label, its rules, a taken id", () => {
    expect(idFromLabel("Team Proxy (EU)")).toBe("team-proxy-eu");
    const draft = { ...draftOf(instance), id: "Bad Id", baseUrl: "nope" };
    const problems = draftProblems(draft, { builtIn: false, creating: true, takenIds: new Set(["team"]) });
    expect(problems.id).toContain("lowercase");
    expect(problems.baseUrl).toContain("http(s)");
    expect(draftProblems({ ...draftOf(instance), id: "team" }, { builtIn: false, creating: true, takenIds: new Set(["team"]) }).id).toContain("already has");
    expect(hasProblems(draftProblems(draftOf(instance), { builtIn: false, creating: false, takenIds: new Set() }))).toBe(false);
  });

  test("launch arguments round-trip through one line", () => {
    const args = ["-c", 'model_verbosity="low"', "--flag", "a b"];
    expect(splitArgs(joinArgs(args))).toEqual(args);
    expect(splitArgs("  --debug   -c x=1 ")).toEqual(["--debug", "-c", "x=1"]);
  });
});

describe("status and models", () => {
  test("status lines like T3: authenticated, not installed, missing key, turned off", () => {
    const on = (init: Partial<ui.InstanceOnWorker>) => create(ui.InstanceOnWorkerSchema, { workerId: "a", enabled: true, reported: true, ...init });
    expect(statusOn(on({ available: true, authenticated: true, auth: "ChatGPT" }), true).label).toBe("Authenticated · ChatGPT");
    expect(statusOn(on({ detail: "/opt/codex not found or not runnable" }), true).label).toBe("Not installed");
    expect(statusOn(on({ detail: "api_key is not set" }), true).label).toBe("Missing key");
    expect(statusOn(on({ enabled: false }), true).label).toBe("Turned off");
  });

  test("rows: favorites first in order, hidden (also by the provider), custom models", () => {
    const catalog = [
      create(ModelInfoSchema, { id: "a", efforts: ["low"], isDefault: true }),
      create(ModelInfoSchema, { id: "b" }),
      create(ModelInfoSchema, { id: "c", hidden: true }),
    ];
    const models = create(ui.InstanceModelsSchema, { favorites: ["b", "a"], hidden: ["a"], custom: ["mine"] });
    const rows = modelRows(catalog, models);
    expect(rows.map((r) => `${r.id}${r.hidden ? "-" : ""}`)).toEqual(["b", "a-", "c-", "mine"]);
    expect(rows.find((r) => r.id === "a")?.tags).toEqual(["reasoning", "default"]);
    const shown = withVisibility(models, rows.find((r) => r.id === "c")!, true);
    expect(shown.shown).toEqual(["c"]);
    expect(withFavoriteMoved(models, "a", -1).favorites).toEqual(["a", "b"]);
  });
});
