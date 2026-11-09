/** In-memory diagnostics only: no credentials, pins, request paths or payloads. */
export type RouteOutcome =
  | "unchecked"
  | "probing"
  | "ok"
  | "dns"
  | "timeout"
  | "pin"
  | "refused"
  | "failed"
  | "canceled";

export interface RouteResult {
  address: string;
  kind: string;
  outcome: RouteOutcome;
  elapsedMs?: number;
  checkedAt?: number;
  phase?: "probe" | "request";
}

export interface RouteSnapshot {
  routes: RouteResult[];
  /** Completed probes only; request failures and a new race never mix with this result. */
  lastRace?: readonly RouteResult[] | undefined;
  active?: string | undefined;
  pending: boolean;
}

export function routeKind(address: string) {
  const host = new URL(address).hostname;
  const parts = host.split(".").map(Number);

  if (
    host.endsWith(".ts.net") ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
    host.startsWith("[fd7a:115c:a1e0:")
  )
    return "Tailscale";

  if (parts.length === 4 && parts.every(Number.isFinite)) {
    if (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    )
      return "LAN";

    return "Public IP";
  }

  return host.startsWith("[") ? "IPv6" : "Hostname";
}

export function routeFailure(code: string): RouteOutcome {
  if (/\bpin\b|Certificate mismatch/i.test(code)) return "pin";

  if (/UnknownHost|ENOTFOUND|EAI_AGAIN|\bDNS\b|NSURLErrorDomain -100[36]\b/i.test(code)) return "dns";

  if (/timeout|timed out|ETIMEDOUT|POSIX 60\b|NSURLErrorDomain -1001\b/i.test(code)) return "timeout";

  if (/ECONNREFUSED|POSIX 61\b|ConnectException|NSURLErrorDomain -1004\b/i.test(code)) return "refused";

  return "failed";
}

export function routeOutcome(result: RouteResult) {
  const ms = Math.round(result.elapsedMs ?? 0).toLocaleString();

  switch (result.outcome) {
    case "unchecked":
      return "Not checked";
    case "probing":
      return "Checking…";
    case "ok":
      return `OK in ${ms} ms`;
    case "dns":
      return "DNS failed";
    case "timeout":
      return `Timed out after ${ms} ms`;
    case "pin":
      return "TLS pin mismatch";
    case "refused":
      return "Connection refused";
    case "canceled":
      return "Check canceled";
    case "failed":
      return result.phase === "request" ? "Request interrupted" : "Connection failed";
  }
}

export class RouteDiagnostics {
  #snapshot: RouteSnapshot;
  readonly #listeners = new Set<() => void>();

  constructor(addresses: string[]) {
    this.#snapshot = {
      routes: addresses.map((address) => ({ address, kind: routeKind(address), outcome: "unchecked" })),
      pending: false,
    };
  }

  snapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };

  update(patch: Partial<RouteSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };

    for (const listener of this.#listeners) listener();
  }

  result(address: string, outcome: RouteOutcome, started: number, phase: "probe" | "request" = "probe") {
    const result: RouteResult = {
      address,
      kind: routeKind(address),
      outcome,
      elapsedMs: Date.now() - started,
      checkedAt: Date.now(),
      phase,
    };

    this.update({
      routes: this.#snapshot.routes.map((route) => (route.address === address ? result : route)),
    });

    return result;
  }

  reset(addresses: string[], active?: string) {
    this.update({
      active,
      pending: false,
      lastRace: undefined,
      routes: addresses.map(
        (address) =>
          this.#snapshot.routes.find((route) => route.address === address) ?? {
            address,
            kind: routeKind(address),
            outcome: "unchecked",
          },
      ),
    });
  }
}

export function connectionReport(snapshot: RouteSnapshot) {
  return [
    `Route in use: ${snapshot.active ? new URL(snapshot.active).host : "None"}`,
    ...snapshot.routes.map(
      (route) =>
        `${route.kind} · ${new URL(route.address).host}: ${routeOutcome(route)}${route.phase === "request" ? " (request)" : ""}${route.checkedAt ? ` · ${new Date(route.checkedAt).toISOString()}` : ""}`,
    ),
  ].join("\n");
}
