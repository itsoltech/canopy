import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui, update } from "@canopy/contracts";
import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
import { UPDATE_PROTOCOL, workerLinkCompatible } from "@canopy/domain/release/protocol";
import {
  compareVersions,
  confirmStartup,
  installKind,
  managedInstructions,
  normalizeChannel,
  readUpdateRecord,
  ReleaseSource,
  releaseAsset,
  stageBinaryUpdate,
  validChannel,
  whenIdle,
  SUPERVISOR_HANDOVER_EXIT_CODE,
  type InstallKind,
  type ReleaseManifest,
  type ReleaseSourceOptions,
} from "@canopy/updater";
import type { UpdatePersistence, WorkerUpdateRow } from "./persistence.ts";
import { GatewayUpdateService } from "./service.ts";
import { GatewayReleaseMirror, UpdateCache } from "./cache.ts";

export interface GatewayUpdatesOptions {
  persistence: Pick<
    UpdatePersistence,
    "admin" | "channel" | "setChannel" | "workers" | "hello" | "saveCommand" | "report"
  >;
  authenticate(credential: string): Promise<string | undefined>;
  cacheDir?: string;
  source?: ReleaseSourceOptions;
  channel?: string;
  version?: string;
  kind?: InstallKind;
  /** The desktop app's bundled gateway (desktop role): it and its own worker update with the app. */
  bundled?: boolean;
  binaryPath?: string;
  restart?(exitCode?: number): Promise<void>;
  idle?(): Promise<boolean>;
  drain?(value: boolean): void;
  log?(message: string): void;
  pollMs?: number;
}

const updateBusyState = (state: string | undefined) =>
  ["queued", "waiting_idle", "downloading", "restarting"].includes(state ?? "");

