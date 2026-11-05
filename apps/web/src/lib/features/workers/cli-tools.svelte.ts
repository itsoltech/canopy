import { create } from "@bufbuild/protobuf";
import { CliInstallMethod, Provider, ui, type CliTool } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

/** Provider CLIs on workers (docs/provider-cli.md). The live state arrives with the workers (Worker.cli_tools). */

export const cliLabel = (provider: Provider): string =>
  provider === Provider.CLAUDE
    ? "Claude Code"
    : provider === Provider.CODEX
      ? "Codex"
      : provider === Provider.GROK
        ? "Grok"
        : "Agent CLI";

const METHOD_LABELS = new Map([
  [CliInstallMethod.NATIVE, "Native installer"],
  [CliInstallMethod.NPM, "npm global"],
  [CliInstallMethod.BUN, "Bun global"],
  [CliInstallMethod.VOLTA, "Volta"],
  [CliInstallMethod.PNPM, "pnpm global"],
  [CliInstallMethod.YARN, "Yarn global"],
  [CliInstallMethod.HOMEBREW, "Homebrew"],
  [CliInstallMethod.MISE, "mise"],
  [CliInstallMethod.ASDF, "asdf"],
  [CliInstallMethod.DOCKER, "Container image"],
  [CliInstallMethod.OTHER, "Other install"],
  [CliInstallMethod.NOT_INSTALLED, "Not installed"],
]);

export const methodLabel = (method: CliInstallMethod): string => METHOD_LABELS.get(method) ?? "Unknown";

const fileName = (path: string): string => path.split(/[\\/]/).at(-1) || path;

/** Why the worker can't tell the version: `<file> --version` failed (empty when it ran). */
export const versionProblem = (tool: CliTool): string =>
  tool.versionError ? `Couldn't run ${fileName(tool.path)} --version: ${tool.versionError}` : "";

/** Workers that can update a provider now, and the version they would get. */
export function providerUpdates(
  workers: readonly ui.Worker[],
): { provider: Provider; version: string; workers: ui.Worker[] }[] {
  const out = new Map<Provider, { provider: Provider; version: string; workers: ui.Worker[] }>();

  for (const worker of workers) {
    for (const tool of worker.cliTools) {
      if (!tool.tool || tool.action !== "update" || tool.tool.install?.state === "running") continue;

      const entry = out.get(tool.tool.provider) ?? {
        provider: tool.tool.provider,
        version: tool.latest?.version ?? "",
        workers: [],
      };

      entry.workers.push(worker);
      out.set(tool.tool.provider, entry);
    }
  }

  return [...out.values()].sort((a, b) => a.provider - b.provider);
}

/** Worker and gateway messages start lower case (they are joined into sentences there). */
export const sentence = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

export const hasCliUpdates = (workers: readonly ui.Worker[]): boolean =>
  workers.some((w) => w.cliTools.some((t) => t.action === "update"));

/** Clicks in flight and their errors, by key (`<workerId>/<provider>`, `all/<provider>`, `check/<workerId>`). */
export class CliActions {
  pending = $state<Record<string, boolean>>({});
  errors = $state<Record<string, string>>({});
  notes = $state<Record<string, string>>({});

  async #run(key: string, action: () => Promise<string | void>): Promise<void> {
    if (this.pending[key]) return;
    this.pending[key] = true;
    delete this.errors[key];
    delete this.notes[key];

    try {
      const note = await action();

      if (note) this.notes[key] = note;
    } catch (error) {
      this.errors[key] = error instanceof Error ? error.message : "Something went wrong";
    } finally {
      delete this.pending[key];
    }
  }

  install(workerId: string, provider: Provider): Promise<void> {
    return this.#run(`${workerId}/${provider}`, async () => {
      await requestJson(
        "POST",
        "/api/workers/cli/install",
        encode(ui.InstallCliRequestSchema, create(ui.InstallCliRequestSchema, { workerId, provider })),
        75_000,
      );
    });
  }

  updateAll(provider: Provider): Promise<void> {
    return this.#run(`all/${provider}`, async () => {
      const response = decode(
        ui.InstallCliResponseSchema,
        await requestJson(
          "POST",
          "/api/workers/cli/install",
          encode(ui.InstallCliRequestSchema, create(ui.InstallCliRequestSchema, { provider, allWorkers: true })),
          75_000,
        ),
      );

      if (response.skipped.length > 0) return `Skipped ${response.skipped.join("; ")}`;
    });
  }

  check(workerId = ""): Promise<void> {
    return this.#run(`check/${workerId}`, async () => {
      const response = decode(
        ui.CheckCliUpdatesResponseSchema,
        await requestJson(
          "POST",
          "/api/workers/cli/check",
          encode(ui.CheckCliUpdatesRequestSchema, create(ui.CheckCliUpdatesRequestSchema, { workerId })),
          75_000,
        ),
      );

      if (response.skipped.length > 0) return response.skipped.join("; ");
    });
  }
}

/** One instance per page: rows and the summary share pending state. */
let shared: CliActions | undefined;
export const cliActions = (): CliActions => (shared ??= new CliActions());
