import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { LocalBffTarget } from "@canopy/domain/bff-target";
import { sameDesktopConfiguration, type DesktopConfiguration, type DesktopStatus } from "@canopy/ui/desktop";
import type { DesktopClientCredential } from "../remote-client.ts";
import { desktopWorkerIdle, readDesktopWorkerState, startDesktopWorker } from "./worker-runtime.ts";
import { configuration, initialStatus, serviceEnvironment } from "./config.ts";
import { localGatewayClient } from "./gateway-env.ts";
import { startLocalDatabase, startLocalServices } from "./local-services.ts";
import { startRemoteServices } from "./remote-services.ts";
import type { PostgresTestOptions } from "./postgres-install.ts";
import { Logs } from "./log.ts";
import { Supervisor, until } from "./process.ts";
import { savedConfiguration, savedStatus, writeConfiguration } from "./saved-status.ts";
import { stableWebPort } from "./web-port.ts";
import { HealthChecks } from "./health.ts";
import { livenessProbes, type LivenessProbe } from "./liveness.ts";
import { DesktopWeb } from "./web.ts";
import type { Secrets, RuntimePaths } from "./config.ts";
import { desktopStorage } from "./storage.ts";
import { MigrationJournalFile, sourceFenced } from "./migration-state.ts";

export type { Secrets, RuntimePaths } from "./config.ts";

export class DesktopRuntime {
  readonly logs: Logs;
  private services: Supervisor;
  private web: DesktopWeb | undefined;
  private env = serviceEnvironment();
  private webPort = 0;
  private workerStatusFile = "";
  private localGateway: LocalBffTarget | undefined;
  private localDatabase: Awaited<ReturnType<typeof startLocalDatabase>> | undefined;
  private remoteConnection: { client: DesktopClientCredential; directory: string } | undefined;
  remoteControl() {
    return this.remoteConnection;
  }
  async drainWorker(draining: boolean) {
    return desktopWorkerIdle(this.services, this.workerStatusFile, draining);
  }
  private statusTimer: ReturnType<typeof setInterval> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private checkingHealth = false;
  private configured = false;
  private activeClient: DesktopClientCredential | undefined;
  private generation = 0;
  private health: HealthChecks;
  private probes: LivenessProbe[] = [];
  private state = initialStatus();
  private setupOrigin = "";
  private readonly storage: ReturnType<typeof desktopStorage>;
  private installing: AbortController | undefined;
  constructor(
    readonly directory: string,
    readonly paths: RuntimePaths,
    private readonly secrets: Secrets,
    private readonly changed: (status: DesktopStatus) => void = () => {},
    private readonly testing?: PostgresTestOptions,
    private readonly webToken = randomBytes(32).toString("hex"),
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.logs = new Logs(join(directory, "logs"));
    this.storage = desktopStorage(directory, paths, this.env, () => this.state.workerId);
    this.health = new HealthChecks((name, message) => this.logs.write(name, message));
    this.logs.protect(...Object.values(secrets), webToken);
    this.env["PATH"] = `${dirname(paths.bun)}${delimiter}${this.env["PATH"]}`;
    // Sidecars live in the signed app bundle: the app's own updater replaces them, never gateway/worker self-update.
    this.env["CANOPY_INSTALL_KIND"] = "desktop";
    // Private controller spawn configuration; renderer requests cannot choose a source path.
    Object.assign(this.env, { CANOPY_LOG_DIR: this.logs.directory, CANOPY_LOG_SUPERVISED: "1" });
    this.services = this.makeSupervisor();
  }
  get status() {
    return { ...this.state, clis: { ...this.state.clis } };
  }
  get origin() {
    return this.setupOrigin;
  }
  get pids() {
    return this.services.pids;
  }
  /** Called by the controller: the web shares its process (web.ts). */
  hostWebInThisProcess() {
    this.#web().hostInThisProcess();
  }
  #web() {
    this.web ??= new DesktopWeb(this.paths.web, this.logs, this.webToken);

