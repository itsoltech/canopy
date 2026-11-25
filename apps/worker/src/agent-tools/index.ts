import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import {
  AgentTool,
  AgentToolInstallStatusSchema,
  AgentToolsReportSchema,
  AgentToolProgressSchema,
  type AgentToolInstallStatus,
  type AgentToolSessionDefaults,
  type AgentToolProgress,
  type InstallAgentTool,
  type RunAgentTool,
} from "@canopy/contracts";
import { installEnv, redactLine } from "../cli-tools/installer.ts";
import { agentToolInfo, agentToolPlatformSupported, type AgentToolProbe } from "./probe.ts";
import { AGENT_TOOL_SPECS, agentToolSpec } from "./specs.ts";
import { runAgentToolOperation } from "./operations.ts";
import { executablePaths, resolveLauncher, toolArgv, toolEnvironment, type ToolEnv } from "./paths.ts";
import { agentToolOperationArgs, validateAgentToolCommand } from "./argv.ts";
import { installAgentTool } from "./install.ts";
import { agentToolSession } from "./scope.ts";
import { AgentToolDiscoveryCache } from "./cache.ts";
import { AgentToolLifecycle } from "./lifecycle.ts";
import { AgentToolCleanup } from "./cleanup.ts";
import { DeviceAutomation } from "./device-automation.ts";
import { browserDefaultsInitializer } from "./browser-defaults.ts";
import type { LocalAutomationServer } from "../agent-tools-mcp/stdio.ts";

type ReportInit = MessageInitShape<typeof AgentToolsReportSchema>;

type ProgressInit = MessageInitShape<typeof AgentToolProgressSchema>;

export class AgentToolRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentToolsOptions {
  readonly dataDir: string;
  readonly probe?: AgentToolProbe;
  readonly env?: ToolEnv;
  send(report: ReportInit): void | Promise<void>;
  progress(progress: ProgressInit): void | Promise<void>;
}

export type LocalAgentToolMcpServer = LocalAutomationServer;

export const localMcpName = (tool: AgentTool): string => `agent_${AgentTool[tool].toLowerCase()}`;

/** Link/report sinks may disappear during reconnect; keep install outcomes available for the next report. */
async function deliver(send: () => void | Promise<void>): Promise<void> {
  try {
    await send();
  } catch {
    // The next probe publishes the retained status after the worker reconnects.
  }
}

export class AgentTools {
  readonly #options: AgentToolsOptions;
  readonly #status = new Map<AgentTool, AgentToolInstallStatus>();
  readonly #installing = new Map<AgentTool, Promise<void>>();
  readonly #cache = new AgentToolDiscoveryCache();
  readonly #lifecycle = new AgentToolLifecycle();
  readonly #devices: DeviceAutomation;
  readonly #cleanup = new AgentToolCleanup(() => this.#probeOptions());
  #last: ReportInit | undefined;

  constructor(options: AgentToolsOptions) {
    this.#options = options;
    this.#devices = new DeviceAutomation(options.dataDir, () => this.#probeOptions());
  }

  get last(): ReportInit | undefined {
    return this.#last;
  }

