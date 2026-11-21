import { createClient } from "@connectrpc/connect";
import { update } from "@canopy/contracts";
import { MIN_WORKER_LINK_PROTOCOL, UPDATE_PROTOCOL, WORKER_LINK_PROTOCOL } from "@canopy/domain/release/protocol";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { createGrpcClientTransport } from "@canopy/transport";
import {
  assertBinaryUpdateForward,
  clearUpdateResult,
  compareVersions,
  installKind,
  managedInstructions,
  parseManifest,
  readUpdateRecord,
  releaseAsset,
  ReleaseSource,
  stageBinaryUpdate,
  SUPERVISOR_HANDOVER_EXIT_CODE,
  whenIdle,
  type InstallKind,
  type ReleaseSourceOptions,
} from "@canopy/updater";

export interface WorkerUpdatesOptions {
  baseUrl: string;
  credential: string;
  workerId: string;
  ca?: string | Buffer;
  fingerprint?: string;
  idle(): boolean | Promise<boolean>;
  drain(value: boolean): void;
  restart(exitCode?: number): Promise<void>;
  signal: AbortSignal;
  deferStartupReport?: boolean;
  log?(message: string): void;
  kind?: InstallKind;
  version?: string;
  binaryPath?: string;
  source?: ReleaseSourceOptions;
}

