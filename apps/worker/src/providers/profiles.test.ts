import { describe, expect, test } from "bun:test";
import { Provider, ProviderProfileKind } from "@open-agents/contracts";
import { claudeProfileOptions } from "./claude.ts";
import { codexAppServerLaunch, codexThreadProvider } from "./codex.ts";
import {
  ProfileError,
  resolveProfiles,
  selectProfile,
  toHelloProfile,
  type ProviderProfileConfig,
  type ResolvedProfile,
} from "./profiles.ts";

const PROXY: ProviderProfileConfig = {
  kind: "cliproxyapi",
  id: "cliproxy",
  baseUrl: "http://127.0.0.1:8317",
  apiKeyEnv: "CLIPROXY_KEY",
};
const ENV = { PATH: "/usr/bin", HOME: "/home/u", CLIPROXY_KEY: "sk-proxy" };

function resolved(configs: ProviderProfileConfig[], env = ENV): ResolvedProfile[] {
  return resolveProfiles(configs, env).flatMap((s) => (s.resolved ? [s.resolved] : []));
}

describe("resolveProfiles", () => {
  test("always includes the native profile", () => {
    expect(resolveProfiles([PROXY], ENV).map((s) => s.config.id)).toEqual(["native", "cliproxy"]);
  });

  test("missing key makes the profile unavailable, not fatal", () => {
    const [, proxy] = resolveProfiles([PROXY], { PATH: "/usr/bin" });
    expect(proxy?.resolved).toBeUndefined();
    expect(proxy?.problem).toBe("env CLIPROXY_KEY is not set");
  });

  test("rejects invalid ids, duplicates, bad URLs and credentials in the URL", () => {
    expect(() => resolveProfiles([{ ...PROXY, id: "Bad Id" }], ENV)).toThrow(ProfileError);
    expect(() => resolveProfiles([PROXY, PROXY], ENV)).toThrow("duplicate");
    expect(() => resolveProfiles([{ ...PROXY, baseUrl: "not a url" }], ENV)).toThrow("invalid baseUrl");
    expect(() => resolveProfiles([{ ...PROXY, baseUrl: "file:///tmp" }], ENV)).toThrow("http(s)");
    expect(() => resolveProfiles([{ ...PROXY, baseUrl: "http://u:p@host" }], ENV)).toThrow("apiKeyEnv");
  });
});

describe("toHelloProfile", () => {
  test("advertises id, kind, endpoint origin and availability without the key", () => {
    const [native, proxy] = resolveProfiles([{ ...PROXY, baseUrl: "http://127.0.0.1:8317/some/path" }], ENV);
    expect(toHelloProfile(native!)).toMatchObject({ id: "native", kind: ProviderProfileKind.NATIVE, available: true });
    const hello = toHelloProfile(proxy!);
    expect(hello).toMatchObject({
      id: "cliproxy",
      kind: ProviderProfileKind.CLIPROXYAPI,
      providers: [Provider.CLAUDE, Provider.CODEX],
      endpoint: "http://127.0.0.1:8317",
      available: true,
    });
    expect(JSON.stringify(hello)).not.toContain("sk-proxy");
  });
});

describe("selectProfile", () => {
  const statuses = resolveProfiles([{ ...PROXY, providers: ["claude"] }], ENV);

  test("empty id selects native", () => {
    expect(selectProfile(statuses, "", "codex").kind).toBe("native");
  });

  test("refuses unknown, unavailable and provider-mismatched profiles", () => {
    expect(() => selectProfile(statuses, "nope", "claude")).toThrow("unknown");
    expect(() => selectProfile(statuses, "cliproxy", "codex")).toThrow("not enabled for codex");
    const noKey = resolveProfiles([PROXY], {});
    expect(() => selectProfile(noKey, "cliproxy", "claude")).toThrow("unavailable");
  });
});

describe("claudeProfileOptions", () => {
  test("native keeps the environment and skips user settings", () => {
    const [native] = resolved([]);
    const options = claudeProfileOptions(native!, { ...ENV, ANTHROPIC_API_KEY: "sk-ant" });
    expect(options.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant", PATH: "/usr/bin" });
    expect(options.settingSources).toEqual(["project", "local"]);
  });

  test("cliproxyapi swaps auth variables for the proxy", () => {
    const [, proxy] = resolved([{ ...PROXY, baseUrl: "http://127.0.0.1:8317/" }]);
    const options = claudeProfileOptions(proxy!, { ...ENV, ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
    expect(options.env).toEqual({
      ...ENV,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "sk-proxy",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    });
  });
});

describe("codexAppServerLaunch", () => {
  test("native only: plain app-server, no overrides", () => {
    expect(codexAppServerLaunch(resolved([]), ENV).command).toEqual([
      "codex", "app-server",
      "-c", "features.multi_agent=false",
      "-c", "features.multi_agent_v2=false",
      "-c", "features.in_app_local_automation=false",
      "-c", "features.sleep_tool=false",
    ]);
  });

  test("cliproxyapi adds a model provider; the key goes through env, not argv", () => {
    const profiles = resolved([PROXY, { ...PROXY, id: "claude-only", providers: ["claude"] }]);
    const launch = codexAppServerLaunch(profiles, ENV);
    expect(launch.command.slice(10)).toEqual([
      "-c", 'model_providers.openagents_cliproxy.name="CLIProxyAPI (cliproxy)"',
      "-c", 'model_providers.openagents_cliproxy.base_url="http://127.0.0.1:8317/v1"',
      "-c", 'model_providers.openagents_cliproxy.wire_api="responses"',
      "-c", 'model_providers.openagents_cliproxy.env_key="OPENAGENTS_CLIPROXY_API_KEY"',
      "-c", "model_providers.openagents_cliproxy.requires_openai_auth=false",
    ]);
    expect(launch.env["OPENAGENTS_CLIPROXY_API_KEY"]).toBe("sk-proxy");
    expect(launch.command.join(" ")).not.toContain("sk-proxy");
  });

  test("threads select the provider by id", () => {
    const [native, proxy] = resolved([{ ...PROXY, id: "my-proxy" }]);
    expect(codexThreadProvider(native!)).toEqual({});
    expect(codexThreadProvider(proxy!)).toEqual({ modelProvider: "openagents_my_proxy" });
  });

  const codexBin = Bun.which("codex");
  // Codex validates the config without starting the server (unknown fields/variants and providers fail).
  test.skipIf(!codexBin)("the real codex CLI accepts the generated provider and can select it", () => {
    const [, proxy] = resolved([PROXY]);
    const launch = codexAppServerLaunch([proxy!], { ...process.env, ...ENV }, codexBin!);
    const select = `model_provider="${codexThreadProvider(proxy!).modelProvider ?? ""}"`;
    const result = Bun.spawnSync([...launch.command, "-c", select, "--print-startup-config"], { env: launch.env });
    expect(result.stdout.toString()).toContain('"appServerVersion"');
    expect(result.exitCode).toBe(0);
  });
});
