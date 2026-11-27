import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui, update } from "@canopy/contracts";
import { CANOPY_VERSION, releaseChannel } from "@canopy/domain/release/version";
import { UPDATE_PROTOCOL } from "@canopy/domain/release/protocol";
import {
  assertBinaryUpdateForward,
  BinaryReleaseBlocked,
  compareVersions,
  confirmStartup,
  installKind,
  managedInstructions,
  normalizeChannel,
  readUpdateRecord,
  ReleaseSource,
  validChannel,
  whenIdle,
  SUPERVISOR_HANDOVER_EXIT_CODE,
  type InstallKind,
  type ReleaseManifest,
} from "@canopy/updater";
import { GatewayUpdateService } from "./service.ts";
import { GatewayReleaseMirror, UpdateCache } from "./cache.ts";
import { updateBusyState, versionAhead } from "./versions.ts";
import { ReleaseRateLimit } from "@canopy/domain/release/http";
import { workerUpdateSnapshot } from "./worker-snapshot.ts";
import { gatewayUpdateMayBeStaged, stageGatewayRelease } from "./stage.ts";
import { prepareWorkerUpdate, workerCommandOnHello } from "./worker-command.ts";
import type { GatewayUpdatesOptions } from "./options.ts";

export class GatewayUpdates {
  readonly service: GatewayUpdateService;
  readonly source: ReleaseSource;
  readonly version: string;
  readonly kind: InstallKind;
  #channel: string;
  #available: ReleaseManifest | undefined;
  #state = "idle";
  #downloadProgress: number | undefined;
  #targetVersion = "";
  #reason = "";
  #checking: Promise<void> | undefined;
  #checkedAt = "";
  #checkError = "";
  #timer: ReturnType<typeof setInterval> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #stopping = new AbortController();
  #draining = false;
  #control: "starting" | "ready" | "shutting_down" = "starting";
  #commands = new Map<string, Promise<update.UpdateCommand | undefined>>();
  #queuing = new Map<string, Promise<update.UpdateCommand | undefined>>();
  readonly #cache: UpdateCache;
  get draining(): boolean {
    return this.#draining;
  }
  /** Selected runtime directory, including a private temporary fallback after prepare(). */
  get cacheDirectory(): string {
    return this.#cache.directory;
  }
  constructor(readonly options: GatewayUpdatesOptions) {
    this.version = options.version ?? CANOPY_VERSION;
    this.kind = options.kind ?? installKind();
    this.#channel = normalizeChannel(options.channel ?? "stable");
    this.source = new ReleaseSource(options.source);
    this.#cache = new UpdateCache(options.cacheDir, options.log);
    this.#cache.retain(this.version);
    this.service = new GatewayUpdateService({
      version: this.version,
      authenticate: options.authenticate,
      mirror: new GatewayReleaseMirror(this.#cache, this.version, this.source),
      hello: (id, hello) => options.persistence.hello(id, hello).finally(() => options.changed?.()),
      command: (id, hello) => this.#onHello(id, hello),
      report: (id, report) => options.persistence.report(id, report).finally(() => options.changed?.()),
      changed: () => options.changed?.(),
    });
  }
  async start(waitForHandover?: () => Promise<boolean>): Promise<number | undefined> {
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

      if (await waitForHandover?.()) {
        this.options.log?.("supervisor handover: restarting before serving gateway work");

        return SUPERVISOR_HANDOVER_EXIT_CODE;
      }

      const record = await readUpdateRecord(this.options.binaryPath);

      if (record) {
        this.#cache.retain(record.previousVersion);
        this.#cache.retain(record.version);
        this.#setState(record.state);
        this.#reason = record.reason;
        await this.options.recovered?.(
          record.state === "failed" && this.version === record.previousVersion ? "rolled_back" : record.state,
          record.reason,
          record.version,
        );
      }
    }

    await this.#cache.startRetention(this.source.options);
    await this.options.recovered?.(this.#state, this.#reason);

    if (this.#control !== "starting") return undefined;
    this.#control = "ready";

    for (const [id, connection] of this.service.connections) {
      void this.#onHello(id, connection.hello).then((command) => {
        if (command) this.service.push(id, command);
      });
    }

    void this.check();
    this.#timer = setInterval(() => void this.check(), this.options.pollMs ?? 15 * 60_000);

    return undefined;
  }
  beginShutdown(): void {
    if (this.#control === "shutting_down") return;
    this.#control = "shutting_down";
    this.options.changed?.();
  }
  close(): void {
    this.beginShutdown();

    if (this.#timer) clearInterval(this.#timer);
    clearTimeout(this.#retryTimer);
    this.#stopping.abort();
    this.service.close();
    this.#cache.close();
  }
  async handover(): Promise<void> {
    if (this.#control !== "ready" || this.kind !== "binary" || !this.options.restart || updateBusyState(this.#state))
      return;

    const previousState = this.#state,
      previousReason = this.#reason;

    this.#setState("waiting_idle");
    this.#reason = "Waiting for active turns before supervisor handover";

    try {
      await whenIdle({
        idle: () => this.options.idle?.() ?? true,
        drain: (value) => this.#setDraining(value),
        signal: this.#stopping.signal,
        waiting: async () => {
          this.options.log?.("supervisor handover: waiting for active turns to finish");
        },
        apply: async () => {
          this.#setState("restarting");
          this.#reason = "Restarting gateway to finish supervisor handover";
          await this.options.departure?.("restarting");
          await this.options.restart!(SUPERVISOR_HANDOVER_EXIT_CODE);
        },
      });
    } finally {
      this.#setState(previousState);
      this.#reason = previousReason;
    }
  }
  #setState(state: string): void {
    this.#state = state;
    this.#downloadProgress = undefined;
    this.options.changed?.();
  }
  #setDraining(value: boolean): void {
    if (this.#draining === value) return;
    this.#draining = value;
    this.options.drain?.(value);
  }
  check(refresh = false): Promise<void> {
    if (!this.#checking) queueMicrotask(() => this.options.changed?.());

    return (this.#checking ??= (async () => {
      try {
        clearTimeout(this.#retryTimer);
        const manifest = await this.source.resolve(this.#channel, undefined, refresh);
        this.#available = undefined;
        let blocked = "";

        try {
          await assertBinaryUpdateForward(this.source.catalog, this.version, manifest);
        } catch (cause) {
          if (!(cause instanceof BinaryReleaseBlocked)) throw cause;
          blocked = cause.message;
        }

        this.#checkError = "";

        if (!blocked) {
          this.#available = manifest;

          if (versionAhead(manifest.version, this.version))
            this.options.found?.({ channel: this.#channel, version: manifest.version });
        }

        if (!["waiting_idle", "downloading", "restarting", "failed"].includes(this.#state)) this.#reason = blocked;

        for (const [id, connection] of this.service.connections) {
          void this.#onHello(id, connection.hello).then((command) => {
            if (command) this.service.push(id, command);
          });
        }
      } catch (error) {
        if (error instanceof ReleaseRateLimit && !this.#stopping.signal.aborted) {
          this.#retryTimer = setTimeout(() => void this.check(), Math.max(0, error.retryAt - Date.now()));
          this.#retryTimer.unref?.();
        }

        this.#checkError = error instanceof Error ? error.message : "Could not check releases";

        if (!["waiting_idle", "downloading", "restarting", "failed"].includes(this.#state))
          this.#reason = error instanceof Error ? error.message : "Could not check releases";
      } finally {
        this.#checkedAt = new Date().toISOString();
        this.#checking = undefined;
        this.options.changed?.();
      }
    })());
  }
  async snapshot(): Promise<ui.UpdatesSnapshot> {
    const [workers, admin] = await Promise.all([
      this.options.persistence.workers(false),
      this.options.persistence.admin(),
    ]);

    const availableVersion = this.#control === "ready" ? (this.#available?.version ?? "") : "";

    return create(ui.UpdatesSnapshotSchema, {
      gatewayVersion: this.version,
      channel: this.#channel,
      availableVersion,
      gatewayUpdateAvailable: versionAhead(availableVersion, this.version),
      gatewayInstallKind: this.kind,
      gatewayState: this.#control === "ready" ? this.#state : this.#control,
      gatewayTargetVersion: this.#targetVersion,
      gatewayDownloadProgress: this.#control === "ready" ? this.#downloadProgress : undefined,
      gatewayReason: [
        this.kind !== "binary" ? managedInstructions(this.kind) : "",
        this.#reason,
        this.options.notice?.(),
      ]
        .filter(Boolean)
        .join(" "),
      admin,
      checking: !!this.#checking,
      checkedAt: this.#checkedAt,
      checkError: this.#checkError,
      gatewayBundled: !!this.options.bundled,
      workers: workers.map((w) =>
        workerUpdateSnapshot(w, this.version, !!this.options.bundled, this.service.connections.has(w.id)),
      ),
    });
  }
  async manage(request: ui.ManageUpdatesRequest): Promise<ui.UpdatesSnapshot> {
    if (!(await this.options.persistence.admin()))
      throw new ConnectError("Only an administrator can manage updates", Code.PermissionDenied);
    this.assertControlReady();

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
      await this.check(true);
    } else if (request.action === "check") await this.check(true);
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
      this.#targetVersion = manifest.version;
      this.#reason = "Waiting for active turns to finish";
      this.#setDraining(true);
      this.#setState("waiting_idle");

      try {
        await this.options.departure?.("updating", manifest.version);
      } catch (cause) {
        this.#setDraining(false);
        this.#gatewayUpdateFailed(cause);
        throw cause;
      }

      const release = this.#cache.retain(manifest.version);
      void this.#updateGateway(manifest, request, release).catch((cause: unknown) => this.#gatewayUpdateFailed(cause));
    } else if (request.action === "worker" || request.action === "all") {
      const workers = await this.options.persistence.workers();
      const selected = request.action === "all" ? workers : workers.filter((w) => w.id === request.workerId);

      if (!selected.length && request.action === "worker") throw new ConnectError("Worker not found", Code.NotFound);

      for (const worker of selected) {
        if (
          request.action === "all" &&
          (worker.version === this.version ||
            worker.status.installKind !== "binary" ||
            versionAhead(worker.version, this.version))
        )
          continue;

        try {
          const command = await this.#queue(worker.id, request.force, request.allowDowngrade);

          if (command) this.service.push(worker.id, command);
        } catch (error) {
          if (!(error instanceof BinaryReleaseBlocked)) throw error;

          if (request.action === "worker") throw new ConnectError(error.message, Code.FailedPrecondition);
        }
      }
    } else throw new ConnectError("Unknown update action", Code.InvalidArgument);

    return this.snapshot();
  }
  get controlReady(): boolean {
    return this.#control === "ready";
  }
  assertControlReady(): void {
    if (this.#control !== "ready")
      throw new ConnectError(
        this.#control === "starting" ? "Gateway update control is starting" : "Gateway update control is shutting down",
        Code.Unavailable,
      );
  }
  #gatewayUpdateFailed(cause: unknown): void {
    this.#targetVersion = "";
    this.#reason = cause instanceof Error ? cause.message : "Gateway update failed";
    this.#setState("failed");
    void this.options.recovered?.("failed", this.#reason).catch(() => {
      this.options.log?.("Could not save the gateway update outcome");
    });
  }

  async #updateGateway(
    manifest: ReleaseManifest,
    request: ui.ManageUpdatesRequest,
    release: () => void,
  ): Promise<void> {
    let staged = false;

    try {
      await whenIdle({
        idle: () => this.options.idle?.() ?? true,
        drain: (value) => this.#setDraining(value),
        force: request.force,
        signal: this.#stopping.signal,
        waiting: async () => {
          this.options.log?.("gateway update: waiting for active turns to finish");
        },
        apply: async () => {
          if (this.options.relocating?.()) throw new Error("Gateway maintenance is in progress");
          this.#setState("downloading");
          this.#reason = "Downloading and verifying the gateway release";
          await stageGatewayRelease({
            cache: this.#cache,
            manifest,
            source: this.source,
            workers: await this.options.persistence.workers(),
            binaryPath: this.options.binaryPath ?? process.execPath,
            currentVersion: this.version,
            allowDowngrade: request.allowDowngrade,
            onDownloadProgress: (percent) => {
              this.#downloadProgress = percent;
              this.options.changed?.();
            },
          });
          staged = true;
          this.#setState("restarting");
          this.#reason = "Restarting gateway; this page will reconnect";
          await this.options.departure?.("restarting", manifest.version);
          await Bun.sleep(500);
          await this.options.restart!();
        },
      });
    } finally {
      if (!staged && !(await gatewayUpdateMayBeStaged(this.options.binaryPath ?? process.execPath, manifest.version)))
        release();
    }
  }
  #onHello(workerId: string, hello: update.CheckRequest): Promise<update.UpdateCommand | undefined> {
    if (this.#control !== "ready" || this.options.relocating?.()) return Promise.resolve(undefined);

    if (this.#commands.has(workerId)) return this.#commands.get(workerId)!;

    const promise = workerCommandOnHello(this.options.persistence, this.service.options.mirror, hello, () =>
      this.#queue(workerId, false, false),
    )
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
  #queue(workerId: string, force: boolean, allowDowngrade: boolean): Promise<update.UpdateCommand | undefined> {
    const pending = this.#queuing.get(workerId);

    if (pending) return pending;

    const { mirror } = this.service.options;

    const command = prepareWorkerUpdate(this.options.persistence, mirror, workerId, force, allowDowngrade).finally(() =>
      this.#queuing.delete(workerId),
    );

    this.#queuing.set(workerId, command);

    return command;
  }
}