    return this.web;
  }
  // Worker/health polls repeat the same status every second; each event rebuilds the app and tray
  // menus on Electron's UI thread, which also delivers input. Only report real changes.
  private publish(patch: Partial<DesktopStatus>) {
    const next = { ...this.state, ...patch };

    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.changed(this.status);
  }
  private makeSupervisor() {
    return new Supervisor(this.logs, (name, running, failed) => {
      if (running) this.health.started(name);

      if (name === "worker" && !running) this.publish({ worker: "offline" });

      if (!running && this.state.phase === "running" && ["gateway", "postgres"].includes(name))
        this.publish({ phase: "starting" });

      if (failed) {
        if (name === "gateway") this.disconnect();
        this.publish({
          phase: "error",
          error: `${name} stopped and cannot restart automatically. Open desktop settings to retry.`,
        });
      }
    });
  }
  private disconnect() {
    this.localGateway = undefined;
    this.localDatabase = undefined;
    this.remoteConnection = undefined;
    this.activeClient = undefined;
    this.workerStatusFile = "";
    this.web?.disconnect();
  }
  async initialize(restore = true) {
    this.publish(savedStatus(this.directory));
    this.webPort = await stableWebPort(this.directory);
    this.setupOrigin = `http://127.0.0.1:${this.webPort}`;
    await this.#web().start(this.setupOrigin, { mode: "offline" });
    this.statusTimer = setInterval(() => this.readWorkerStatus(), 1000);
    this.healthTimer = setInterval(() => void this.checkHealth(), 5000);

    if (restore) await this.restore();

    return this.setupOrigin;
  }
  async restore(client?: DesktopClientCredential) {
    const saved = join(this.directory, "desktop.json");

    if (existsSync(saved)) {
      try {
        await this.configure(configuration(JSON.parse(readFileSync(saved, "utf8"))), client);
      } catch (error) {
        this.publish({ phase: "error", error: error instanceof Error ? error.message : "Desktop startup failed" });
      }
    }
  }
  private readWorkerStatus() {
    if (this.workerStatusFile && this.services.alive("worker"))
      this.publish({ worker: readDesktopWorkerState(this.workerStatusFile) });
  }
  private async checkHealth() {
    if (
      !this.configured ||
      this.checkingHealth ||
      this.state.phase === "error" ||
      this.state.phase === "stopping" ||
      !this.health.poll()
    )
      return;
    this.checkingHealth = true;
    const generation = this.generation;

    try {
      const healthy = await Promise.all(
        this.probes.map(async ({ name, probe }) => {
          const supervisor = this.services;

          if (!supervisor.alive(name)) return false;

          return this.health.check(name, probe, async (current) => {
            if (name === "gateway")
              await this.presence("restarting").catch(() => {
                this.logs.write(name, "Could not announce the health restart; gateway did not answer");
              });

            if (generation === this.generation && current()) {
              this.logs.write(name, "Restarting owned process after sustained liveness failure");
              supervisor.restart(name, name === "gateway");
            } else this.logs.write(name, "Liveness restart canceled after a lifecycle change");
          });
        }),
      );

      if (
        generation === this.generation &&
        this.configured &&
        healthy.every(Boolean) &&
        !["stopping", "error"].includes(this.state.phase)
      )
        this.publish({ phase: "running" });
    } finally {
      this.checkingHealth = false;
    }
  }
  private localOptions(signal: AbortSignal) {
    return {
      directory: this.directory,
      paths: this.paths,
      secrets: this.secrets,
      supervisor: this.services,
      env: this.env,
      webOrigin: this.setupOrigin,
      signal,
      progress: (database: DesktopStatus["database"]) => this.publish({ database }),
      log: (line: string) => this.logs.write("desktop", line),
      testing: this.testing,
    };
  }
  async stopLocalForMigration() {
    this.generation++;
    this.configured = false;
    this.health.reset();
    this.disconnect();
    await this.services.stop();
    this.services = this.makeSupervisor();
    this.holdMigration();
  }
  quiesceLocalGateway() {
    this.generation++;
    this.configured = false;

    return this.services.quiesce("gateway");
  }
  resumeLocalAfterAbortedDrain() {
    this.services.resume("gateway");
    this.configured = !!this.localGateway && this.services.alive("gateway");

    return this.configured;
  }
  holdMigration() {
    this.publish({
      phase: "error",
      worker: "offline",
      error: "Gateway migration is paused. Open migration to continue.",
    });
  }
  assertMigrationServicesStopped() {
    if (this.services.alive("gateway") || this.services.alive("worker"))
      throw new Error("The local gateway and worker must finish stopping");
  }
  async migrationDatabase(offline: boolean, signal: AbortSignal) {
    if (offline) this.assertMigrationServicesStopped();
    else if (!this.localGateway || !this.services.alive("gateway") || !this.services.alive("postgres"))
      throw new Error("Start the local gateway before preparing the migration");

    this.localDatabase ??= await startLocalDatabase(this.localOptions(signal), false);

    return this.localDatabase;
  }
  configurationUnchanged(config: DesktopConfiguration, client?: DesktopClientCredential) {
    if (!this.configured || this.state.phase === "error" || (client && client.token !== this.activeClient?.token))
      return false;

    return sameDesktopConfiguration(config, this.state.configuration);
  }
  async configure(raw: DesktopConfiguration, client?: DesktopClientCredential) {
    const config = configuration(raw, this.state.configuration);

    if (config.mode === "local" && sourceFenced(new MigrationJournalFile(this.directory).read()))
      throw new Error("The local gateway is fenced for migration. Open migration to continue.");

    if (this.configurationUnchanged(config, client)) return;
    this.generation++;
    this.configured = false;
    this.disconnect();
    this.health.reset();
    this.cancelStartup();
    const installing = new AbortController();
    this.installing = installing;
    this.publish({
      mode: config.mode,
      phase: "starting",
      worker: "offline",
      workerId: undefined,
      error: undefined,
      database: undefined,
      needsPairing: false,
      gatewayUrl: config.mode === "remote" ? config.gatewayUrl : undefined,
      webUrl: this.setupOrigin,
      workerGatewayUrl: config.mode === "remote" ? (config.workerGatewayUrl ?? config.gatewayUrl) : undefined,
    });
    await this.services.stop();
    installing.signal.throwIfAborted();
    this.services = this.makeSupervisor();

    try {
      let gatewayUrl: string;
      let local: LocalBffTarget | undefined;
      let remote: Awaited<ReturnType<typeof startRemoteServices>> | undefined;
      let workerDirectory: string;
      let token: string | undefined;

      if (config.mode === "local") {
        const services = await startLocalServices(this.localOptions(installing.signal));
        ({ target: local, workerDirectory, token } = services);
        this.localDatabase = services.database;
        gatewayUrl = local.gatewayUrl;
      } else {
        remote = await startRemoteServices({
          config,
          credential: client,
          directory: this.directory,
          logs: this.logs,
          origin: this.setupOrigin,
          web: this.#web(),
        });
        ({ gatewayUrl, workerDirectory, token } = remote);
      }

      installing.signal.throwIfAborted();

      const worker = await startDesktopWorker({
        directory: workerDirectory,
        gatewayUrl: remote?.workerAddress ?? gatewayUrl,
        token,
        fingerprint: config.mode === "remote" ? config.gatewayFingerprint || client?.fingerprint : undefined,
        local,
        logs: this.logs,
        services: this.services,
        bun: this.paths.bun,
        entry: this.paths.worker,
        env: this.env,
      });

      this.workerStatusFile = worker?.statusFile ?? "";
      this.publish({
        workerId: worker?.workerId,
        mode: config.mode,
        gatewayUrl,
        webUrl: this.setupOrigin,
        allowNetwork: config.mode === "local" && config.allowNetwork,
        bindHost: config.mode === "local" ? config.bindHost : "127.0.0.1",
        clis: {
          claude: Boolean(Bun.which("claude", { PATH: this.env["PATH"]! })),
          codex: Boolean(Bun.which("codex", { PATH: this.env["PATH"]! })),
          grok: Boolean(Bun.which("grok", { PATH: this.env["PATH"]! })),
        },
        worker: this.workerStatusFile ? "connecting" : "offline",
      });

      // The bundled frontend starts without waiting for a remote gateway or worker.
      if (config.mode === "local")
        await until(
          async () => {
            this.readWorkerStatus();

            return this.state.worker === "online";
          },
          30_000,
          () => !installing.signal.aborted,
        );

      // Never persist the one-time token. A failed attempt leaves the last working selection intact.
      if (config.mode === "remote" && !client) {
        this.publish({
          phase: "error",
          needsPairing: true,
          error:
            "Automatic migration is unavailable. Update Canopy on your gateway and enable Network access, or paste a desktop invitation from Settings → Devices.",
        });

        return;
      }

      const saved = savedConfiguration(config, gatewayUrl);

      installing.signal.throwIfAborted();

      if (local) await this.#web().start(this.setupOrigin, local);
      installing.signal.throwIfAborted();
      writeConfiguration(this.directory, saved);
      this.localGateway = local;
      this.configured = true;
      this.probes = local ? livenessProbes(local) : [];
      this.activeClient = client;

      if (remote?.client && this.workerStatusFile)
        this.remoteConnection = { client: remote.client, directory: workerDirectory };
      this.publish({ phase: "running", configuration: saved });
    } catch (error) {
      this.disconnect();
      await this.services.stop();
      const message = this.logs.redact(error instanceof Error ? error.message : "Desktop configuration failed");
      this.logs.write("desktop", message);
      this.publish({ phase: "error", worker: "offline", error: message });
      throw new Error(message);
    } finally {
      if (this.installing === installing) this.installing = undefined;
    }
  }
  client() {
    if (!this.localGateway) throw new Error("The local gateway is offline");

    return localGatewayClient(this.localGateway);
  }
  killOwned() {
    this.services.killOwned();
  }
  cancelStartup() {
    this.installing?.abort();
  }
  async presence(state: string, targetVersion = "") {
    if (["sleeping", "shutting_down", "updating"].includes(state)) this.health.suspend();

    if (state === "connected" || state === "waking") this.health.resume();

    if (state === "waking") return;

    if (this.localGateway)
      await this.client().manageComputer(
        { action: "presence", name: state, targetVersion },
        { timeoutMs: state === "sleeping" ? 500 : 2000 },
      );
  }
  async stop() {
    this.disconnect();
    this.cancelStartup();
    this.generation++;
    this.health.reset();
    this.storage.close();
    this.configured = false;
    this.publish({ phase: "stopping" });

    if (this.statusTimer) clearInterval(this.statusTimer);

    if (this.healthTimer) clearInterval(this.healthTimer);
    // Keep worker → gateway → Postgres ordering within services for flush and clean DB shutdown; the stateless web
    // closes its connections at once.
    await Promise.all([this.services.stop(), this.web?.stop()]);
    this.publish({ worker: "offline" });
  }
}