  #probeOptions(): AgentToolProbe {
    return {
      ...this.#options.probe,
      dataDir: this.#options.dataDir,
      env: this.#options.env ?? this.#options.probe?.env ?? process.env,
    };
  }

  async report(): Promise<ReportInit> {
    const found = await Promise.all(
      AGENT_TOOL_SPECS.map((spec) => this.#cache.discover(spec, this.#probeOptions(), {}, true)),
    );

    const report: ReportInit = {
      tools: found.map((item) => agentToolInfo(item, this.#status.get(item.spec.tool))),
      os: this.#options.probe?.platform ?? process.platform,
      arch: this.#options.probe?.arch ?? process.arch,
      checkedAt: timestampNow(),
    };

    this.#last = report;
    await deliver(() => this.#options.send(report));

    return report;
  }

  /** Ready local MCP servers for a gateway-approved ThreadSpec snapshot. */
  localMcpServers(
    tools: readonly AgentTool[],
    threadId?: string,
    defaults?: AgentToolSessionDefaults,
  ): LocalAgentToolMcpServer[] {
    if (threadId && this.#lifecycle.isClosed(threadId)) return [];
    const env = toolEnvironment(this.#probeOptions().env ?? process.env);

    const available = new Map(
      (this.#last?.tools ?? []).flatMap((tool) =>
        tool.installed &&
        (tool.ready || (tool.tool === AgentTool.DEVICE && tool.version === agentToolSpec(AgentTool.DEVICE).version)) &&
        tool.path &&
        this.#status.get(tool.tool ?? AgentTool.UNSPECIFIED)?.state !== "running"
          ? [[tool.tool, tool.path]]
          : [],
      ),
    );

    return [...new Set(tools)].flatMap((tool) => {
      const path = available.get(tool);

      if (!path) return [];

      try {
        const session = threadId ? agentToolSession(threadId) : "";
        const scope = session && tool !== AgentTool.DEVICE ? ["--session", session] : [];
        const headed = session && tool === AgentTool.DESKTOP && defaults?.desktop?.allowPhysicalInput;
        const [command, ...args] = toolArgv(path, [...scope, ...(headed ? ["--headed"] : []), "mcp"], env);

        return command
          ? [
              {
                name: localMcpName(tool),
                ...(session &&
                  tool === AgentTool.DEVICE && { managed: this.#devices.managed(session, defaults?.device) }),
                command,
                args,
                ...(session && { scope: { tool, session, ...(defaults && { defaults }) } }),
                ...(session &&
                  tool === AgentTool.BROWSER &&
                  defaults?.browser && {
                    prepare: browserDefaultsInitializer(path, env, session, defaults?.browser),
                  }),
                ...(session &&
                  tool !== AgentTool.DESKTOP && {
                    env:
                      tool === AgentTool.BROWSER
                        ? { AGENT_BROWSER_SESSION: session }
                        : { AGENT_DEVICE_SESSION: session },
                  }),
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
  }

  async probe(): Promise<ReportInit> {
    return this.report();
  }

  async install(command: InstallAgentTool): Promise<void> {
    const spec = agentToolSpec(command.tool);
    const probe = this.#probeOptions();
    const env = probe.env ?? process.env;
    const platform = probe.platform ?? process.platform;

    if (this.#installing.has(command.tool))
      throw new AgentToolRefused("AGENT_TOOL_INSTALL_RUNNING", `${spec.label} is already being installed`);

    if (command.version && command.version !== spec.version)
      throw new AgentToolRefused("INVALID_VERSION", `${spec.label} is pinned to ${spec.version}`);

    if (!command.installId) throw new AgentToolRefused("INVALID_COMMAND", "install_id missing");

    if (!agentToolPlatformSupported(platform, probe.arch ?? process.arch))
      throw new AgentToolRefused(
        "UNSUPPORTED_PLATFORM",
        "Automation tools are not supported on this operating system or architecture",
      );
    const npmPath = executablePaths("npm", env, platform, probe.which)[0];
    const npm = npmPath ? resolveLauncher(npmPath, "npm") : "";

    if (!npm) throw new AgentToolRefused("NPM_NOT_FOUND", "npm is required to install automation tools");
    this.#status.set(
      command.tool,
      create(AgentToolInstallStatusSchema, {
        installId: command.installId,
        state: "running",
        targetVersion: spec.version,
        startedAt: timestampNow(),
      }),
    );
    const task = this.#runInstall(command, npm, env, platform);
    this.#installing.set(command.tool, task);
    void task.then(
      () => this.#installing.delete(command.tool),
      () => this.#installing.delete(command.tool),
    );
    const report = this.#last;

    if (report) {
      for (const tool of report.tools ?? []) {
        if (tool.tool === command.tool) {
          tool.ready = false;
          tool.install = this.#status.get(command.tool);
        }
      }

      await deliver(() => this.#options.send(report));
    }
  }

  async #runInstall(command: InstallAgentTool, npm: string, env: ToolEnv, platform: NodeJS.Platform): Promise<void> {
    const status = this.#status.get(command.tool);

    if (!status) return;
    const { secrets } = installEnv(env);

    try {
      await installAgentTool({
        command,
        npm,
        spec: agentToolSpec(command.tool),
        dataDir: this.#options.dataDir,
        env,
        platform,
        emit: (line) =>
          deliver(() => this.#options.progress({ installId: command.installId, tool: command.tool, lines: [line] })),
      });
      status.state = "succeeded";
    } catch (error) {
      status.state = "failed";
      status.error = redactLine(
        error instanceof Error ? error.message : "Automation tool installation failed",
        secrets,
      );
    }

    status.finishedAt = timestampNow();
    this.#cache.invalidate(command.tool);
    await deliver(() => this.report().then(() => undefined));
  }

  /** Archive/unload fences admission immediately and drains native operations before closing their sessions. */
  fenceThread(threadId: string): void {
    this.#lifecycle.fence(threadId);
    this.#devices.fence(threadId);
  }

  closeThread(threadId: string): Promise<void> {
    this.#devices.fence(threadId);

    return this.#lifecycle.close(threadId, async () => {
      await this.#cleanup.close(agentToolSession(threadId));
      await this.#devices.release(threadId);
    });
  }

  async threadOpened(threadId: string): Promise<void> {
    await this.#lifecycle.open(threadId);

    if (!this.#lifecycle.isClosed(threadId)) this.#devices.open(threadId);
  }

  async run(command: RunAgentTool): Promise<Awaited<ReturnType<typeof runAgentToolOperation>>> {
    return this.#lifecycle.run(command.session, () => this.#run(command));
  }

  async #run(command: RunAgentTool): Promise<Awaited<ReturnType<typeof runAgentToolOperation>>> {
    const spec = agentToolSpec(command.tool);
    agentToolOperationArgs(command, "screenshot.png");

    if (this.#installing.has(command.tool))
      throw new AgentToolRefused("AGENT_TOOL_INSTALL_RUNNING", `${spec.label} is being installed`);
    const found = await this.#cache.discover(spec, this.#probeOptions(), command);

    if (!found.installed) throw new AgentToolRefused("AGENT_TOOL_NOT_INSTALLED", `${spec.label} is not installed`);

    if (!found.ready) throw new AgentToolRefused("AGENT_TOOL_NOT_READY", found.detail);
    this.#lifecycle.assertOpen(command.session);

    try {
      const run = () =>
        runAgentToolOperation(command, found.path, this.#probeOptions().env ?? process.env, () =>
          this.#lifecycle.assertOpen(command.session),
        );

      return command.tool === AgentTool.DEVICE
        ? await this.#devices.use(command, AbortSignal.timeout(60_000), run)
        : await run();
    } catch (error) {
      this.#cache.invalidate(command.tool);
      throw error;
    }
  }

  recoverDevices(): Promise<void> {
    return this.#devices.recover();
  }

  close(): Promise<void> {
    return this.#devices.close();
  }

  /** Preview backends resolve once, then retain this pinned runtime until their lease ends. */
  async resolvePreviewScope(scope: RunAgentTool, defaults?: AgentToolSessionDefaults) {
    return this.#lifecycle.run(scope.session, () => this.#resolvePreviewScope(scope, defaults));
  }

  async #resolvePreviewScope(scope: RunAgentTool, defaults?: AgentToolSessionDefaults) {
    if (scope.tool === AgentTool.DESKTOP && !scope.app && !scope.windowId) scope.app = defaults?.desktop?.app ?? "";
    validateAgentToolCommand(scope);
    const spec = agentToolSpec(scope.tool);

    if (this.#installing.has(scope.tool))
      throw new AgentToolRefused("AGENT_TOOL_INSTALL_RUNNING", `${spec.label} is being installed`);
    // Discovery uses the active device session; explicit catalog selectors are resolved by the preview backend.
    const found = await this.#cache.discover(spec, this.#probeOptions(), { session: scope.session });

    // Device discovery can require a selector; its catalog must remain reachable before a target is chosen.
    const supported = agentToolPlatformSupported(
      this.#options.probe?.platform ?? process.platform,
      this.#options.probe?.arch ?? process.arch,
    );

    if (
      !found.ready &&
      !(scope.tool === AgentTool.DEVICE && found.installed && found.version === spec.version && supported)
    )
      throw new AgentToolRefused("AGENT_TOOL_NOT_READY", found.detail);
    this.#lifecycle.assertOpen(scope.session);
    const source = this.#probeOptions().env ?? process.env;
    const { secrets } = installEnv(source);

    return {
      ...(scope.tool === AgentTool.DEVICE && {
        devicePlatform: this.#devices.currentPlatform(scope.session) ?? defaults?.device?.platform ?? "",
        canPreviewDevice: (deviceId: string, platform: string) =>
          this.#devices.canPreview(scope.session, deviceId, platform),
      }),
      useDevice: <T>(signal: AbortSignal, work: () => Promise<T>) =>
        this.#devices.use(scope, signal, work, defaults?.device),
      ...(scope.tool === AgentTool.BROWSER && {
        initializeBrowser: browserDefaultsInitializer(
          found.path,
          toolEnvironment(source),
          agentToolSession(scope.session),
          defaults?.browser,
        ),
      }),
      executable: found.path,
      env: toolEnvironment(source),
      scope,
      redact: (detail: string) => redactLine(detail, secrets),
    };
  }
}

export { AgentTool, type AgentToolProgress, type RunAgentTool };
