import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import type { TLSSocket } from "node:tls";
import type { ComputerStore } from "../computers/store.ts";
import { containerBridged, detectAddresses, hostnameEntry, originOf, type DetectedAddress } from "./addresses.ts";
import {
  errorCode,
  listenError,
  openEverywhere,
  openListener,
  type Handler,
  type Listener,
  type SystemCode,
} from "./listener.ts";
import { loadSettings, saveSettings, type NetworkSettings } from "./settings.ts";
import { localNetworkBlocked, LOCAL_NETWORK_HELP } from "./local-network.ts";
import { requireDesktopRole, type GatewayRole } from "../role.ts";

export type NetworkOptions = {
  role?: GatewayRole;
  store: ComputerStore;
  /** The server's environment fixes the port (a published container port). */
  port?: number;
  /** Tests: listen on this one address and offer only it. */
  host?: string;
  /** Tests: this computer's interface addresses. */
  detect?: () => DetectedAddress[];
  pollMs?: number;
  log?: (message: string) => void;
};

type Service = "link" | "device";

// Ports a computer picks for itself: below every system's ephemeral range, above the well-known ones.
const randomPort = () => 20_000 + Math.floor(Math.random() * 12_000);

/** Network access (docs/network-access.md): one in-app switch lets phones and linked computers connect.
 * The listener is on every interface; pinned TLS and pairing are the security boundary. Settings are
 * stored in the database; the addresses are detected and refreshed while the computer changes networks. */
export class NetworkAccess {
  #settings: NetworkSettings = { enabled: false, port: null, hostnames: [] };
  #identity: { certificate: string; privateKey: string; fingerprint: string } | undefined;
  #listener: Listener | undefined;
  #error = "";
  #detected: DetectedAddress[] = [];
  #published = "";
  #timer: ReturnType<typeof setInterval> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #blockedAt = 0;
  readonly #services = new Map<Service, Handler>();
  readonly #changes = new Set<() => void>();

  constructor(readonly options: NetworkOptions) {}

  get role() {
    return this.options.role ?? "server";
  }

  /** The link service answers computers that present a certificate; the device services everything else. */
  mount(service: Service, handler: Handler | undefined) {
    if (service === "link" && handler) requireDesktopRole(this.role);

    if (handler) this.#services.set(service, handler);
    else this.#services.delete(service);
  }

