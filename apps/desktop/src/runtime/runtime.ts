import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname, delimiter } from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { ui } from "@canopy/contracts";
import type { DesktopConfiguration, DesktopStatus } from "@canopy/ui/desktop";
import { enrollWorker } from "../../../worker/src/enroll.ts";
import { configuration, freePort, initialStatus, serviceEnvironment } from "./config.ts";
import { startDatabase } from "./database.ts";
import { Logs } from "./log.ts";
import { Supervisor, until } from "./process.ts";

export interface Secrets { databasePassword: string; secretsKey: string; serviceToken: string }
export interface RuntimePaths { bun: string; gateway: string; worker: string; web: string; postgres: string; compiled?: boolean }
export class DesktopRuntime {
  readonly logs: Logs;
  private services: Supervisor;
  private web: Supervisor;
  private env = serviceEnvironment();
  private webPort = 0;
  private workerStatusFile = "";
  private statusTimer: ReturnType<typeof setInterval> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private checkingHealth = false;
  private configured = false;
  private generation = 0;
  private healthFailures = new Map<string, number>();
  private state = initialStatus();
  private setupOrigin = "";
  private command(entry: string) { return this.paths.compiled ? { command: entry, args: [] as string[] } : { command: this.paths.bun, args: [entry] }; }
  constructor(readonly directory: string, readonly paths: RuntimePaths, private readonly secrets: Secrets, private readonly changed: (status: DesktopStatus) => void = () => {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.logs = new Logs(join(directory, "logs"));
    this.logs.protect(...Object.values(secrets));
    this.env["PATH"] = `${dirname(paths.bun)}${delimiter}${this.env["PATH"]}`;
    this.services = this.makeSupervisor();
    this.web = this.makeSupervisor();
  }
  get status() { return { ...this.state, clis: { ...this.state.clis } }; }
  get origin() { return this.setupOrigin; }
  get pids() { return [...this.services.pids, ...this.web.pids]; }
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
      if (!running && this.state.phase === "running" && ["gateway", "postgres", "web"].includes(name)) this.publish({ phase: "starting" });
      if (failed) this.publish({ phase: "error", error: `${name} stopped and cannot restart automatically. Open desktop settings to retry.` });
    });
  }
  private async startWeb(gatewayUrl: string) {
    await this.web.stop();
    this.web = this.makeSupervisor();
    this.web.start({ name: "web", ...this.command(this.paths.web), cwd: dirname(this.paths.web), env: { ...this.env, CANOPY_WEB_ASSETS_DIR: join(dirname(this.paths.web), "web"), HOST: "127.0.0.1", PORT: String(this.webPort), ORIGIN: this.setupOrigin, GATEWAY_URL: gatewayUrl, GATEWAY_SERVICE_TOKEN: this.secrets.serviceToken }, restart: true });
    await until(async () => (await fetch(`${this.setupOrigin}/desktop`, { signal: AbortSignal.timeout(1000) })).ok);
  }
  async initialize(restore = true) {
    this.webPort = await freePort();
    this.setupOrigin = `http://127.0.0.1:${this.webPort}`;
    await this.startWeb("http://127.0.0.1:1");
    this.statusTimer = setInterval(() => this.readWorkerStatus(), 1000);
    this.healthTimer = setInterval(() => void this.checkHealth(), 5000);
    const saved = join(this.directory, "desktop.json");
    if (restore && existsSync(saved)) {
      try { await this.configure(configuration(JSON.parse(readFileSync(saved, "utf8")))); }
      catch (error) { this.publish({ phase: "error", error: error instanceof Error ? error.message : "Desktop startup failed" }); }
    }
    return this.setupOrigin;
  }
  private readWorkerStatus() {
    if (!this.workerStatusFile || !this.services.alive("worker")) return;
    try {
      const value = JSON.parse(readFileSync(this.workerStatusFile, "utf8")) as { status?: string; time?: number };
      const worker = Date.now() - (value.time ?? 0) >= 45_000 || value.status === "offline" ? "offline" : value.status === "online" ? "online" : "connecting";
      this.publish({ worker });
    } catch { this.publish({ worker: "connecting" }); }
  }
  private async checkHealth() {
    if (!this.configured || this.checkingHealth || this.state.phase === "error" || this.state.phase === "stopping") return;
    this.checkingHealth = true;
    const generation = this.generation;
    const checks = [{ name: "web", supervisor: this.web, probe: async () => (await fetch(`${this.setupOrigin}/desktop`, { signal: AbortSignal.timeout(2000) })).ok }];
    if (this.state.mode === "local") checks.push({ name: "gateway", supervisor: this.services, probe: async () => { await this.client().getOverview({}, { timeoutMs: 2000 }); return true; } });
    try {
      const healthy = await Promise.all(checks.map(async ({ name, supervisor, probe }) => {
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
      }));
      if (generation === this.generation && this.configured && !["stopping", "error"].includes(this.state.phase)) this.publish({ phase: healthy.every(Boolean) ? "running" : "starting" });
    } finally { this.checkingHealth = false; }
  }
  async configure(raw: unknown) {
    const config = configuration(raw);
    this.generation++;
    this.configured = false;
    this.healthFailures.clear();
    this.publish({ phase: "starting", worker: "offline", error: undefined });
    await this.services.stop();
    this.services = this.makeSupervisor();
    try {
      let gatewayUrl: string;
      let webUrl: string;
      let workerDirectory: string;
      let token: string | undefined;
      if (config.mode === "local") {
        const databaseUrl = await startDatabase({ directory: join(this.directory, "postgres"), binaries: this.paths.postgres, password: this.secrets.databasePassword, supervisor: this.services, env: this.env });
        const gatewayPort = await freePort();
        const workerPort = config.allowNetwork ? await freePort(config.bindHost) : undefined;
        gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
        webUrl = this.setupOrigin;
        workerDirectory = join(this.directory, "local-worker");
        this.services.start({ name: "gateway", ...this.command(this.paths.gateway), cwd: dirname(this.paths.gateway), env: { ...this.env, CANOPY_DATABASE_URL: databaseUrl, CANOPY_SECRETS_KEY: this.secrets.secretsKey, CANOPY_UI_SERVICE_TOKEN: this.secrets.serviceToken, CANOPY_HOST: "127.0.0.1", CANOPY_PORT: String(gatewayPort), CANOPY_PUBLIC_GATEWAY_URL: workerPort ? `http://${config.bindHost}:${workerPort}` : gatewayUrl, ...(workerPort && { CANOPY_WORKER_HOST: config.bindHost, CANOPY_WORKER_PORT: String(workerPort) }) }, restart: true });
        const client = this.client(gatewayUrl);
        await until(async () => { await client.getOverview({}, { timeoutMs: 1000 }); return true; });
        if (!existsSync(join(workerDirectory, "worker.json"))) token = (await client.createWorkerEnrollment({ name: `Canopy · ${hostname()}` })).token;
        await this.startWeb(gatewayUrl);
      } else {
        gatewayUrl = config.gatewayUrl;
        webUrl = config.webUrl;
        workerDirectory = join(this.directory, "remote-workers", createHash("sha256").update(gatewayUrl).digest("hex").slice(0, 24));
        token = config.enrollmentToken;
        // The setup BFF never receives a remote service token or uses a remote gRPC endpoint.
        await this.startWeb("http://127.0.0.1:1");
      }
      mkdirSync(workerDirectory, { recursive: true, mode: 0o700 });
      const configPath = join(workerDirectory, "worker.json");
      if (token) {
        this.logs.protect(token);
        const enrolled = await enrollWorker({ gateway: gatewayUrl, token, configPath, dataDir: join(workerDirectory, "data"), force: existsSync(configPath) });
        this.logs.protect(enrolled.credential);
      } else if (!existsSync(configPath)) throw new Error("Paste an enrollment token from Settings → Workers → Add worker");
      // Local ports change between launches; preserve the enrolled worker's identity and journal.
      const local = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, string>;
      if (local["credential"]) this.logs.protect(local["credential"]);
      local["gateway_url"] = gatewayUrl;
      this.writeJson(configPath, local);
      this.workerStatusFile = join(workerDirectory, "status.json");
      this.writeJson(this.workerStatusFile, { status: "offline", time: Date.now() });
      const launch = this.command(this.paths.worker);
      this.services.start({ name: "worker", ...launch, args: [...launch.args, "--config", configPath], cwd: dirname(this.paths.worker), env: { ...this.env, CANOPY_WORKER_STATUS_FILE: this.workerStatusFile }, restart: true });
      this.publish({ mode: config.mode, gatewayUrl, webUrl, allowNetwork: config.mode === "local" && config.allowNetwork, bindHost: config.mode === "local" ? config.bindHost : "127.0.0.1", clis: { claude: Boolean(Bun.which("claude", { PATH: this.env["PATH"]! })), codex: Boolean(Bun.which("codex", { PATH: this.env["PATH"]! })), grok: Boolean(Bun.which("grok", { PATH: this.env["PATH"]! })) }, worker: "connecting" });
      const connected = until(async () => { this.readWorkerStatus(); return this.state.worker === "online"; }, config.mode === "local" ? 30_000 : 10_000);
      if (config.mode === "local") await connected;
      else await connected.catch(() => this.logs.write("worker", "Remote gateway unavailable; enrolled worker will keep reconnecting"));
      // Never persist the one-time token. A failed attempt leaves the last working selection intact.
      const saved = config.mode === "remote" ? { mode: config.mode, gatewayUrl, webUrl } : config;
      this.writeJson(join(this.directory, "desktop.json"), saved);
      this.configured = true;
      this.publish({ phase: "running" });
    } catch (error) {
      await this.services.stop();
      const message = this.logs.redact(error instanceof Error ? error.message : "Desktop configuration failed");
      this.logs.write("desktop", message);
      this.publish({ phase: "error", worker: "offline", error: message });
      throw new Error(message);
    }
  }
  client(gatewayUrl = this.state.gatewayUrl!) {
    return createClient(ui.GatewayService, createGrpcTransport({ baseUrl: gatewayUrl, connectTimeoutMs: 1000, defaultTimeoutMs: 3000, interceptors: [(next) => (request) => { request.header.set("authorization", `Bearer ${this.secrets.serviceToken}`); return next(request); }] }));
  }
  private writeJson(path: string, data: unknown) {
    const temporary = `${path}.new`;
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, path);
  }
  killOwned() { this.services.killOwned(); this.web.killOwned(); }
  async stop() {
    this.generation++;
    this.configured = false;
    this.publish({ phase: "stopping" });
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    await this.services.stop();
    await this.web.stop();
    this.publish({ worker: "offline" });
  }
}