/** Independent transport/reconnect loop: it never awaits WorkerLink or provider configuration. */
export class WorkerUpdates {
  #client;
  #route = new AbortController();
  readonly #headers;
  readonly #version: string;
  readonly #kind: InstallKind;
  readonly #source: ReleaseSource;
  #startupPending: boolean;
  #active: string | undefined;
  #handled = new Set<string>();
  // An interrupted update can finish after Watch has already reconnected.
  #failedReport: { command: update.UpdateCommand; reason: string } | undefined;
  constructor(readonly options: WorkerUpdatesOptions) {
    this.#version = options.version ?? CANOPY_VERSION;
    this.#kind = options.kind ?? installKind();
    this.#source = new ReleaseSource(options.source);
    this.#startupPending = options.deferStartupReport ?? false;
    this.#headers = { authorization: `Bearer ${options.credential}` };
    this.#client = createClient(
      update.UpdateService,
      createGrpcClientTransport({
        baseUrl: options.baseUrl,
        ...(options.fingerprint && { fingerprint: options.fingerprint }),
        ...(options.ca && { ca: options.ca }),
        pingIntervalMs: 15_000,
        connectTimeoutMs: 5_000,
      }),
    );
  }
  /** Interrupt only the old Watch. Release negotiation remains independent of WorkerLink. */
  setEndpoint(endpoint: { baseUrl: string; ca?: string | Buffer; fingerprint?: string }) {
    this.#client = createClient(
      update.UpdateService,
      createGrpcClientTransport({
        ...endpoint,
        pingIntervalMs: 15_000,
        connectTimeoutMs: 5000,
      }),
    );
    this.#reconnect();
  }
  startupReady(): void {
    this.#startupPending = false;
    this.#reconnect();
  }
  #reconnect(): void {
    this.#route.abort();
    this.#route = new AbortController();
  }
  async run(): Promise<void> {
    let backoffMs = 1_000;

    while (!this.options.signal.aborted) {
      const route = this.#route;

      try {
        // Report persisted success/rollback before Watch can redeliver or auto-enqueue another command.
        await this.#reportResults();

        for await (const event of this.#client.watch(
          {
            workerId: this.options.workerId,
            version: this.#version,
            minWorkerLinkProtocol: MIN_WORKER_LINK_PROTOCOL,
            workerLinkProtocol: WORKER_LINK_PROTOCOL,
            os: process.platform === "win32" ? "windows" : process.platform,
            arch: process.arch,
            installKind: this.#kind,
          },
          { headers: this.#headers, signal: AbortSignal.any([this.options.signal, route.signal]) },
        )) {
          backoffMs = 1_000;
          await this.#reportResults();

          if (event.gateway?.compatibility === "update_required")
            this.options.log?.(`update channel: ${event.gateway.reason}`);

          if (event.command)
            void this.apply(event.command).catch((cause: unknown) =>
              this.options.log?.(`update failed: ${cause instanceof Error ? cause.message : "unknown error"}`),
            );
        }
      } catch (error) {
        if (!this.options.signal.aborted && !route.signal.aborted)
          this.options.log?.(
            `update channel unavailable: ${error instanceof Error ? error.message : "connection failed"}`,
          );
      }

      if (this.options.signal.aborted) return;

      if (route.signal.aborted) continue;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.options.signal.removeEventListener("abort", done);
          resolve();
        };

        const timer = setTimeout(done, backoffMs);
        this.options.signal.addEventListener("abort", done, { once: true });
      });
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  }
  async #report(command: update.UpdateCommand, state: string, reason = ""): Promise<void> {
    await this.#client.report(
      {
        workerId: this.options.workerId,
        commandId: command.id,
        version: command.version,
        state,
        reason: reason.slice(0, 2000),
      },
      { headers: this.#headers, signal: this.options.signal, timeoutMs: 10_000 },
    );
  }
  async #reportResults(): Promise<void> {
    if (this.#failedReport) {
      const { command, reason } = this.#failedReport;
      await this.#report(command, "failed", reason);
      this.#failedReport = undefined;
    }

    if (this.#kind !== "binary") return;
    const record = await readUpdateRecord(this.options.binaryPath);

    if (!record || record.state === "restarting" || (this.#startupPending && record.state === "succeeded")) return;
    await this.#client.report(
      {
        workerId: this.options.workerId,
        commandId: record.commandId,
        version: record.version,
        state: record.state,
        reason: record.reason,
      },
      { headers: this.#headers, signal: this.options.signal, timeoutMs: 10_000 },
    );
    await clearUpdateResult(this.options.binaryPath);
  }
  async handover(): Promise<void> {
    if (this.#kind !== "binary" || this.#active || this.options.signal.aborted) return;
    this.#active = "supervisor-handover";

    try {
      await whenIdle({
        idle: this.options.idle,
        drain: this.options.drain,
        signal: this.options.signal,
        waiting: async () => {
          this.options.log?.("supervisor handover: waiting for active turns and background work to finish");
        },
        apply: () => this.options.restart(SUPERVISOR_HANDOVER_EXIT_CODE),
      });
    } finally {
      this.#active = undefined;
    }
  }
  async apply(command: update.UpdateCommand): Promise<void> {
    if (
      !command.id ||
      this.#handled.has(command.id) ||
      this.#active ||
      (this.#startupPending && command.version === this.#version)
    )
      return;
    this.#active = command.id;

    try {
      if (this.#kind !== "binary" || process.platform === "win32") {
        await this.#report(
          command,
          "managed_externally",
          process.platform === "win32" && this.#kind === "binary"
            ? "Windows updates require an external service installer."
            : managedInstructions(this.#kind),
        );

        return;
      }

      const manifest = parseManifest(JSON.parse(command.manifestJson), this.#source.options);

      if (manifest.version !== command.version || manifest.protocol.update !== UPDATE_PROTOCOL)
        throw new Error("Update command does not match the supported release manifest");

      if (compareVersions(command.version, this.#version) === 0) {
        await this.#report(command, "succeeded");

        return;
      }

      if (compareVersions(command.version, this.#version) < 0 && !command.allowDowngrade)
        throw new Error("Downgrade requires an explicit user request");
      await assertBinaryUpdateForward(this.#source.catalog, this.#version, manifest);
      const asset = releaseAsset(manifest, "worker", process.platform, process.arch);
      await whenIdle({
        idle: this.options.idle,
        drain: this.options.drain,
        force: command.force,
        maxWaitMs: Math.min(command.maxIdleWaitSeconds || 1800, 24 * 3600) * 1000,
        signal: this.options.signal,
        waiting: () =>
          this.#report(
            command,
            "waiting_idle",
            "Waiting for active turns and background work to finish; new turns are paused",
          ),
        apply: async () => {
          await this.#report(command, "downloading");

          const client = this.#client,
            options = this.options,
            headers = this.#headers;

          const chunks = command.preferGatewayMirror
            ? (async function* () {
                for await (const chunk of client.fetchArtifact(
                  { workerId: options.workerId, version: command.version, os: asset.os, arch: asset.arch },
                  { headers, signal: options.signal },
                ))
                  yield chunk.data;
              })()
            : undefined;

          await stageBinaryUpdate({
            binaryPath: this.options.binaryPath ?? process.execPath,
            currentVersion: this.#version,
            version: manifest.version,
            commit: manifest.commit,
            commandId: command.id,
            asset,
            ...(chunks && { chunks }),
            source: this.#source,
            allowDowngrade: command.allowDowngrade,
          });
          // Once replacement is committed, lost connectivity must not leave the old process running forever.
          await this.#report(command, "restarting").catch(() => {});
          await this.options.restart();
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Update failed";
      await this.#report(command, "failed", reason).catch(() => {
        this.#failedReport = { command, reason };
      });
      throw error;
    } finally {
      this.#active = undefined;
      this.#handled.add(command.id);

      if (this.#handled.size > 256) this.#handled.delete(this.#handled.values().next().value!);
    }
  }
}
