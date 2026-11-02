import { describe, expect, test } from "bun:test";
import { Provider, ProviderProfileKind } from "@open-agents/contracts";
import { claudeProfileOptions } from "./claude/profile.ts";
import { codexAppServerLaunch, codexThreadProvider } from "./codex/launch.ts";
import {
  ProfileError,
  resolveProfiles,
  selectProfile,
  toProfileReport,
  type ProviderProfileConfig,
  type ResolvedProfile,
} from "./profiles.ts";

const PROXY: ProviderProfileConfig = {
  kind: "cliproxyapi",
  id: "cliproxy",
  baseUrl: "http://127.0.0.1:8317",
  apiKey: "sk-proxy",
};
const ENV = { PATH: "/usr/bin", HOME: "/home/u" };

function resolved(configs: ProviderProfileConfig[]): ResolvedProfile[] {
  return resolveProfiles(configs).flatMap((s) => (s.resolved ? [s.resolved] : []));
}

describe("resolveProfiles", () => {
  test("always includes the native profile", () => {
    expect(resolveProfiles([PROXY]).map((s) => s.config.id)).toEqual(["native", "cliproxy"]);
  });

  test("missing key makes the profile unavailable, not fatal", () => {
    const [, proxy] = resolveProfiles([{ ...PROXY, apiKey: "" }]);
    expect(proxy?.resolved).toBeUndefined();
    expect(proxy?.problem).toBe("api_key is not set");
  });

  test("rejects invalid ids, duplicates, bad URLs and credentials in the URL", () => {
    expect(() => resolveProfiles([{ ...PROXY, id: "Bad Id" }])).toThrow(ProfileError);
    expect(() => resolveProfiles([PROXY, PROXY])).toThrow("duplicate");
    expect(() => resolveProfiles([{ ...PROXY, baseUrl: "not a url" }])).toThrow("invalid baseUrl");
    expect(() => resolveProfiles([{ ...PROXY, baseUrl: "file:///tmp" }])).toThrow("http(s)");
    expect(() => resolveProfiles([{ ...PROXY, baseUrl: "http://u:p@host" }])).toThrow("api_key");
  });
});

describe("toProfileReport", () => {
  test("advertises id, kind, endpoint origin and availability without the key", () => {
    const [native, proxy] = resolveProfiles([{ ...PROXY, baseUrl: "http://127.0.0.1:8317/some/path" }]);
    expect(toProfileReport(native!)).toMatchObject({ id: "native", kind: ProviderProfileKind.NATIVE, available: true });
    const hello = toProfileReport(proxy!);
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
  const statuses = resolveProfiles([{ ...PROXY, providers: ["claude"] }]);

  test("empty id selects native", () => {
    expect(selectProfile(statuses, "", "codex").kind).toBe("native");
  });

  test("refuses unknown, unavailable and provider-mismatched profiles", () => {
    expect(() => selectProfile(statuses, "nope", "claude")).toThrow("unknown");
    expect(() => selectProfile(statuses, "cliproxy", "codex")).toThrow("not enabled for codex");
    const noKey = resolveProfiles([{ ...PROXY, apiKey: "" }]);
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
      "-c", "features.apps=false",
      "-c", "agents.enabled=false",
    ]);
  });

  test("cliproxyapi adds a model provider; the key goes through env, not argv", () => {
    const profiles = resolved([PROXY, { ...PROXY, id: "claude-only", providers: ["claude"] }]);
    const launch = codexAppServerLaunch(profiles, ENV);
    expect(launch.command.slice(14)).toEqual([
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

describe("custom profiles and their environment", () => {
  const PROBE = { name: "OPENAGENTS_TEAM_API_KEY", value: "x" };

  test("a profile's variables reach Claude over the base env; auth of an endpoint profile still wins", () => {
    const [, proxy, custom] = resolved([
      { ...PROXY, env: [{ name: "HTTPS_PROXY", value: "http://corp:3128" }, { name: "MY_TOKEN", value: "s3cret", secret: true }] },
      { kind: "native", id: "bedrock", providers: ["claude"], env: [{ name: "CLAUDE_CODE_USE_BEDROCK", value: "1" }] },
    ]);
    expect(claudeProfileOptions(proxy!, ENV).env).toMatchObject({ HTTPS_PROXY: "http://corp:3128", MY_TOKEN: "s3cret", ANTHROPIC_AUTH_TOKEN: "sk-proxy" });
    expect(claudeProfileOptions(custom!, ENV).env).toMatchObject({ ...ENV, CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  test("a native-kind custom profile serves only the providers it lists", () => {
    const statuses = resolveProfiles([{ kind: "native", id: "bedrock", providers: ["claude"] }]);
    expect(selectProfile(statuses, "bedrock", "claude").id).toBe("bedrock");
    expect(() => selectProfile(statuses, "bedrock", "codex")).toThrow("not enabled for codex");
  });

  test("a variable the worker controls makes only that profile unavailable, naming the variable but not its value", () => {
    const [, bad] = resolveProfiles([{ ...PROXY, env: [{ name: "CODEX_HOME", value: "/tmp/elsewhere", secret: true }] }]);
    expect(bad?.resolved).toBeUndefined();
    expect(bad?.problem).toContain("CODEX_HOME");
    expect(bad?.problem).not.toContain("/tmp/elsewhere");
    expect(resolveProfiles([{ ...PROXY, env: [PROBE] }])[1]?.problem).toContain("reserved");
    expect(resolveProfiles([{ ...PROXY, env: [{ name: "ANTHROPIC_BASE_URL", value: "http://x" }] }])[1]?.problem).toContain("endpoint");
  });

  test("a disabled profile is unavailable and reported so", () => {
    const [, disabled] = resolveProfiles([{ ...PROXY, disabled: true }]);
    expect(disabled?.resolved).toBeUndefined();
    expect(toProfileReport(disabled!)).toMatchObject({ available: false, detail: "disabled" });
  });

  test("the report carries the display name, never key or variable values", () => {
    const [, proxy] = resolveProfiles([{ ...PROXY, displayName: "Team proxy", env: [{ name: "MY_TOKEN", value: "s3cret-value", secret: true }] }]);
    const report = toProfileReport(proxy!);
    expect(report.displayName).toBe("Team proxy");
    expect(JSON.stringify(report)).not.toContain("s3cret-value");
    expect(JSON.stringify(report)).not.toContain("sk-proxy");
  });

  test("Codex: the profile's variables go into the process env, not argv", () => {
    const [, proxy] = resolved([{ ...PROXY, env: [{ name: "PROFILE_PROBE", value: "probe-1" }] }]);
    const launch = codexAppServerLaunch([proxy!], ENV, "codex", undefined, "/data/codex-home", proxy!.env);
    expect(launch.env).toMatchObject({ PROFILE_PROBE: "probe-1", CODEX_HOME: "/data/codex-home", OPENAGENTS_CLIPROXY_API_KEY: "sk-proxy" });
    expect(launch.command.join(" ")).not.toContain("probe-1");
  });
});
