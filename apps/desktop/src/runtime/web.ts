import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "node:util";
import { setBffTarget, type BffTarget } from "@canopy/domain/bff-target";
import { containWebFaults } from "../../../gateway/src/web/faults.ts";
import { listen } from "../../../gateway/src/web/probe.ts";
import { webRequestListener, type WebHandler } from "../../../gateway/src/web/requests.ts";
import type { Logs } from "./log.ts";

/** canopy-web.js (scripts/build.ts): adapter-node's handler and the setter of the desktop's fixed origin. */
interface WebModule {
  handler?: WebHandler;
  setOrigin?: (origin: string) => void;
}

/**
 * The desktop's bundled web UI and BFF, served from the controller process on the stable loopback port. It never
 * comes from a gateway, so the UI works offline and in remote mode, and it stays up while the local gateway
 * restarts or updates. Mode and computer switches change only the BFF's target (bff-target.ts); open
 * connections close so the window reconnects to the new gateway, as a restarted web process did before.
 * One per process: the BFF's modules and target are process-wide.
 */
export class DesktopWeb {
  #server: Server | undefined;
  #loading: Promise<WebModule> | undefined;
  constructor(
    readonly entry: string,
    readonly logs: Logs,
  ) {}
  /** Serves the UI at `origin` (the window's stable loopback origin) against `target`; the first call loads it. */
  async start(origin: string, target: BffTarget): Promise<void> {
    setBffTarget(target);
    const web = await this.#load(origin, target);
    web.setOrigin?.(origin);
    process.env["CANOPY_WEB_ORIGIN"] = origin;

    if (this.#server) {
      this.#server.closeAllConnections();

      return;
    }

    const handler = web.handler;

    if (!handler) throw new Error("The desktop web build has no request handler");
    const log = (line: string) => this.logs.write("web", line);
    const server = createServer(webRequestListener(handler, { assets: new Map(), protocolHeader: "", log }));
    await listen(server, "127.0.0.1", Number(new URL(origin).port));
    this.#server = server;
  }
  /**
   * The controller process hosts only this web: its console goes to the `web` log (stdout is Electron's private
   * protocol pipe), and an unhandled rejection or exception from the web's own module is logged instead of
   * ending the controller with every service it supervises.
   */
  hostInThisProcess(): void {
    // A stream, like the sidecars' stdout: formatted objects span several lines.
    const stream = this.logs.stream("web");
    const write = (...args: Parameters<typeof console.log>) => stream(format(...args) + "\n");

    for (const level of ["log", "info", "debug", "warn", "error", "trace"] as const) console[level] = write;
    containWebFaults(this.entry, (line) => this.logs.write("web", line));
  }
  #load(origin: string, target: BffTarget): Promise<WebModule> {
    this.#loading ??= (async () => {
      // Read once when SvelteKit and adapter-node load; the target and origin are set per start.
      Object.assign(process.env, {
        CANOPY_WEB_ASSETS_DIR: join(dirname(this.entry), "web"),
        CANOPY_WEB_ORIGIN: origin,
        GATEWAY_URL: target.gatewayUrl,
        GATEWAY_SERVICE_TOKEN: target.serviceToken,
        BODY_SIZE_LIMIT: "50M",
        // The BFF's log lines reach the `web` log through this process's console, not a writer of its own.
        CANOPY_LOG_SUPERVISED: "1",
      });
      const loaded: WebModule = await import(pathToFileURL(this.entry).href);

      return loaded;
    })().catch((cause: unknown) => {
      this.#loading = undefined;
      throw cause;
    });

    return this.#loading;
  }
  /** No durable state: open keep-alive and SSE connections never delay quitting. */
  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;

    if (!server?.listening) return;
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    await closed;
  }
}
