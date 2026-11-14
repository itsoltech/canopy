import { WEB_MIGRATION_DOCS } from "@canopy/domain/release/web-version";
import { versionAhead } from "../updates/versions.ts";

/** How long a connected web with another version keeps the notice up after its last call. */
const RECENT_MS = 10 * 60 * 1000;
const LOG_EVERY_MS = 60 * 60 * 1000;

/**
 * Web BFFs that call this gateway with the service token and another version (WEB_VERSION_HEADER; none means
 * a BFF older than the header). Typically the retired canopy-web container still running from an old Compose
 * file, frozen at its last release. Logged as a warning and shown next to the gateway in App updates, which
 * that old web app already renders.
 */
export class WebClientVersions {
  readonly #seen = new Map<string, { at: number; logged: number }>();
  constructor(
    readonly version: string,
    readonly embedded: boolean,
    readonly log: (message: string) => void,
  ) {}
  seen(webVersion: string): void {
    if (webVersion === this.version) return;
    const now = Date.now();
    const entry = this.#seen.get(webVersion) ?? { at: now, logged: 0 };
    entry.at = now;
    this.#seen.set(webVersion, entry);

    if (now - entry.logged < LOG_EVERY_MS) return;
    entry.logged = now;
    this.log(`warning: ${this.#describe(webVersion)} ${this.#advice()} ${WEB_MIGRATION_DOCS}`);
  }
  /** One line for App updates while such a web app called recently; "" otherwise. */
  get notice(): string {
    const recent = [...this.#seen].find(([, entry]) => Date.now() - entry.at < RECENT_MS)?.[0];

    return recent === undefined ? "" : `${this.#describe(recent)} ${this.#advice()} ${WEB_MIGRATION_DOCS}`;
  }
  #describe(webVersion: string): string {
    if (!webVersion || versionAhead(this.version, webVersion))
      return `A web app older than the gateway (${webVersion || "before " + this.version}) is connected.`;

    return `A web app of another version (${webVersion}) is connected.`;
  }
  #advice(): string {
    return this.embedded
      ? "Remove the separate web service: the gateway serves the web now."
      : `Run the web app of version ${this.version}.`;
  }
}
