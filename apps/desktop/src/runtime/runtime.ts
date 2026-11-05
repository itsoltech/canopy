import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname, delimiter } from "node:path";
import { hostname } from "node:os";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui } from "@canopy/contracts";
import { sameDesktopConfiguration, type DesktopConfiguration, type DesktopStatus } from "@canopy/ui/desktop";
import { remoteWorkerDirectory, type DesktopClientCredential } from "../remote-client.ts";
import { desktopWorkerIdle, remoteEnrollment, startDesktopWorker } from "./worker-runtime.ts";
import { configuration, freePort, initialStatus, serviceEnvironment, isWorkerStatus } from "./config.ts";
import { startDatabase } from "./database.ts";
import { PostgresInstaller, postgresTestOptions, type PostgresTestOptions } from "./postgres-install.ts";
import { Logs } from "./log.ts";
import { Supervisor, until } from "./process.ts";
import { savedStatus, writeConfiguration } from "./saved-status.ts";
import { stableWebPort } from "./web-port.ts";

export interface Secrets {
  databasePassword: string;
  secretsKey: string;
  serviceToken: string;
}

export interface RuntimePaths {
  bun: string;
  gateway: string;
  worker: string;
  web: string;
  postgres: string;
}

export class DesktopRuntime {
  readonly logs: Logs;
  private services: Supervisor;
  private web: Supervisor;
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
  private healthFailures = new Map<string, number>();
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
    this.logs.protect(...Object.values(secrets));
    this.env["PATH"] = `${dirname(paths.bun)}${delimiter}${this.env["PATH"]}`;
    // Sidecars live in the signed app bundle: the app's own updater replaces them, never gateway/worker self-update.
    this.env["CANOPY_INSTALL_KIND"] = "desktop";
    this.services = this.makeSupervisor();
    this.web = this.makeSupervisor();
  }
  get status() {
    return { ...this.state, clis: { ...this.state.clis } };
  }
  get origin() {
    return this.setupOrigin;
  }
  get pids() {
    return [...this.services.pids, ...this.web.pids];
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
      if (name === "worker" && !running) this.publish({ worker: "offline" });

      if (!running && this.state.phase === "running" && ["gateway", "postgres", "web"].includes(name))
        this.publish({ phase: "starting" });

      if (failed)
        this.publish({
          phase: "error",
          error: `${name} stopped and cannot restart automatically. Open desktop settings to retry.`,
        });
    });
  }
  private async startWeb(gatewayUrl: string, client?: DesktopClientCredential) {
    await this.web.stop();
    this.web = this.makeSupervisor();
    // The local BFF owns no durable state. Browser keep-alive/SSE connections must not delay quit.
    this.web.start({
      name: "web",
      ...this.command(this.paths.web),
      cwd: dirname(this.paths.web),
      env: {
        ...this.env,
        CANOPY_WEB_ASSETS_DIR: join(dirname(this.paths.web), "web"),
        HOST: "127.0.0.1",
        PORT: String(this.webPort),
        CANOPY_WEB_ORIGIN: this.setupOrigin,
        GATEWAY_URL: gatewayUrl,
        // A local random token satisfies BFF env validation; remote RPCs use only client.token.
        GATEWAY_SERVICE_TOKEN: this.secrets.serviceToken,
        ...(client && {
          CANOPY_DESKTOP_CLIENT_TOKEN: client.token,
          CANOPY_DESKTOP_GATEWAY_ROUTES: JSON.stringify({
            fingerprint: client.fingerprint,
            addresses: client.addresses,
          }),
        }),
        BODY_SIZE_LIMIT: "50M",
      },
      restart: true,
      stopSignal: "SIGKILL",
    });
    await until(async () => (await fetch(`${this.setupOrigin}/desktop`, { signal: AbortSignal.timeout(1000) })).ok);
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
    if (!this.configured || this.checkingHealth || this.state.phase === "error" || this.state.phase === "stopping")
      return;
    this.checkingHealth = true;
    const generation = this.generation;

    const checks = [
      {
        name: "web",
        supervisor: this.web,
        probe: async () => (await fetch(`${this.setupOrigin}/desktop`, { signal: AbortSignal.timeout(2000) })).ok,
      },
    ];

    if (this.state.mode === "local")
      checks.push({
        name: "gateway",
        supervisor: this.services,
        probe: async () => {
          await this.client().getOverview({}, { timeoutMs: 2000 });

          return true;
        },
      });

    try {
      const healthy = await Promise.all(
        checks.map(async ({ name, supervisor, probe }) => {
          const ok = await probe().catch(() => false);

          if (generation !== this.generation) return false;
          const failures = ok ? 0 : (this.healthFailures.get(name) ?? 0) + 1;
          this.healthFailures.set(name, failures);

          if (failures >= 3 && supervisor.alive(name)) {
            this.logs.write(name, "Health check failed three times; restarting owned process");
            supervisor.restart(name);
            this.healthFailures.set(name, 0);
          }

          return ok;
        }),
      );

      if (generation === this.generation && this.configured && !["stopping", "error"].includes(this.state.phase))
        this.publish({ phase: healthy.every(Boolean) ? "running" : "starting" });
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
      env: {
        ...this.env,
        CANOPY_DATABASE_URL: databaseUrl,
        CANOPY_SECRETS_KEY: this.secrets.secretsKey,
        CANOPY_UI_SERVICE_TOKEN: this.secrets.serviceToken,
        CANOPY_GATEWAY_ROLE: "desktop",
        CANOPY_HOST: "127.0.0.1",
        CANOPY_PORT: String(gatewayPort),
      },
      restart: true,
    });
    const client = this.client(gatewayUrl);
    await until(async () => {
      await client.getOverview({}, { timeoutMs: 1000 });

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
    this.healthFailures.clear();
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
    this.web.killOwned();
  }
  cancelStartup() {
    this.installing?.abort();
  }
  async presence(state: string) {
    if (this.state.mode === "local" && this.state.gatewayUrl)
      await this.client().manageComputer({ action: "presence", name: state });
  }
  async stop() {
    this.cancelStartup();
    this.generation++;
    this.configured = false;
    this.publish({ phase: "stopping" });

    if (this.statusTimer) clearInterval(this.statusTimer);

    if (this.healthTimer) clearInterval(this.healthTimer);
    // Keep worker → gateway → Postgres ordering within services for flush and clean DB shutdown.
    await Promise.all([this.services.stop(), this.web.stop()]);
    this.publish({ worker: "offline" });
  }
}
