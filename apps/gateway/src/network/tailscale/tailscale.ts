import { localApi, locateTailscale, runCli, type TailscaleAccess, type TailscaleLookup } from "./cli.ts";
import { NOT_INSTALLED, parseStatus, type TailscaleSnapshot } from "./status.ts";

export type TailscaleOptions = TailscaleLookup & {
  /** How long a reading is good for when Settings asks again. */
  ttlMs?: number;
  /** Background refresh: a login, a new tailnet or MagicDNS turned on show up without a restart. */
  pollMs?: number;
  log?: (message: string) => void;
};

/** Read-only view of this host's Tailscale (docs/tailscale.md). Missing, stopped or logged-out
 * Tailscale is a state, never an error: Docker and server gateways simply report "not installed". */
export class Tailscale {
  #snapshot: TailscaleSnapshot = { ...NOT_INSTALLED, checkedAt: 0 };
  #access: TailscaleAccess | undefined;
  #reading: Promise<TailscaleSnapshot> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #key = "";
  readonly #changes = new Set<() => void>();

  constructor(readonly options: TailscaleOptions = {}) {}

  start() {
    this.#timer = setInterval(() => void this.refresh(), this.options.pollMs ?? 30_000);
    this.#timer.unref?.();

    return this.refresh();
  }

  close() {
    clearInterval(this.#timer);
  }

  /** The last reading (a cheap synchronous read for address lists). */
  get snapshot() {
    return this.#snapshot;
  }

  /** The CLI that changes Serve; undefined when only the LocalAPI socket (or nothing) is visible. */
  get cli() {
    return this.#access?.cli;
  }

  onChange(listener: () => void) {
    this.#changes.add(listener);

    return () => void this.#changes.delete(listener);
  }

  /** A reading no older than the cache allows. */
  read() {
    return Date.now() - this.#snapshot.checkedAt < (this.options.ttlMs ?? 5000)
      ? Promise.resolve(this.#snapshot)
      : this.refresh();
  }

  /** Reads Tailscale again now; concurrent callers share one reading. */
  refresh() {
    this.#reading ??= this.#read().finally(() => (this.#reading = undefined));

    return this.#reading;
  }

  async #read() {
    this.#access = locateTailscale(this.options);
    const access = this.#access;

    const result = access?.cli
      ? await runCli(access.cli, ["status", "--json"], { timeoutMs: 5000, ...this.#path() })
      : access?.socket
        ? await localApi(access.socket, "/localapi/v0/status")
        : undefined;

    // No answer (tailscaled down, no permission, a timeout) reads as "not running".
    const snapshot: TailscaleSnapshot = result
      ? parseStatus(result.stdout)
      : { ...NOT_INSTALLED, checkedAt: Date.now() };

    this.#snapshot = snapshot;
    const key = JSON.stringify({ ...snapshot, checkedAt: 0 });

    if (key !== this.#key) {
      if (this.#key) this.options.log?.(`tailscale: ${snapshot.state}`);
      this.#key = key;

      for (const listener of this.#changes) listener();
    }

    return snapshot;
  }

  #path() {
    return this.options.path === undefined ? {} : { path: this.options.path };
  }
}
