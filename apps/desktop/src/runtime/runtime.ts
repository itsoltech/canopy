import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { hostname } from "node:os";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui } from "@canopy/contracts";
import { sameDesktopConfiguration, type DesktopConfiguration, type DesktopStatus } from "@canopy/ui/desktop";
import { remoteWorkerDirectory, type DesktopClientCredential } from "../remote-client.ts";
import { desktopWorkerIdle, remoteEnrollment, startDesktopWorker } from "./worker-runtime.ts";
import { configuration, freePort, initialStatus, serviceEnvironment, isWorkerStatus } from "./config.ts";
import { localGatewayEnvironment } from "./gateway-env.ts";
import { startDatabase } from "./database.ts";
import { PostgresInstaller, postgresTestOptions, type PostgresTestOptions } from "./postgres-install.ts";
import { Logs } from "./log.ts";
import { Supervisor, until } from "./process.ts";
import { savedStatus, writeConfiguration } from "./saved-status.ts";
import { stableWebPort } from "./web-port.ts";
import { HealthChecks } from "./health.ts";
import { gatewayLiveness, livenessProbes, type LivenessProbe } from "./liveness.ts";
import { DesktopWeb } from "./web.ts";
import type { Secrets, RuntimePaths } from "./config.ts";

export type { Secrets, RuntimePaths } from "./config.ts";

