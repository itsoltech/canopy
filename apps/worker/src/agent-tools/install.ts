import { mkdirSync } from "node:fs";
import { AgentTool, type InstallAgentTool } from "@canopy/contracts";
import { processGovernor, runProcess } from "@canopy/process-governor";
import { installEnv, redactLine } from "../cli-tools/installer.ts";
import { managedPrefix, toolArgv, toolCandidates, toolEnvironment, type ToolEnv } from "./paths.ts";
import { agentToolVersion } from "./probe.ts";
import { preflightAgentTool } from "./preflight.ts";
import { serializeAgentTool } from "./queue.ts";
import type { AgentToolSpec } from "./specs.ts";

const INSTALL_TIMEOUT = 10 * 60_000;

export interface AgentToolInstallInput {
  readonly command: InstallAgentTool;
  readonly spec: AgentToolSpec;
  readonly npm: string;
  readonly dataDir: string;
  readonly env: ToolEnv;
  readonly platform: NodeJS.Platform;
  emit(line: string): Promise<void>;
}

/** One npm recipe at a time, including its postinstall and runtime verification. */
export function installAgentTool(input: AgentToolInstallInput): Promise<void> {
  return serializeAgentTool("npm", () => serializeAgentTool("operations", () => install(input)));
}

async function install(input: AgentToolInstallInput): Promise<void> {
  const { spec, command, dataDir, platform } = input;
  const { secrets } = installEnv(input.env);
  const env = toolEnvironment(input.env, platform);
  const prefix = managedPrefix(dataDir, spec);
  mkdirSync(prefix, { recursive: true, mode: 0o700 });

  const run = async (path: string, args: readonly string[]) => {
    const result = await runProcess(
      { argv: toolArgv(path, args, env), cwd: prefix, env, timeoutMs: INSTALL_TIMEOUT, maxBytes: 2 * 1024 * 1024 },
      { kind: "install", maxQueueMs: INSTALL_TIMEOUT },
    );

    for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
      const text = redactLine(line, secrets);

      if (text) await input.emit(text);
    }

    if (result.code !== 0) throw new Error(`Installer exited with code ${result.code}`);
  };

  try {
    await run(input.npm, [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-fund",
      "--no-audit",
      "--include=optional",
      `--allow-scripts=${spec.packageName}`,
      `${spec.packageName}@${spec.version}`,
    ]);
    const path = toolCandidates(spec, env, platform, dataDir, () => null)[0];

    if (!path) throw new Error(`${spec.label} was not found in its managed prefix after installation`);
    const version = await agentToolVersion(path, env);

    if (
      !("line" in version) ||
      !new RegExp(`(?:^|[^0-9.])${spec.version.replaceAll(".", "\\.")}(?:$|[^0-9.A-Za-z-])`).test(version.line)
    )
      throw new Error(`${spec.label} did not report the expected version ${spec.version}`);

    if (command.installRuntime && spec.tool === AgentTool.BROWSER) await run(path, ["install"]);
    const readiness = await preflightAgentTool(spec, path, input.env, platform);

    if (!readiness.ready)
      throw new Error(`Installed ${spec.label} ${spec.version}, but it is not ready: ${readiness.detail}`);
    await input.emit(`${spec.label} ${spec.version} is ready`);
  } finally {
    processGovernor.invalidate();
  }
}