export class GatewayUpdates {
  readonly service: GatewayUpdateService;
  readonly source: ReleaseSource;
  readonly version: string;
  readonly kind: InstallKind;
  #channel: string;
  #available: ReleaseManifest | undefined;
  #state = "idle";
  #reason = "";
  #checking: Promise<void> | undefined;
  #checkedAt = "";
  #checkError = "";
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopping = new AbortController();
  #draining = false;
  #ready = false;
  #commands = new Map<string, Promise<update.UpdateCommand | undefined>>();
  readonly #cache: UpdateCache;
  get draining(): boolean {
    return this.#draining;
  }
  constructor(readonly options: GatewayUpdatesOptions) {
    this.version = options.version ?? CANOPY_VERSION;
    this.kind = options.kind ?? installKind();
    this.#channel = normalizeChannel(options.channel ?? "stable");
    this.source = new ReleaseSource(options.source);
    this.#cache = new UpdateCache(options.cacheDir, options.log);
    this.service = new GatewayUpdateService({
      version: this.version,
      authenticate: options.authenticate,
      mirror: new GatewayReleaseMirror(this.#cache, this.version, this.source),
      hello: (id, hello) => options.persistence.hello(id, hello),
      command: (id, hello) => this.#onHello(id, hello),
      report: (id, report) => options.persistence.report(id, report),
    });
  }
  async start(): Promise<void> {
    // A bundled gateway reports its build's channel; the app's own setting chooses the next release.
    const build = releaseChannel(this.version);
    const stored = this.options.bundled ? undefined : await this.options.persistence.channel();
    this.#channel = normalizeChannel(
      stored ?? (this.options.bundled && build !== "development" ? build : this.#channel),
    );

    if (!validChannel(this.#channel)) throw new Error("Invalid update channel");

    if (stored === "latest") await this.options.persistence.setChannel(this.#channel);

    if (this.kind === "binary") {
      // main calls start only after the DB and listeners are ready. Do not converge workers before this checkpoint.
      await confirmStartup(this.options.binaryPath, this.version);
      const record = await readUpdateRecord(this.options.binaryPath);

      if (record) {
        this.#state = record.state;
        this.#reason = record.reason;
      }
    }

    this.#ready = true;

    for (const [id, connection] of this.service.connections) {
      void this.#onHello(id, connection.hello).then((command) => {
        if (command) this.service.push(id, command);
      });
    }

    void this.check();
    this.#timer = setInterval(() => void this.check(), this.options.pollMs ?? 15 * 60_000);
  }
  close(): void {
    this.#ready = false;

    if (this.#timer) clearInterval(this.#timer);
    this.#stopping.abort();
    this.service.close();
    this.#cache.close();
  }
  async handover(): Promise<void> {
    if (!this.#ready || this.kind !== "binary" || !this.options.restart || updateBusyState(this.#state)) return;

    const previousState = this.#state,
      previousReason = this.#reason;

    this.#state = "waiting_idle";
    this.#reason = "Waiting for active turns before supervisor handover";

    try {
      await whenIdle({
        idle: () => this.options.idle?.() ?? true,
        drain: (value) => {
          this.#draining = value;
          this.options.drain?.(value);
        },
        signal: this.#stopping.signal,
        waiting: async () => {
          this.options.log?.("supervisor handover: waiting for active turns to finish");
        },
        apply: () => this.options.restart!(SUPERVISOR_HANDOVER_EXIT_CODE),
      });
    } finally {
      this.#state = previousState;
      this.#reason = previousReason;
    }
  }
  check(): Promise<void> {
    return (this.#checking ??= (async () => {
      try {
        this.#available = await this.source.resolve(this.#channel);
        this.#checkError = "";

        if (!["waiting_idle", "downloading", "restarting", "failed"].includes(this.#state)) this.#reason = "";

        for (const [id, connection] of this.service.connections) {
          void this.#onHello(id, connection.hello).then((command) => {
            if (command) this.service.push(id, command);
          });
        }
      } catch (error) {
        this.#checkError = error instanceof Error ? error.message : "Could not check releases";

        if (!["waiting_idle", "downloading", "restarting", "failed"].includes(this.#state))
          this.#reason = error instanceof Error ? error.message : "Could not check releases";
      } finally {
        this.#checkedAt = new Date().toISOString();
        this.#checking = undefined;
      }
    })());
  }
  /** A worker version above the gateway's (unknown or unparsable versions are not "ahead"). */
  #ahead(version: string): boolean {
    try {
      return !!version && compareVersions(version, this.version) > 0;
    } catch {
      return false;
    }
  }
  async snapshot(): Promise<ui.UpdatesSnapshot> {
    const workers = await this.options.persistence.workers();

    return create(ui.UpdatesSnapshotSchema, {
      gatewayVersion: this.version,
      channel: this.#channel,
      availableVersion: this.#available?.version ?? "",
      gatewayUpdateAvailable: this.#ahead(this.#available?.version ?? ""),
      gatewayInstallKind: this.kind,
      gatewayState: this.#state,
      gatewayReason: [this.kind !== "binary" ? managedInstructions(this.kind) : "", this.#reason]
        .filter(Boolean)
        .join(" "),
      admin: await this.options.persistence.admin(),
      checking: !!this.#checking,
      checkedAt: this.#checkedAt,
      checkError: this.#checkError,
      gatewayBundled: !!this.options.bundled,
      workers: workers.map((w) => ({
        workerId: w.id,
        name: w.name,
        bundled: !!this.options.bundled && w.bundled === true,
        version: w.version,
        installKind: w.status.installKind ?? "unknown",
        compatibility: workerLinkCompatible(w.status.minWorkerLinkProtocol ?? 0, w.status.workerLinkProtocol ?? 0)
          ? "compatible"
          : "update_required",
        ...(this.#ahead(w.version) && !updateBusyState(w.status.state)
          ? {
              // Newer than this gateway (e.g. a desktop app on a newer channel): nothing to do here; never a downgrade.
              state: "ahead",
              reason: `Newer than this gateway. Update the gateway to ${w.version} or later.`,
            }
          : {
              state:
                w.status.state === "succeeded" && w.version !== this.version
                  ? "idle"
                  : (w.status.state ??
                    (w.status.installKind && w.status.installKind !== "binary" ? "managed_externally" : "idle")),
              reason:
                w.status.reason ??
                (w.status.installKind && w.status.installKind !== "binary"
                  ? managedInstructions(w.status.installKind)
                  : !w.status.installKind
                    ? "This worker has not reported to the update channel. Older installations need one manual upgrade."
                    : ""),
            }),
        connected: this.service.connections.has(w.id),
      })),
    });
  }
  async manage(request: ui.ManageUpdatesRequest): Promise<ui.UpdatesSnapshot> {
    if (!(await this.options.persistence.admin()))
      throw new ConnectError("Only an administrator can manage updates", Code.PermissionDenied);

    if (!this.#ready) throw new ConnectError("Gateway update control is starting or shutting down", Code.Unavailable);

    if (request.action === "channel") {
      if (this.options.bundled)
        throw new ConnectError(
          "This gateway updates with the Canopy app. Change the channel in Settings → App updates.",
          Code.FailedPrecondition,
        );
      const channel = normalizeChannel(request.channel);

      if (!validChannel(channel))
        throw new ConnectError("Use stable, beta, nightly, vX, vX.Y or vX.Y.Z", Code.InvalidArgument);

      if (["waiting_idle", "downloading", "restarting"].includes(this.#state))
        throw new ConnectError("Gateway update already in progress", Code.FailedPrecondition);
      await this.#checking;
      await this.options.persistence.setChannel(channel);
      this.#channel = channel;
      this.#available = undefined;
      await this.check();
    } else if (request.action === "check") await this.check();
    else if (request.action === "gateway") {
      if (this.kind !== "binary") throw new ConnectError(managedInstructions(this.kind), Code.FailedPrecondition);

      if (!this.options.restart)
        throw new ConnectError("Binary restart supervisor is unavailable", Code.FailedPrecondition);

      if (["waiting_idle", "downloading", "restarting"].includes(this.#state))
        throw new ConnectError("Gateway update already in progress", Code.FailedPrecondition);
      const manifest = this.#available;

      if (!manifest || compareVersions(manifest.version, this.version) === 0)
        throw new ConnectError("Check for a different release first", Code.FailedPrecondition);

      if (compareVersions(manifest.version, this.version) < 0 && !request.allowDowngrade)
        throw new ConnectError("Downgrade requires an explicit user request", Code.FailedPrecondition);

      if (manifest.protocol.update !== UPDATE_PROTOCOL)
        throw new ConnectError("Release does not support the frozen update protocol", Code.FailedPrecondition);
      this.#state = "waiting_idle";
      this.#reason = "Waiting for active turns to finish";
      void this.#updateGateway(manifest, request).catch((cause: unknown) => {
        this.#state = "failed";
        this.#reason = cause instanceof Error ? cause.message : "Gateway update failed";
      });
    } else if (request.action === "worker" || request.action === "all") {
      const workers = await this.options.persistence.workers();
      const selected = request.action === "all" ? workers : workers.filter((w) => w.id === request.workerId);

      if (!selected.length && request.action === "worker") throw new ConnectError("Worker not found", Code.NotFound);

      for (const worker of selected) {
        if (
          request.action === "all" &&
          (worker.version === this.version || worker.status.installKind !== "binary" || this.#ahead(worker.version))
        )
          continue;
        const command = await this.#queue(worker, request.force, request.allowDowngrade);

        if (command) this.service.push(worker.id, command);
      }
    } else throw new ConnectError("Unknown update action", Code.InvalidArgument);

    return this.snapshot();
  }
  async #updateGateway(manifest: ReleaseManifest, request: ui.ManageUpdatesRequest): Promise<void> {
    await whenIdle({
      idle: () => this.options.idle?.() ?? true,
      drain: (value) => {
        this.#draining = value;
        this.options.drain?.(value);
      },
      force: request.force,
      signal: this.#stopping.signal,
      waiting: async () => {},
      apply: async () => {
        this.#state = "downloading";
        this.#reason = "Downloading and verifying the gateway release";
        const mirror = new GatewayReleaseMirror(this.#cache, manifest.version, this.source);
        await mirror.remember(manifest);

        // Retain artifacts for known private workers before nightly assets can expire.
        const platforms = new Map(
          (await this.options.persistence.workers())
            .filter((w) => w.status.installKind === "binary")
            .map((w) => [`${w.os}/${w.arch}`, w]),
        );

        for (const worker of platforms.values()) {
          if (manifest.assets.some((a) => a.app === "worker" && a.os === worker.os && a.arch === worker.arch))
            await mirror.artifact(worker.os, worker.arch);
        }

        await stageBinaryUpdate({
          binaryPath: this.options.binaryPath ?? process.execPath,
          currentVersion: this.version,
          version: manifest.version,
          commandId: crypto.randomUUID(),
          asset: releaseAsset(
            manifest,
            "gateway",
            process.platform === "win32" ? "windows" : process.platform,
            process.arch,
          ),
          source: this.source.options,
          allowDowngrade: request.allowDowngrade,
        });
        this.#state = "restarting";
        this.#reason = "Restarting gateway; this page will reconnect";
        await Bun.sleep(500);
        await this.options.restart!();
      },
    });
  }
  #onHello(workerId: string, hello: update.CheckRequest): Promise<update.UpdateCommand | undefined> {
    if (!this.#ready) return Promise.resolve(undefined);

    if (this.#commands.has(workerId)) return this.#commands.get(workerId)!;

    const promise = (async () => {
      const worker = (await this.options.persistence.workers()).find((w) => w.id === workerId);

      if (!worker) return undefined;

      if (
        worker.command?.version === this.version &&
        !["failed", "succeeded", "managed_externally"].includes(worker.status.state ?? "") &&
        worker.command.version !== hello.version
      )
        return worker.command;

      // No automatic downgrade or repeated failed-update loop, including after rollback.
      if (hello.installKind !== "binary" || worker.status.state === "failed" || hello.version === this.version)
        return undefined;

      try {
        if (compareVersions(hello.version, this.version) >= 0) return undefined;
      } catch {
        return undefined;
      }

      return this.#queue(worker, false, false);
    })()
      .catch((cause: unknown) => {
        this.options.log?.(
          `worker update unavailable: ${cause instanceof Error ? cause.message : "release resolution failed"}`,
        );

        return undefined;
      })
      .finally(() => this.#commands.delete(workerId));

    this.#commands.set(workerId, promise);

    return promise;
  }
  async #queue(
    worker: WorkerUpdateRow,
    force: boolean,
    allowDowngrade: boolean,
  ): Promise<update.UpdateCommand | undefined> {
    if (worker.version === this.version) return undefined;

    if (worker.status.installKind !== "binary")
      throw new ConnectError(managedInstructions(worker.status.installKind ?? "source"), Code.FailedPrecondition);

    if (compareVersions(this.version, worker.version) < 0 && !allowDowngrade)
      throw new ConnectError("Worker downgrade requires an explicit user request", Code.FailedPrecondition);

    if (
      worker.command &&
      worker.command.version === this.version &&
      !["failed", "succeeded", "managed_externally"].includes(worker.status.state ?? "")
    )
      return worker.command;
    const manifest = await this.service.options.mirror.manifest();

    if (!workerLinkCompatible(manifest.protocol.worker_link, manifest.protocol.worker_link))
      throw new ConnectError("Worker release is incompatible with this gateway protocol", Code.FailedPrecondition);
    releaseAsset(manifest, "worker", worker.os, worker.arch);

    const command = create(update.UpdateCommandSchema, {
      id: crypto.randomUUID(),
      version: this.version,
      manifestJson: JSON.stringify(manifest),
      force,
      allowDowngrade,
      maxIdleWaitSeconds: 30 * 60,
      preferGatewayMirror: true,
    });

    await this.options.persistence.saveCommand(worker.id, command);

    return command;
  }
}