export class DesktopRuntime {
  readonly logs: Logs;
  private services: Supervisor;
  private web: DesktopWeb | undefined;
  private env = serviceEnvironment();
  private webPort = 0;
  private workerStatusFile = "";
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
  private installing: AbortController | undefined;
  private command(entry: string) {
    return { command: this.paths.bun, args: [entry] };
  }
  constructor(
    readonly directory: string,
    readonly paths: RuntimePaths,
    private readonly secrets: Secrets,
    private readonly changed: (status: DesktopStatus) => void = () => {},
    private readonly testing?: PostgresTestOptions,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.logs = new Logs(join(directory, "logs"));
    this.health = new HealthChecks((name, message) => this.logs.write(name, message));
    this.logs.protect(...Object.values(secrets));
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
    this.web ??= new DesktopWeb(this.paths.web, this.logs);

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

      if (failed)
        this.publish({
          phase: "error",
          error: `${name} stopped and cannot restart automatically. Open desktop settings to retry.`,
        });
    });
  }
  /** The bundled UI in this process; a later call only points its BFF at another gateway (web.ts). */
  private async startWeb(gatewayUrl: string, client?: DesktopClientCredential) {
    await this.#web().start(this.setupOrigin, {
      gatewayUrl,
      // A local random token satisfies BFF env validation; remote RPCs use only client.token.
      serviceToken: this.secrets.serviceToken,
      ...(client && {
        desktopClient: {
          token: client.token,
          routes: JSON.stringify({ fingerprint: client.fingerprint, addresses: client.addresses }),
        },
      }),
    });
  }
  async initialize(restore = true) {
    this.publish(savedStatus(this.directory));
    this.webPort = await stableWebPort(this.directory);
    this.setupOrigin = `http://127.0.0.1:${this.webPort}`;
    await this.startWeb("http://127.0.0.1:1");
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
    if (!this.workerStatusFile || !this.services.alive("worker")) return;

    try {
      const value: unknown = JSON.parse(readFileSync(this.workerStatusFile, "utf8"));

      if (!isWorkerStatus(value)) throw new Error("Invalid worker status");

      const worker =
        Date.now() - (value.time ?? 0) >= 45_000 || value.status === "offline"
          ? "offline"
          : value.status === "online"
            ? "online"
            : "connecting";

      this.publish({ worker });
    } catch {
      this.publish({ worker: "connecting" });
    }
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
  private async startLocal(signal: AbortSignal) {
    const installer = new PostgresInstaller(
      this.paths.postgres,
      join(this.directory, "postgres"),
      (database) => this.publish({ database }),
      this.testing ?? postgresTestOptions(),
      (line) => this.logs.write("desktop", line),
    );

    const binaries = await installer.ensure(signal);
    this.publish({ database: { phase: "ready", message: "Starting the local database…" } });

    const databaseUrl = await startDatabase({
      directory: join(this.directory, "postgres"),
      binaries,
      password: this.secrets.databasePassword,
      supervisor: this.services,
      env: this.env,
    });

    this.publish({ database: undefined });

    installer.cleanup();
    const gatewayPort = await freePort();
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const workerDirectory = join(this.directory, "local-worker");
    this.services.start({
      name: "gateway",
      ...this.command(this.paths.gateway),
      cwd: dirname(this.paths.gateway),
      env: localGatewayEnvironment(this.env, this.secrets, {
        databaseUrl,
        port: gatewayPort,
        webOrigin: this.setupOrigin,
      }),
      restart: true,
    });
    const client = this.client(gatewayUrl);
    const probe = gatewayLiveness(gatewayUrl);
    await until(async () => {
      await probe();

      return true;
    });

    let token: string | undefined;

    if (!existsSync(join(workerDirectory, "worker.json")))
      token = (await client.createWorkerEnrollment({ name: `Canopy · ${hostname()}` })).token;
    await this.startWeb(gatewayUrl);

    return { gatewayUrl, webUrl: this.setupOrigin, workerDirectory, token };
  }
  configurationUnchanged(config: DesktopConfiguration, client?: DesktopClientCredential) {
    if (!this.configured || this.state.phase === "error" || (client && client.token !== this.activeClient?.token))
      return false;

    return sameDesktopConfiguration(config, this.state.configuration);
  }
  async configure(raw: DesktopConfiguration, client?: DesktopClientCredential) {
    const config = configuration(raw);

    if (this.configurationUnchanged(config, client)) return;
    this.generation++;
    this.configured = false;
    this.remoteConnection = undefined;
    this.health.reset();
    this.cancelStartup();
    const installing = new AbortController();
    this.installing = installing;
    this.publish({
      mode: config.mode,
      phase: "starting",
      worker: "offline",
      error: undefined,
      database: undefined,
      needsPairing: false,
      ...(config.mode === "remote" && {
        gatewayUrl: config.gatewayUrl,
        webUrl: this.setupOrigin,
        workerGatewayUrl: config.workerGatewayUrl ?? config.gatewayUrl,
      }),
    });
    await this.services.stop();
    this.services = this.makeSupervisor();

    try {
      let gatewayUrl: string;
      let webUrl: string;
      let workerDirectory: string;
      let token: string | undefined;

      if (config.mode === "local") {
        ({ gatewayUrl, webUrl, workerDirectory, token } = await this.startLocal(installing.signal));
      } else {
        gatewayUrl = client?.addresses[0] ?? config.gatewayUrl;
        webUrl = this.setupOrigin;
        workerDirectory = remoteWorkerDirectory(this.directory, config);
        token = config.enrollmentToken;

        if (client) {
          this.logs.protect(client.token);

          if (!token) {
            const enrollment = await remoteEnrollment(client, workerDirectory, this.logs);
            token = enrollment?.token;
            gatewayUrl = enrollment?.gatewayUrl || gatewayUrl;
          }
        }

        await this.startWeb(client ? gatewayUrl : "http://127.0.0.1:1", client);
      }

      this.workerStatusFile = await startDesktopWorker({
        directory: workerDirectory,
        gatewayUrl: config.mode === "remote" && config.enrollmentToken ? config.gatewayUrl : gatewayUrl,
        token,
        fingerprint: config.mode === "remote" ? config.gatewayFingerprint || client?.fingerprint : undefined,
        local: config.mode === "local",
        logs: this.logs,
        services: this.services,
        bun: this.paths.bun,
        entry: this.paths.worker,
        env: this.env,
      });
      this.publish({
        mode: config.mode,
        gatewayUrl,
        webUrl,
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
        await until(async () => {
          this.readWorkerStatus();

          return this.state.worker === "online";
        }, 30_000);

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

      const saved =
        config.mode === "remote"
          ? { mode: config.mode, gatewayUrl, workerGatewayUrl: config.workerGatewayUrl ?? config.gatewayUrl }
          : config;

      writeConfiguration(this.directory, saved);
      this.configured = true;
      this.probes = config.mode === "local" ? livenessProbes(gatewayUrl) : [];
      this.activeClient = client;

      if (config.mode === "remote" && client && this.workerStatusFile)
        this.remoteConnection = { client, directory: workerDirectory };
      this.publish({ phase: "running", configuration: saved });
    } catch (error) {
      await this.services.stop();
      const message = this.logs.redact(error instanceof Error ? error.message : "Desktop configuration failed");
      this.logs.write("desktop", message);
      this.publish({ phase: "error", worker: "offline", error: message });
      throw new Error(message);
    } finally {
      if (this.installing === installing) this.installing = undefined;
    }
  }
  client(gatewayUrl = this.state.gatewayUrl!) {
    return createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: gatewayUrl,
        connectTimeoutMs: 1000,
        defaultTimeoutMs: 3000,
        interceptors: [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${this.secrets.serviceToken}`);

            return next(request);
          },
        ],
      }),
    );
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

    if (this.state.mode === "local" && this.state.gatewayUrl)
      await this.client().manageComputer(
        { action: "presence", name: state, targetVersion },
        { timeoutMs: state === "sleeping" ? 500 : 2000 },
      );
  }
  async stop() {
    this.cancelStartup();
    this.generation++;
    this.health.reset();
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