  start() {
    return this.#serial(async () => {
      this.#identity = await this.options.store.identity();
      this.#settings = await loadSettings(this.options.store);
      this.#detected = this.#detect();
      await this.#apply();
      this.#timer = setInterval(() => void this.refresh(), this.options.pollMs ?? 10_000);
      this.#timer.unref?.();
    });
  }

  get listening() {
    return Boolean(this.#listener);
  }

  get port() {
    return this.#listener?.port;
  }

  /** The bound address: "::" or "0.0.0.0" for every interface (tests bind one). */
  get host() {
    return this.#listener?.host;
  }

  get fingerprint() {
    return this.#identity?.fingerprint ?? "";
  }

  /** Where phones and linked computers can reach this computer now, best first. Empty while off. */
  addresses(): ui.NetworkAddress[] {
    const port = this.#listener?.port;

    if (!port) return [];

    const detected =
      this.options.host && !this.options.detect
        ? [{ host: this.options.host, kind: "lan" as const, interfaceName: "" }]
        : this.#detected;

    return [
      ...detected.map((a) =>
        create(ui.NetworkAddressSchema, {
          origin: originOf(a.host.includes(":") ? `[${a.host}]` : a.host, port),
          host: a.host,
          kind: a.kind,
          interfaceName: a.interfaceName,
        }),
      ),
      ...this.#settings.hostnames.map((entry) =>
        create(ui.NetworkAddressSchema, { origin: originOf(entry, port), host: entry, kind: "hostname" }),
      ),
    ];
  }

  origins() {
    return [...new Set(this.addresses().map((a) => a.origin))];
  }

  status() {
    const note = this.#note();

    return create(ui.NetworkAccessSchema, {
      enabled: this.#settings.enabled,
      state: this.#listener ? "on" : this.#settings.enabled && this.#error ? "error" : "off",
      error: this.#settings.enabled ? this.#error : "",
      port: this.#listener?.port ?? this.options.port ?? this.#settings.port ?? 0,
      portFixed: this.options.port !== undefined,
      addresses: this.addresses(),
      hostnames: this.#settings.hostnames,
      fingerprint: this.fingerprint,
      note,
    });
  }

  onChange(listener: () => void) {
    this.#changes.add(listener);

    return () => void this.#changes.delete(listener);
  }

  update(request: ui.UpdateNetworkAccessRequest) {
    return this.#serial(async () => {
      if (request.action === "set_enabled") {
        this.#settings = { ...this.#settings, enabled: request.enabled };
        await saveSettings(this.options.store, this.#settings);
        await this.#apply();
      } else if (request.action === "set_port" || request.action === "choose_port") {
        await this.#changePort(request.action === "set_port" ? request.port : undefined);
      } else if (request.action === "set_hostnames") {
        const hostnames = [...new Set(request.hostnames.filter((h) => h.trim()).map(hostnameEntry))];

        if (hostnames.length > 8) throw new ConnectError("Add at most 8 hostnames", Code.InvalidArgument);
        this.#settings = { ...this.#settings, hostnames };
        await saveSettings(this.options.store, this.#settings);
        this.#publish();
      } else throw new ConnectError("Unknown network access operation", Code.InvalidArgument);

      return this.status();
    });
  }

  /** A connection to another device failed: on macOS this may be the local network permission. */
  unreachable(host: string, code: SystemCode) {
    if (localNetworkBlocked(host, code, this.#detected)) this.#blockedAt = Date.now();

    return this.#blockedAt > Date.now() - 600_000 ? LOCAL_NETWORK_HELP : "";
  }

  reached() {
    this.#blockedAt = 0;
  }

  /** Re-detects this computer's addresses (a new Wi-Fi, a VPN went up) and tells listeners. */
  refresh() {
    return this.#serial(async () => {
      this.#detected = this.#detect();

      if (this.#settings.enabled && !this.#listener) await this.#apply();
      this.#publish();
    });
  }

  close() {
    clearInterval(this.#timer);

    return this.#serial(async () => {
      await this.#listener?.close();
      this.#listener = undefined;
    });
  }

  #detect() {
    return this.options.detect?.() ?? (this.options.host ? [] : detectAddresses());
  }

  #note() {
    if (this.#blockedAt > Date.now() - 600_000) return LOCAL_NETWORK_HELP;

    if (!this.#listener) return "";

    if (!this.options.host && !this.options.detect && containerBridged() && !this.#settings.hostnames.length)
      return "Canopy runs in a container and can't see this server's addresses. Add the server's hostname or IP address.";

    return this.addresses().length ? "" : "This computer isn't connected to a network right now.";
  }

  /** Opens or closes the listener to match the switch. A failure is kept as the visible error. */
  async #apply() {
    if (!this.#settings.enabled) {
      await this.#listener?.close();
      this.#listener = undefined;
      this.#error = "";
    } else if (!this.#listener) {
      const fixed = this.options.port ?? this.#settings.port ?? undefined;

      try {
        this.#listener = await this.#open(fixed);
        this.#error = "";

        if (fixed === undefined) {
          this.#settings = { ...this.#settings, port: this.#listener.port };
          await saveSettings(this.options.store, this.#settings);
        }
      } catch (error) {
        this.#error = listenError(error instanceof Error ? errorCode(error) : "", fixed ?? 0);
        this.options.log?.(`network access: ${this.#error}`);
      }
    }

    this.#publish();
  }

  /** A fixed port is tried once; otherwise a few random free ones. */
  async #open(port: number | undefined): Promise<Listener> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#listen(port ?? randomPort());
      } catch (error) {
        if (port !== undefined || !(error instanceof Error && errorCode(error) === "EADDRINUSE") || attempt >= 9)
          throw error;
      }
    }
  }

  #listen(port: number) {
    const options = { port, identity: this.#identity!, route: (socket: TLSSocket) => this.#route(socket) };

    return this.options.host ? openListener({ ...options, host: this.options.host }) : openEverywhere(options);
  }

  #route(socket: TLSSocket) {
    if (socket.getPeerCertificate()?.raw && this.role !== "desktop") return undefined;

    return this.#services.get(socket.getPeerCertificate()?.raw ? "link" : "device");
  }

  /** A new port opens before the old one closes, so a busy port changes nothing. */
  async #changePort(requested: number | undefined) {
    if (this.options.port !== undefined)
      throw new ConnectError("This server's configuration sets the port.", Code.FailedPrecondition);

    if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65535))
      throw new ConnectError("Enter a port from 1 to 65535", Code.InvalidArgument);
    let port = requested ?? null;

    if (this.#settings.enabled) {
      if (requested === undefined || requested !== this.#listener?.port) {
        let next: Listener;

        try {
          next = await this.#open(requested);
        } catch (error) {
          throw new ConnectError(
            listenError(error instanceof Error ? errorCode(error) : "", requested ?? 0),
            Code.FailedPrecondition,
          );
        }

        await this.#listener?.close();
        this.#listener = next;
        this.#error = "";
      }

      port = this.#listener!.port;
    }

    this.#settings = { ...this.#settings, port };
    await saveSettings(this.options.store, this.#settings);
    this.#publish();
  }

  #publish() {
    const key = `${this.#listener?.port ?? ""}|${this.origins().join()}|${this.#error}`;

    if (key === this.#published) return;
    this.#published = key;

    for (const listener of this.#changes) listener();
  }

  #serial<A>(run: () => Promise<A>): Promise<A> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});

    return next;
  }
}
