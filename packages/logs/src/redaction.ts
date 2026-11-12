import type { LogSource } from "./limits.ts";

/** Local logs retain readable context. Export uses closed templates, never this blacklist alone. */
export class LogRedactor {
  readonly #secrets = new Set<string>();
  #bytes = 0;
  #exhausted = false;
  protect(...values: string[]) {
    for (const value of values) {
      if (value.length < 8 || this.#secrets.has(value)) continue;

      if (this.#secrets.size >= 256 || this.#bytes + value.length * 2 > 64 * 1024) {
        this.#exhausted = true;
        continue;
      }

      this.#secrets.add(value);
      this.#bytes += value.length * 2;
    }
  }
  redact(line: string) {
    if (this.#exhausted) return "[record omitted: secret registry limit]";

    for (const value of this.#secrets) line = line.replaceAll(value, "[REDACTED]");

    return (
      line
        // oxlint-disable-next-line no-control-regex -- Remove terminal escapes before writing untrusted process output.
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        // oxlint-disable-next-line no-control-regex -- Strip control bytes so records cannot forge terminal or log boundaries.
        .replace(/[\r\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
        .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
        .replace(
          /((?:credential|password|api[_-]?key|token|secrets[_-]?key|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
          "$1[REDACTED]",
        )
        .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s"'<>]+/gi, "[address]")
    );
  }
}

const events = [
  [
    "process_started",
    /^(?:Canopy (?:gateway|worker)|gateway listening|worker connected|Server listening|Listening on|database system is ready to accept connections)\b/i,
  ],
  ["process_stopped", /^(?:Process exited|gateway stopping|worker stopping|database system is shut down)\b/i],
  [
    "process_restarting",
    /^(?:Restarting owned process|Restart budget exhausted|Liveness restart canceled|Could not announce the health restart)\b/i,
  ],
  ["migration_applied", /^migrations applied:/i],
  ["link_changed", /^(?:Computer link (?:closing|connected)|worker (?:disconnected|reconnected))\b/i],
  ["health_check", /^(?:healthcheck|health check|liveness check)\b/i],
  ["diagnostics_saved", /^diagnostics (?:history|rollup|collection) (?:saved|completed|omitted)\b/i],
  ["startup_recovery", /^Web application unavailable; showing startup recovery$/],
] as const;

/** Only closed event templates leave the source. No message, stack, cause, name, SQL or arbitrary JSON. */
export function exportedRecord(line: string, source: LogSource, at: number, legacy: boolean) {
  // oxlint-disable-next-line no-control-regex -- Export recognises templates only after removing terminal escapes.
  const message = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();

  if (/\b(?:STATEMENT|DETAIL|CONTEXT|parameters|stack|cause)\s*[:=]/i.test(message)) return undefined;
  const event = events.find(([, pattern]) => pattern.test(message))?.[0];

  if (
    !event &&
    source === "postgres" &&
    /^(?:\d{4}-\d\d-\d\d[^\n]*?\s)?(?:\[\d+\]\s*)?(?:LOG|WARNING|ERROR|FATAL):\s/i.test(message)
  )
    return JSON.stringify({ at, source, event: "postgres_status", legacy }) + "\n";

  return event ? JSON.stringify({ at, source, event, legacy }) + "\n" : undefined;
}
