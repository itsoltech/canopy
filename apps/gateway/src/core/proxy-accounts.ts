import { create, equals } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import { coreInstances } from "./core-providers.ts";
import { readProxyAccounts } from "../proxies/management.ts";
import type { ProxyTarget } from "../store/proxy-management.ts";

/** A view that opens, or another gateway process, reuses a read this recent. */
const FRESH_MS = 60_000;

/** A Refresh button reads again at most this often. */
const FORCE_MS = 5_000;

/** Proxies in use are checked this often, with backoff after failures. */
export const PROXY_CHECK_MS = 5 * 60_000;
const FIRST_CHECK_MS = 15_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * States that wait for a new key or a Refresh: CLIProxyAPI bans an address for 30 minutes after five wrong
 * management keys, so a rejected key is never retried on its own. The state is stored with the key's identity, so
 * this holds across restarts and gateway processes.
 */
const WAITING = new Set(["no_key", "unauthorized", "remote_disabled"]);

const sameAccounts = (a: ui.ProxyAccounts | undefined, b: ui.ProxyAccounts) =>
  !!a && equals(ui.ProxyAccountsSchema, { ...a, checkedAt: undefined }, { ...b, checkedAt: undefined });

const ageOf = (accounts: ui.ProxyAccounts | undefined) =>
  accounts?.checkedAt ? Date.now() - Number(accounts.checkedAt.seconds) * 1000 : Infinity;

/**
 * Upstream accounts of the owner's CLIProxyAPI proxies (docs/proxies.md, "Konta upstream"). The last sanitized read
 * is stored with the proxy; a lease in the same row spaces reads across processes. The management key is decrypted
 * per read and leaves the gateway only in that request's header. A changed value reaches clients as
 * `OverviewUpdate.proxy_accounts` for that proxy alone.
 */
export class ProxyAccountsMonitor {
  readonly #flights = new Map<string, Promise<ui.ProxyAccounts>>();
  /** Failed reads in a row per proxy and identity: the periodic check backs off after them. */
  readonly #failures = new Map<string, { identity: string; count: number }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #first: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly core: GatewayCore) {}

  /** The first check follows startup shortly, so the sidebar has proxy accounts without opening settings. */
  start(intervalMs = PROXY_CHECK_MS): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.check().catch(() => {}), intervalMs);
    this.#first = setTimeout(() => void this.check().catch(() => {}), Math.min(intervalMs, FIRST_CHECK_MS));
    this.#timer.unref?.();
    this.#first.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    clearTimeout(this.#first);
    this.#timer = undefined;
    this.#first = undefined;
  }

  /** Owner-scoped: an unknown or foreign id fails as not found before anything is sent. */
  async refresh(id: string, force = false): Promise<ui.ProxyAccounts> {
    const owner = this.core[coreState].options.userId;
    const target = await coreInstances(this.core, (s) => s.proxyManagement(owner, id));

    if (!target.key) return create(ui.ProxyAccountsSchema, { proxyId: id, state: "no_key" });
    const last = target.last;

    if (!force && last && (WAITING.has(last.state) || ageOf(last) < this.#delay(id, target.identity, last.state)))
      return last;

    const running = this.#flights.get(id);

    if (running) return running;

    // Register before awaiting the lease, so another caller joins instead of returning its stale snapshot.
    const flight = this.#read(id, target, force).finally(() => this.#flights.delete(id));
    this.#flights.set(id, flight);

    return flight;
  }

  async #read(id: string, target: ProxyTarget, force: boolean): Promise<ui.ProxyAccounts> {
    const owner = this.core[coreState].options.userId;
    const spacing = force ? FORCE_MS : FRESH_MS;
    const claimed = await coreInstances(this.core, (s) => s.claimProxyRead(owner, id, target.identity, spacing));

    if (!claimed) {
      // The read that held the lease may have finished while our target lookup was still in flight.
      const current = await coreInstances(this.core, (s) => s.proxyManagement(owner, id));

      return current.last ?? create(ui.ProxyAccountsSchema, { proxyId: id });
    }

    const value = await readProxyAccounts(id, target.root, target.key, [target.secret]);

    return this.#store(id, target.identity, target.last, value);
  }

  /** The periodic check: proxies with a management key that a profile uses, one at a time. */
  async check(): Promise<void> {
    const owner = this.core[coreState].options.userId;
    const ids = await coreInstances(this.core, (s) => s.managedProxies(owner));

    for (const id of ids) await this.refresh(id).catch(() => {});
  }

  /** How old a read may be before an automatic one: fresh after success, backing off after failures. */
  #delay(id: string, identity: string, state: string): number {
    if (state === "ok") return FRESH_MS;
    const failures = this.#failures.get(id);
    const count = failures?.identity === identity ? failures.count : 1;

    return Math.min(PROXY_CHECK_MS * 2 ** (count - 1), MAX_BACKOFF_MS);
  }

  async #store(id: string, identity: string, last: ui.ProxyAccounts | undefined, value: ui.ProxyAccounts) {
    const owner = this.core[coreState].options.userId;
    const failed = !["ok", ...WAITING].includes(value.state);
    const previous = this.#failures.get(id);

    if (failed) this.#failures.set(id, { identity, count: (previous?.identity === identity ? previous.count : 0) + 1 });
    else this.#failures.delete(id);

    await coreInstances(this.core, (s) => s.storeProxyAccounts(owner, id, identity, value));

    if (!sameAccounts(last, value))
      this.core.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "proxyAccounts", value } }));

    return value;
  }
}
