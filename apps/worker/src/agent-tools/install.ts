import { mkdirSync } from "node:fs";
import { AgentTool, type InstallAgentTool } from "@canopy/contracts";
import { processGovernor, runProcess } from "@canopy/process-governor";
import { z } from "zod";
import { installEnv, redactLine } from "../cli-tools/installer.ts";
import { managedPrefix, toolArgv, toolCandidates, toolEnvironment, type ToolEnv } from "./paths.ts";
import { agentToolVersion, discoverAgentTool, reportedAgentToolVersion } from "./probe.ts";
import { preflightAgentTool, type ToolReadiness } from "./preflight.ts";
import { serializeAgentTool } from "./queue.ts";
import type { AgentToolSpec } from "./specs.ts";

const INSTALL_TIMEOUT = 10 * 60_000;

const permissionGuide = z.object({
  ok: z.literal(true),
  data: z.object({ guide: z.enum(["started", "already_running", "not_needed"]) }),
});

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

  const run = async (path: string, args: readonly string[]) => {
    const result = await runProcess(
      {
        argv: toolArgv(path, args, env, platform),
        cwd: prefix,
        env,
        timeoutMs: INSTALL_TIMEOUT,
        maxBytes: 2 * 1024 * 1024,
      },
      { kind: "install", maxQueueMs: INSTALL_TIMEOUT },
    );

    for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
      const text = redactLine(line, secrets);

      if (text) await input.emit(text);
    }

    if (result.code !== 0) throw new Error(`Installer exited with code ${result.code}`);
  };

  try {
    if (platform === "darwin" && spec.tool === AgentTool.DESKTOP) {
      const existing = await discoverAgentTool(spec, { dataDir, env: input.env, platform });

      if (existing.ready || existing.needsMacDesktopPermissions) {
        await finishInstall(input, existing.path, env, existing);

        return;
      }
    }

    mkdirSync(prefix, { recursive: true, mode: 0o700 });
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
    const version = await agentToolVersion(path, input.env, undefined, platform);

    if ("error" in version) throw new Error(`Could not check ${spec.label} version: ${version.error}`);
    const reported = reportedAgentToolVersion(version.line);

    if (reported !== spec.version)
      throw new Error(
        `${spec.label} did not report the expected version ${spec.version}${reported ? ` (found ${reported})` : ""}`,
      );

    if (command.installRuntime && spec.tool === AgentTool.BROWSER) await run(path, ["install"]);
    const readiness = await preflightAgentTool(spec, path, input.env, platform);

    await finishInstall(input, path, env, readiness);
  } finally {
    processGovernor.invalidate();
  }
}

async function finishInstall(input: AgentToolInstallInput, path: string, env: ToolEnv, readiness: ToolReadiness) {
  const { spec, platform } = input;

  if (readiness.ready) {
    await input.emit(`${spec.label} ${spec.version} is ready`);
  } else if (readiness.needsMacDesktopPermissions) {
    await input.emit(`${spec.label} ${spec.version} is installed.`);
    const message = await openPermissionGuide(path, env, platform);

    if (message) await input.emit(message);
  } else {
    throw new Error(`Installed ${spec.label} ${spec.version}, but it is not ready: ${readiness.detail}`);
  }
}

async function openPermissionGuide(path: string, env: ToolEnv, platform: NodeJS.Platform): Promise<string> {
  try {
    const result = await runProcess(
      {
        argv: toolArgv(path, ["permissions", "--guide"], env, platform),
        env,
        timeoutMs: 12_000,
        maxBytes: 64 * 1024,
      },
      { kind: "install", maxQueueMs: 2_500 },
    );

    if (result.code === 0) {
      const response = permissionGuide.safeParse(JSON.parse(result.stdout));

      if (response.success)
        return response.data.data.guide === "not_needed"
          ? ""
          : "Follow the permission guide on the Mac running this worker.";
    }
  } catch {
    // A worker outside a graphical session may be unable to open the guide.
  }

  return "Could not open the permission guide. Open System Settings → Privacy & Security on the Mac running this worker.";
}
