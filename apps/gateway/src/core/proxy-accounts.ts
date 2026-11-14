import { createHash } from "node:crypto";
import { create, equals } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { GatewayCore } from "./core.ts";
import { coreState } from "./core-context.ts";
import { coreInstances } from "./core-providers.ts";
import { readProxyAccounts } from "../proxies/management.ts";

/** A view that opens reuses a read this recent. */
const FRESH_MS = 60_000;

/** A Refresh button reads again at most this often. */
const FORCE_MS = 5_000;

/** Proxies in use are checked this often, with backoff after failures. */
export const PROXY_CHECK_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

/**
 * States that wait for a new key or a Refresh: CLIProxyAPI bans an address for 30 minutes after five wrong
 * management keys, so a rejected key is never retried on its own.
 */
const WAITING = new Set(["no_key", "unauthorized", "remote_disabled"]);

interface Entry {
  value: ui.ProxyAccounts;
  /** Hash of the root and key the value was read with; a new key or URL reads again. */
  identity: string;
  at: number;
  failures: number;
  next: number;
}

const sameAccounts = (a: ui.ProxyAccounts, b: ui.ProxyAccounts) =>
  equals(ui.ProxyAccountsSchema, { ...a, checkedAt: undefined }, { ...b, checkedAt: undefined });

/**
 * Upstream accounts of the owner's CLIProxyAPI proxies (docs/proxies.md, "Konta upstream"). Volatile: kept in
 * memory, never logged. The management key is decrypted per read and leaves the gateway only in that request's
 * header. A changed value reaches clients as `OverviewUpdate.proxy_accounts` for that proxy alone.
 */
export class ProxyAccountsMonitor {
  readonly #entries = new Map<string, Entry>();
  readonly #flights = new Map<string, Promise<ui.ProxyAccounts>>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly core: GatewayCore) {}

  start(intervalMs = PROXY_CHECK_MS): void {
    this.#timer ??= setInterval(() => void this.check().catch(() => {}), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  decorate(proxies: ui.Proxy[]): ui.Proxy[] {
    for (const proxy of proxies) proxy.accounts = this.#entries.get(proxy.id)?.value;

    return proxies;
  }

  forget(id: string): void {
    this.#entries.delete(id);
  }

  /** Owner-scoped: an unknown or foreign id fails as not found before anything is sent. */
  async refresh(id: string, force = false): Promise<ui.ProxyAccounts> {
    const owner = this.core[coreState].options.userId;
    const target = await coreInstances(this.core, (s) => s.proxyManagement(owner, id));
    const identity = createHash("sha256").update(target.root).update("\0").update(target.key).digest("hex");
    const entry = this.#entries.get(id);

    if (entry?.identity === identity) {
      const now = Date.now();
      const age = now - entry.at;

      if (force ? age < FORCE_MS : age < FRESH_MS || WAITING.has(entry.value.state) || now < entry.next)
        return entry.value;
    }

    const running = this.#flights.get(id);

    if (running) return running;

    const flight = readProxyAccounts(id, target.root, target.key)
      .then((value) => this.#store(id, identity, value))
      .finally(() => this.#flights.delete(id));

    this.#flights.set(id, flight);

    return flight;
  }

  /** The periodic check: proxies with a management key that a profile uses, one at a time. */
  async check(): Promise<void> {
    const owner = this.core[coreState].options.userId;
    const ids = await coreInstances(this.core, (s) => s.managedProxies(owner));

    for (const id of ids) await this.refresh(id).catch(() => {});
  }

  #store(id: string, identity: string, value: ui.ProxyAccounts): ui.ProxyAccounts {
    const previous = this.#entries.get(id);
    const failed = !["ok", ...WAITING].includes(value.state);
    const failures = failed ? (previous?.identity === identity ? previous.failures : 0) + 1 : 0;
    const at = Date.now();
    const delay = failed ? Math.min(PROXY_CHECK_MS * 2 ** (failures - 1), MAX_BACKOFF_MS) : PROXY_CHECK_MS;

    this.#entries.set(id, { value, identity, at, failures, next: at + delay });

    if (!previous || !sameAccounts(previous.value, value))
      this.core.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "proxyAccounts", value } }));

    return value;
  }
}
