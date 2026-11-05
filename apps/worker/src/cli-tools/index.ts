import { join } from "node:path";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import {
  CliInstallMethod,
  Provider,
  type CliInstallProgressSchema,
  type CliInstallStatusSchema,
  type CliToolsReportSchema,
  type InstallCli,
} from "@canopy/contracts";
import { CLIS, cliOf, discoverCli, type CliName, type CliProbe, type DiscoveredCli } from "./discovery.ts";
import { runInstall } from "./installer.ts";
import { shellEnvReady } from "./shell-env.ts";
import { planRecipe, validTarget, type RecipeTools } from "./recipes.ts";

export { findCli } from "./discovery.ts";

type ReportInit = MessageInitShape<typeof CliToolsReportSchema>;

type StatusInit = MessageInitShape<typeof CliInstallStatusSchema>;

type ProgressInit = MessageInitShape<typeof CliInstallProgressSchema>;

/** A refused InstallCli (CommandResult error code + message). */
export class CliRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CliToolsOptions {
  readonly dataDir: string;
  readonly probe: CliProbe;
  /** Executables set in the worker configuration (ProviderConfig.executable_path). */
  configured(): Partial<Record<CliName, string>>;
  send(report: ReportInit): void;
  progress(progress: ProgressInit): void;
  /** Running turns (and turns being admitted) of a provider on this worker. */
  busy(provider: Provider): number;
  /** After an install: check the providers again (new versions, runtimes restart when idle). */
  installed(): Promise<void>;
  log(message: string): void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

/**
 * Provider CLIs on this worker (docs/provider-cli.md): discovery reports, and installs on demand. One install at a
 * time; a provider with running turns is refused (nothing waits behind a click), and new turns of a provider being
 * installed wait for it (`settled`).
 */
export class CliTools {
  readonly #options: CliToolsOptions;
  readonly #status = new Map<Provider, StatusInit>();
  #installing: { provider: Provider; done: Promise<void> } | undefined;
  #last: ReportInit | undefined;
  #discovering: Promise<ReportInit> | undefined;

  constructor(options: CliToolsOptions) {
    this.#options = options;
  }

  get last(): ReportInit | undefined {
    return this.#last;
  }

  #tools(): RecipeTools {
    const { probe } = this.#options;

    return {
      platform: probe.platform,
      home: probe.home,
      ...(probe.env && { env: probe.env }),
      which: (c) => probe.which(c),
    };
  }

  async #discover(spec: (typeof CLIS)[number]): Promise<DiscoveredCli> {
    await shellEnvReady();

    return discoverCli(spec, this.#options.configured()[spec.name], this.#options.probe);
  }

