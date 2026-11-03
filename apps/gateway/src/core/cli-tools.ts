import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { CliInstallMethod, CliToolsReportSchema, Provider, ui, type CliInstallProgress, type CliTool, type CliToolsReport } from "@canopy/contracts";
import { compareVersions, secureUrl } from "@canopy/updater";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { WorkerLink } from "../worker-link/index.ts";
import type { CoreRuntime } from "./core.ts";

/**
 * Provider CLIs on the owner's workers (docs/provider-cli.md). Workers report what is installed and how
 * (CliToolsReport, kept in workers.capabilities.cliTools); the gateway learns the latest version of each CLI from its
 * official source, decides what may be offered, and on the owner's click sends InstallCli to the worker. Every rule
 * the UI shows is enforced here too: owner only, online, the worker has a recipe for the install method (never for
 * Homebrew, version managers or a container image), no running turns of that provider, one install at a time.
 */

/** Official sources of the latest version (plain text version, or npm dist-tags JSON). */
export const CLI_LATEST_SOURCES: Readonly<Record<CliKey, string>> = {
  // The native installer's channel pointer (what `claude install latest` installs).
  claude: "https://downloads.claude.ai/claude-code-releases/latest",
  codex: "https://registry.npmjs.org/-/package/@openai/codex/dist-tags",
  // The official installer's stable channel (https://x.ai/cli/install.sh).
  grok: "https://x.ai/cli/stable",
};

type CliKey = "claude" | "codex" | "grok";
const KEYS: readonly [CliKey, Provider][] = [["claude", Provider.CLAUDE], ["codex", Provider.CODEX], ["grok", Provider.GROK]];
const keyOf = (provider: Provider) => KEYS.find(([, p]) => p === provider)?.[0];
const LABELS: Record<CliKey, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok" };

export const CLI_CACHE_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const BODY_LIMIT = 256 * 1024;
const LOG_LINES = 200;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface CliLatestOptions {
  /** Test-only: other source URLs (a local server); never read from the environment. */
  readonly sources?: Partial<Record<CliKey, string>>;
  readonly allowHttpForTests?: boolean;
  readonly cacheMs?: number;
}

interface Latest {
  version: string;
  error: string;
  checkedAt: number;
}

/** Latest versions with a cache; a failed check keeps the previous version and says why. Never blocks a caller. */
export class CliLatestSource {
  readonly #options: CliLatestOptions;
  readonly #latest = new Map<CliKey, Latest>();
  #refreshing: Promise<boolean> | undefined;

  constructor(options: CliLatestOptions = {}) {
    this.#options = options;
  }

  get(provider: Provider): Latest | undefined {
    const key = keyOf(provider);
    return key ? this.#latest.get(key) : undefined;
  }

