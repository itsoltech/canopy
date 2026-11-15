import { existsSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { AgentToolInfoSchema, type AgentToolInfo } from "@canopy/contracts";
import { ProcessTimeoutError, runProcess } from "@canopy/process-governor";
import { installEnv, redactLine } from "../cli-tools/installer.ts";
import { executablePaths, toolArgv, toolCandidates, toolEnvironment, type ToolEnv, type Which } from "./paths.ts";
import { preflightAgentTool } from "./preflight.ts";
import { serializeAgentTool } from "./queue.ts";
import type { AgentToolScope } from "./scope.ts";
import { AGENT_TOOL_SPECS, type AgentToolSpec } from "./specs.ts";

export interface AgentToolProbe {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: ToolEnv;
  readonly dataDir?: string;
  readonly which?: Which;
  readonly version?: (path: string) => Promise<{ line: string } | { error: string }>;
}

const VERSION = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\b/;
const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

export async function agentToolVersion(
  path: string,
  sourceEnv: ToolEnv,
  signal?: AbortSignal,
): Promise<{ line: string } | { error: string }> {
  const env = toolEnvironment(sourceEnv);
  const { secrets } = installEnv(sourceEnv);

  try {
    const input = {
      argv: toolArgv(path, ["--version"], env),
      env,
      timeoutMs: 2_500,
      maxBytes: 64 * 1024,
      ...(signal && { signal }),
    };

    const result = await runProcess(input, { kind: "probe", maxQueueMs: 2_500, ...(signal && { signal }) });

    return result.code === 0
      ? { line: firstLine(result.stdout) }
      : {
          error: redactLine(
            firstLine(result.stderr) || firstLine(result.stdout) || `exited with code ${result.code}`,
            secrets,
          ),
        };
  } catch (error) {
    return {
      error:
        error instanceof ProcessTimeoutError
          ? "No answer within the version check limit"
          : "The file could not be started",
    };
  }
}

export const agentToolPlatformSupported = (platform: NodeJS.Platform, arch: string): boolean =>
  ["linux", "darwin", "win32"].includes(platform) && ["x64", "arm64"].includes(arch);

export interface DiscoveredAgentTool {
  readonly spec: AgentToolSpec;
  readonly path: string;
  readonly version: string;
  readonly detail: string;
  readonly installed: boolean;
  readonly ready: boolean;
  readonly installable: boolean;
}

export function discoverAgentTool(
  spec: AgentToolSpec,
  provided: AgentToolProbe = {},
  scope: AgentToolScope = {},
): Promise<DiscoveredAgentTool> {
  return serializeAgentTool(`probe:${spec.tool}`, () => discover(spec, provided, scope), 2_500);
}

async function discover(
  spec: AgentToolSpec,
  provided: AgentToolProbe,
  scope: AgentToolScope,
): Promise<DiscoveredAgentTool> {
  const env = provided.env ?? process.env;
  const platform = provided.platform ?? process.platform;
  const supported = agentToolPlatformSupported(platform, provided.arch ?? process.arch);
  const installable = supported && executablePaths("npm", env, platform, provided.which).length > 0;
  const paths = toolCandidates(spec, env, platform, provided.dataDir, provided.which);

  let best: DiscoveredAgentTool = {
    spec,
    path: "",
    version: "",
    detail: supported ? "Not installed" : "Unsupported operating system or architecture",
    installed: false,
    ready: false,
    installable,
  };

  const signal = AbortSignal.timeout(18_000);

  for (const path of paths.slice(0, 8)) {
    if (signal.aborted) break;

    if (!existsSync(path)) continue;
    const result = await (provided.version?.(path) ?? agentToolVersion(path, env, signal));
    const version = "line" in result ? (result.line.match(VERSION)?.[0] ?? "") : "";

    const detail = !supported
      ? "Unsupported operating system or architecture"
      : "error" in result
        ? result.error
        : version !== spec.version
          ? `Install the supported version ${spec.version}${version ? ` (found ${version})` : ""}`
          : "";

    const readiness = detail
      ? { ready: false, detail }
      : await preflightAgentTool(spec, path, env, platform, scope, signal);

    const found = { spec, path, version, ...readiness, installed: true, installable };

    if (found.ready) return found;

    if (!best.installed || (version === spec.version && best.version !== spec.version)) best = found;
  }

  return best;
}

export async function discoverAgentTools(provided: AgentToolProbe = {}): Promise<DiscoveredAgentTool[]> {
  return Promise.all(AGENT_TOOL_SPECS.map((spec) => discoverAgentTool(spec, provided)));
}

export function agentToolInfo(found: DiscoveredAgentTool, status?: AgentToolInfo["install"]): AgentToolInfo {
  return create(AgentToolInfoSchema, {
    tool: found.spec.tool,
    packageName: found.spec.packageName,
    path: found.path,
    version: found.version,
    installed: found.installed,
    ready: found.ready && status?.state !== "running",
    installable: found.installable,
    detail: found.detail,
    screenshot: found.spec.screenshot,
    stream: found.spec.stream,
    ...(status && { install: status }),
  });
}