  /** Discovers every CLI and sends the report (concurrent calls share one run). */
  async report(): Promise<ReportInit> {
    this.#discovering ??= (async () => {
      try {
        const found = await Promise.all(CLIS.map((spec) => this.#discover(spec)));

        const report: ReportInit = {
          tools: found.map((cli) => this.#entry(cli)),
          os: this.#options.probe.platform,
          arch: process.arch,
          checkedAt: timestampNow(),
        };

        this.#last = report;
        this.#options.send(report);

        return report;
      } finally {
        this.#discovering = undefined;
      }
    })();

    return this.#discovering;
  }

  #entry(cli: DiscoveredCli): NonNullable<ReportInit["tools"]>[number] {
    let plan;

    try {
      plan = planRecipe(cli, "latest", this.#tools());
    } catch {
      plan = {};
    }

    const status = this.#status.get(cli.spec.provider);

    return {
      provider: cli.spec.provider,
      method: cli.method,
      path: cli.path,
      resolvedPath: cli.resolvedPath,
      version: cli.version,
      configuredPath: cli.configuredPath,
      installable: Boolean(plan.recipe),
      manualCommand: plan.manualCommand ?? "",
      detail: [cli.detail, plan.detail].filter(Boolean).join(". "),
      versionError: cli.versionError ?? "",
      alternatives: (cli.alternatives ?? []).map((a) => ({ ...a })),
      ...(status && { install: status }),
    };
  }

  /** Resolves once no install of this provider is running (new turns of it wait here). */
  async settled(provider: Provider): Promise<void> {
    while (this.#installing?.provider === provider) await this.#installing.done;
  }

  /**
   * Starts an install (InstallCli). Throws CliRefused when it cannot start; otherwise returns at once and reports
   * progress and the result (a new report with CliTool.install).
   */
  async start(command: InstallCli): Promise<void> {
    const spec = cliOf(command.provider);

    if (!spec) throw new CliRefused("UNSUPPORTED", "unknown provider");

    if (!command.installId) throw new CliRefused("INVALID_COMMAND", "install_id missing");

    if (!validTarget(command.version))
      throw new CliRefused("INVALID_VERSION", `"${command.version}" is not a version (X.Y.Z or latest)`);

    if (this.#installing)
      throw new CliRefused(
        "CLI_INSTALL_RUNNING",
        `${cliOf(this.#installing.provider)?.label ?? "Another CLI"} is being installed on this worker; try again when it finishes`,
      );
    const busy = this.#options.busy(command.provider);

    if (busy > 0)
      throw new CliRefused(
        "CLI_TURNS_RUNNING",
        `${spec.label} has ${busy} running turn${busy === 1 ? "" : "s"} on this worker; try again when ${busy === 1 ? "it finishes" : "they finish"}`,
      );
    const before = await this.#discover(spec);
    const plan = planRecipe(before, command.version, this.#tools());

    if (!plan.recipe) {
      const how = plan.manualCommand ? ` Run \`${plan.manualCommand}\` on the machine.` : "";
      throw new CliRefused(
        "CLI_MANAGED_EXTERNALLY",
        `${plan.managedBy ? `Managed by ${plan.managedBy}.` : (plan.detail ?? "No install recipe.")}${how}`,
      );
    }

    // Checked again after the (async) discovery: a turn may have started meanwhile.
    if (this.#installing || this.#options.busy(command.provider) > 0)
      throw new CliRefused("CLI_TURNS_RUNNING", `${spec.label} started a turn; try again when it finishes`);

    const status: StatusInit = {
      installId: command.installId,
      state: "running",
      targetVersion: command.version,
      previousVersion: before.version,
      startedAt: timestampNow(),
    };

    this.#status.set(spec.provider, status);
    const recipe = plan.recipe;

    const done = (async () => {
      const buffer: string[] = [];

      const flush = () => {
        if (buffer.length === 0) return;
        this.#options.progress({ installId: command.installId, provider: spec.provider, lines: buffer.splice(0) });
      };

      const timer = setInterval(flush, 250);

      try {
        this.#options.log(
          `installing ${spec.name} ${command.version} (${CliInstallMethod[before.method]?.toLowerCase()}, was ${before.version || "not installed"})`,
        );

        const outcome = await runInstall({
          before,
          target: command.version,
          recipe,
          tools: this.#tools(),
          workDir: join(this.#options.dataDir, "cli-install"),
          rediscover: () => this.#discover(spec),
          onLines: (lines) => {
            buffer.push(...lines);

            if (buffer.length >= 50) flush();
          },
          ...(this.#options.env && { env: this.#options.env }),
          ...(this.#options.timeoutMs && { timeoutMs: this.#options.timeoutMs }),
        });

        this.#status.set(spec.provider, {
          ...status,
          state: outcome.ok ? "succeeded" : "failed",
          ...(!outcome.ok && { error: outcome.error }),
          finishedAt: timestampNow(),
        });
        this.#options.log(
          `${spec.name} install ${outcome.ok ? `succeeded: ${outcome.after.version}` : `failed: ${outcome.error}`}`,
        );
      } catch (error) {
        this.#status.set(spec.provider, {
          ...status,
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          finishedAt: timestampNow(),
        });
      } finally {
        clearInterval(timer);
        flush();
        this.#installing = undefined;
      }

      await this.#options.installed().catch(() => {});
      await this.report().catch(() => undefined);
    })();

    this.#installing = { provider: spec.provider, done };
    // The running state goes out at once.
    void this.report().catch(() => undefined);
  }
}