  stale(): boolean {
    const now = Date.now();
    return KEYS.some(([key]) => (this.#latest.get(key)?.checkedAt ?? 0) + (this.#options.cacheMs ?? CLI_CACHE_MS) < now);
  }

  /** Checks every source (concurrent calls share one check); true when something changed. */
  refresh(): Promise<boolean> {
    this.#refreshing ??= (async () => {
      try {
        const results = await Promise.all(KEYS.map(async ([key]) => [key, await this.#check(key)] as const));
        let changed = false;
        for (const [key, result] of results) {
          const previous = this.#latest.get(key);
          const next: Latest = { version: result.version || previous?.version || "", error: result.error, checkedAt: Date.now() };
          changed ||= previous?.version !== next.version || previous?.error !== next.error;
          this.#latest.set(key, next);
        }
        return changed;
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  async #check(key: CliKey): Promise<{ version: string; error: string }> {
    try {
      const allowHttp = this.#options.allowHttpForTests === true;
      const url = secureUrl(this.#options.sources?.[key] ?? CLI_LATEST_SOURCES[key], allowHttp);
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json, text/plain" } });
      secureUrl(response.url || url.href, allowHttp);
      if (!response.ok) return { version: "", error: `${url.host} answered ${response.status}` };
      const body = await response.text();
      if (body.length > BODY_LIMIT) return { version: "", error: `${url.host} sent an unexpected answer` };
      let version = body.trim().split("\n")[0]?.trim() ?? "";
      if (body.trimStart().startsWith("{")) {
        const tags = JSON.parse(body) as { latest?: unknown };
        version = typeof tags.latest === "string" ? tags.latest : "";
      }
      return SEMVER.test(version) ? { version, error: "" } : { version: "", error: `${url.host} sent no version` };
    } catch (error) {
      return { version: "", error: error instanceof Error && error.name === "TimeoutError" ? "the source did not answer in time" : "the source could not be reached" };
    }
  }
}

const newer = (latest: string, current: string): boolean => {
  try {
    return compareVersions(latest, current) > 0;
  } catch {
    return false;
  }
};

const MANAGED: Partial<Record<CliInstallMethod, string>> = {
  [CliInstallMethod.HOMEBREW]: "Homebrew",
  [CliInstallMethod.MISE]: "mise",
  [CliInstallMethod.ASDF]: "asdf",
  [CliInstallMethod.DOCKER]: "the image",
};

export interface CliToolsOptions {
  readonly runtime: CoreRuntime;
  readonly userId: string;
  readonly link: WorkerLink;
  readonly latest?: CliLatestOptions;
  /** Broadcasts the owner's workers (OverviewUpdate.worker). */
  readonly changed: () => Promise<void>;
  readonly log: (message: string) => void;
}

interface WorkerRow {
  id: string;
  name: string;
  owned: boolean;
  report: CliToolsReport | undefined;
}

export class CliTools {
  readonly latest: CliLatestSource;
  readonly #options: CliToolsOptions;
  /** Redacted progress lines per worker and provider since this gateway started. */
  readonly #logs = new Map<string, string[]>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: CliToolsOptions) {
    this.#options = options;
    this.latest = new CliLatestSource(options.latest);
  }

  /** Checks latest versions now and every 6 hours (the cache age); a change is broadcast. */
  start(): void {
    const run = () => void this.latest.refresh().then((changed) => (changed ? this.#options.changed() : undefined)).catch(() => undefined);
    run();
    this.#timer ??= setInterval(run, this.#options.latest?.cacheMs ?? CLI_CACHE_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #run<A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> {
    return this.#options.runtime.runPromise(effect as Effect.Effect<A, unknown, never>);
  }

  /** A worker's report (CliToolsReport) replaces the previous one. */
  async report(workerId: string, report: CliToolsReport): Promise<void> {
    const json = JSON.stringify(toJson(CliToolsReportSchema, report));
    await this.#run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE workers SET capabilities = capabilities || jsonb_build_object('cliTools', ${json}::jsonb) WHERE id = ${workerId}::uuid`;
    }));
    await this.#options.changed();
  }

  progress(workerId: string, progress: CliInstallProgress): Promise<void> {
    const key = `${workerId}/${progress.provider}`;
    const lines = [...(this.#logs.get(key) ?? []), ...progress.lines].slice(-LOG_LINES);
    this.#logs.set(key, lines);
    return this.#options.changed();
  }

  async #rows(ids: readonly string[]): Promise<Map<string, WorkerRow & { running: Map<string, number> }>> {
    const userId = this.#options.userId;
    if (ids.length === 0) return new Map();
    const [workers, turns] = await this.#run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workers = yield* sql<{ id: string; name: string; owner_user_id: string | null; cli: JsonValue | null }>`
        SELECT id, name, owner_user_id, capabilities->'cliTools' AS cli FROM workers WHERE id = ANY(${ids}::uuid[]) AND archived_at IS NULL`;
      const turns = yield* sql<{ worker_id: string; provider: string; n: number }>`
        SELECT t.worker_id, t.provider, count(*)::int AS n FROM turns u JOIN threads t ON t.id = u.thread_id
         WHERE u.status = 'running' AND t.worker_id = ANY(${ids}::uuid[]) GROUP BY t.worker_id, t.provider`;
      return [workers, turns] as const;
    }));
    return new Map(workers.map((w) => {
      let report: CliToolsReport | undefined;
      try {
        report = w.cli ? fromJson(CliToolsReportSchema, w.cli, { ignoreUnknownFields: true }) : undefined;
      } catch {
        report = undefined;
      }
      const running = new Map(turns.filter((t) => t.worker_id === w.id).map((t) => [t.provider, t.n]));
      return [w.id, { id: w.id, name: w.name, owned: w.owner_user_id === userId, report, running }];
    }));
  }

  /** Worker.cli_tools and Worker.arch for the owner's view. */
  async decorate(workers: ui.Worker[]): Promise<void> {
    const rows = await this.#rows(workers.map((w) => w.id));
    for (const worker of workers) {
      const row = rows.get(worker.id);
      if (!row?.report) continue;
      worker.arch = row.report.arch;
      const connection = this.#options.link.connections.get(worker.id);
      const capable = Boolean(connection?.isOpen && connection.hello.capabilities.includes("cli_install"));
      worker.cliTools = row.report.tools.map((tool) => this.#view(worker, row, tool, capable));
    }
  }

  #view(worker: ui.Worker, row: WorkerRow & { running: Map<string, number> }, tool: CliTool, capable: boolean): ui.WorkerCliTool {
    const key = keyOf(tool.provider);
    const latest = this.latest.get(tool.provider);
    const running = key ? (row.running.get(key) ?? 0) : 0;
    const updateAvailable = Boolean(latest?.version && tool.version && newer(latest.version, tool.version));
    const installed = tool.method !== CliInstallMethod.NOT_INSTALLED;
    const action = !tool.installable || MANAGED[tool.method] || tool.method === CliInstallMethod.OTHER ? "" : !installed ? "install" : updateAvailable ? "update" : "";
    const installing = tool.install?.state === "running";
    const blocked = !action ? ""
      : !row.owned ? "Only the worker's owner can install CLIs"
      : !worker.online ? "The worker is offline"
      : !capable ? "Update this worker to install CLIs from Canopy"
      : installing ? "Installing…"
      : running > 0 ? `Waiting for ${running} running turn${running === 1 ? "" : "s"} to finish`
      : "";
    return create(ui.WorkerCliToolSchema, {
      tool,
      ...(latest && { latest: { provider: tool.provider, version: latest.version, error: latest.error, checkedAt: timestampFromDate(new Date(latest.checkedAt)) } }),
      updateAvailable,
      action,
      blockedReason: blocked,
      managedBy: MANAGED[tool.method] ?? (tool.method === CliInstallMethod.OTHER ? "you" : ""),
      runningTurns: running,
      log: this.#logs.get(`${worker.id}/${tool.provider}`) ?? [],
    });
  }

  /** InstallCli: one worker, or every owned worker where the provider has an update. */
  async install(request: ui.InstallCliRequest): Promise<ui.InstallCliResponse> {
    const key = keyOf(request.provider);
    if (!key) throw new ConnectError("choose Claude Code, Codex or Grok", Code.InvalidArgument);
    const version = request.version || this.latest.get(request.provider)?.version || "latest";
    if (version !== "latest" && !SEMVER.test(version)) throw new ConnectError(`"${version}" is not a version (X.Y.Z or latest)`, Code.InvalidArgument);
    if (!request.allWorkers) {
      if (!request.workerId) throw new ConnectError("choose a worker", Code.InvalidArgument);
      await this.#installOn(request.workerId, request.provider, version, false);
      return create(ui.InstallCliResponseSchema, { started: [request.workerId] });
    }
    const userId = this.#options.userId;
    const owned = await this.#run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ id: string }>`SELECT id FROM workers WHERE owner_user_id = ${userId}::uuid AND archived_at IS NULL AND revoked_at IS NULL ORDER BY name`;
    }));
    const rows = await this.#rows(owned.map((w) => w.id));
    const started: string[] = [];
    const skipped: string[] = [];
    for (const row of rows.values()) {
      const tool = row.report?.tools.find((t) => t.provider === request.provider);
      // "Update all": only where it is installed and behind.
      if (!tool?.version || !newer(version === "latest" ? (this.latest.get(request.provider)?.version ?? "") : version, tool.version)) continue;
      try {
        await this.#installOn(row.id, request.provider, version, true);
        started.push(row.id);
      } catch (error) {
        skipped.push(`${row.name}: ${error instanceof Error ? error.message.replace(/^\[\w+\] /, "") : String(error)}`);
      }
    }
    return create(ui.InstallCliResponseSchema, { started, skipped });
  }

  async #installOn(workerId: string, provider: Provider, version: string, bulk: boolean): Promise<void> {
    const label = LABELS[keyOf(provider)!];
    const row = (await this.#rows([workerId])).get(workerId);
    // Another owner's (or a shared) worker looks like a missing one.
    if (!row?.owned) throw new ConnectError("worker not found", Code.NotFound);
    const connection = this.#options.link.connections.get(workerId);
    if (!connection?.isOpen) throw new ConnectError("the worker is offline", Code.Unavailable);
    if (!connection.hello.capabilities.includes("cli_install")) throw new ConnectError("this worker cannot install CLIs; update it first", Code.FailedPrecondition);
    const tool = row.report?.tools.find((t) => t.provider === provider);
    if (!tool) throw new ConnectError("the worker has not reported its CLIs yet; check for updates and try again", Code.FailedPrecondition);
    // A package manager or an image owns these, whatever a worker claims: never fought from here.
    if (!tool.installable || MANAGED[tool.method] || tool.method === CliInstallMethod.OTHER) {
      const managed = MANAGED[tool.method];
      const how = tool.manualCommand ? ` Run \`${tool.manualCommand}\` on the machine.` : "";
      throw new ConnectError(`${managed ? `${label} is managed by ${managed}.` : (tool.detail || `${label} cannot be installed from Canopy here.`)}${how}`, Code.FailedPrecondition);
    }
    if (tool.install?.state === "running") throw new ConnectError(`${label} is already being installed`, Code.FailedPrecondition);
    const running = row.running.get(keyOf(provider)!) ?? 0;
    if (running > 0) throw new ConnectError(`${label} has ${running} running turn${running === 1 ? "" : "s"} on this worker; try again when ${running === 1 ? "it finishes" : "they finish"}`, Code.FailedPrecondition);
    const installId = Bun.randomUUIDv7();
    this.#logs.delete(`${workerId}/${provider}`);
    const result = await connection.sendCommand({ case: "installCli", value: { provider, version, installId } }, 60_000);
    if (!result.ok) throw new ConnectError(result.errorMessage || result.errorCode || "the install did not start", result.errorCode === "INVALID_VERSION" ? Code.InvalidArgument : Code.FailedPrecondition);
    const userId = this.#options.userId;
    await this.#run(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
        VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'worker.cli.install', 'worker', ${workerId}::uuid,
                ${JSON.stringify({ provider: keyOf(provider), version, from: tool.version, method: CliInstallMethod[tool.method]?.toLowerCase(), bulk })}::jsonb)`;
    }));
    this.#options.log(`worker ${workerId}: installing ${keyOf(provider)} ${version} (was ${tool.version || "not installed"})`);
  }

  /** "Check for updates": latest versions now, and the owner's online workers look at their CLIs again. */
  async check(request: ui.CheckCliUpdatesRequest, workers: readonly ui.Worker[]): Promise<ui.CheckCliUpdatesResponse> {
    const targets = workers.filter((w) => !request.workerId || w.id === request.workerId);
    if (request.workerId && targets.length === 0) throw new ConnectError("worker not found", Code.NotFound);
    const owned = await this.#rows(targets.map((w) => w.id));
    const skipped: string[] = [];
    await Promise.all([
      this.latest.refresh(),
      ...targets.map(async (worker) => {
        if (!owned.get(worker.id)?.owned) return;
        const connection = this.#options.link.connections.get(worker.id);
        if (!connection?.isOpen) return void skipped.push(`${worker.name}: offline`);
        if (!connection.hello.capabilities.includes("cli_install")) return void skipped.push(`${worker.name}: the worker is too old to report its CLIs`);
        const result = await connection.sendCommand({ case: "probeProviders", value: {} }, 60_000).catch((error: unknown) => ({ ok: false, errorMessage: error instanceof Error ? error.message : String(error), errorCode: "" }));
        if (!result.ok) skipped.push(`${worker.name}: ${result.errorMessage || result.errorCode}`);
      }),
    ]);
    await this.#options.changed();
    return create(ui.CheckCliUpdatesResponseSchema, {
      latest: KEYS.map(([key, provider]) => {
        const latest = this.latest.get(provider);
        return { provider, version: latest?.version ?? "", error: latest?.error ?? `${LABELS[key]}: not checked`, ...(latest && { checkedAt: timestampFromDate(new Date(latest.checkedAt)) }) };
      }),
      skipped,
    });
  }
}
