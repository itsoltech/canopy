import { Provider } from "@canopy/contracts";

import { secureUrl } from "@canopy/updater";

import { Predicate, Schema } from "effect";

/**
 * Provider CLIs on the owner's workers (docs/provider-cli.md). Workers report what is installed and how
 * (CliToolsReport, kept in workers.capabilities.cliTools); the gateway learns the latest version of each CLI from its
 * official source, decides what may be offered, and on the owner's click sends InstallCli to the worker. Every rule
 * the UI shows is enforced here too: owner only, online, the worker has a recipe for the install method (never for
 * Homebrew, version managers or a container image), no running turns of that provider, one install at a time.
 */

/** Official sources of the latest version (plain text version, or npm dist-tags JSON). */
export const CLI_LATEST_SOURCES: Readonly<Record<CliKey, string>> = {
  // The native installer's channel pointer (what `claude install latest` installs).
  claude: "https://downloads.claude.ai/claude-code-releases/latest",
  codex: "https://registry.npmjs.org/-/package/@openai/codex/dist-tags",
  // The official installer's stable channel (https://x.ai/cli/install.sh).
  grok: "https://x.ai/cli/stable",
};

export type CliKey = "claude" | "codex" | "grok";

export const KEYS: readonly [CliKey, Provider][] = [
  ["claude", Provider.CLAUDE],
  ["codex", Provider.CODEX],
  ["grok", Provider.GROK],
];

export const keyOf = (provider: Provider) => KEYS.find(([, p]) => p === provider)?.[0];

export const CLI_CACHE_MS = 6 * 60 * 60_000;

export const FETCH_TIMEOUT_MS = 15_000;

export const BODY_LIMIT = 256 * 1024;

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface CliLatestOptions {
  /** Test-only: other source URLs (a local server); never read from the environment. */
  readonly sources?: Partial<Record<CliKey, string>>;
  readonly allowHttpForTests?: boolean;
  readonly cacheMs?: number;
}

export interface Latest {
  version: string;
  error: string;
  checkedAt: number;
}

/** Latest versions with a cache; a failed check keeps the previous version and says why. Never blocks a caller. */
export class CliLatestSource {
  readonly #options: CliLatestOptions;
  readonly #latest = new Map<CliKey, Latest>();
  #refreshing: Promise<boolean> | undefined;

  constructor(options: CliLatestOptions = {}) {
    this.#options = options;
  }

  get(provider: Provider): Latest | undefined {
    const key = keyOf(provider);

    return key ? this.#latest.get(key) : undefined;
  }

  stale(): boolean {
    const now = Date.now();

    return KEYS.some(
      ([key]) => (this.#latest.get(key)?.checkedAt ?? 0) + (this.#options.cacheMs ?? CLI_CACHE_MS) < now,
    );
  }

  /** Checks every source (concurrent calls share one check); true when something changed. */
  refresh(): Promise<boolean> {
    this.#refreshing ??= (async () => {
      try {
        const results = await Promise.all(KEYS.map(async ([key]) => [key, await this.#check(key)] as const));
        let changed = false;

        for (const [key, result] of results) {
          const previous = this.#latest.get(key);

          const next: Latest = {
            version: result.version || previous?.version || "",
            error: result.error,
            checkedAt: Date.now(),
          };

          changed ||= previous?.version !== next.version || previous?.error !== next.error;
          this.#latest.set(key, next);
        }

        return changed;
      } finally {
        this.#refreshing = undefined;
      }
    })();

    return this.#refreshing;
  }

  async #check(key: CliKey): Promise<{ version: string; error: string }> {
    try {
      const allowHttp = this.#options.allowHttpForTests === true;
      const url = secureUrl(this.#options.sources?.[key] ?? CLI_LATEST_SOURCES[key], allowHttp);

      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/json, text/plain" },
      });

      secureUrl(response.url || url.href, allowHttp);

      if (!response.ok) return { version: "", error: `${url.host} answered ${response.status}` };
      const body = await response.text();

      if (body.length > BODY_LIMIT) return { version: "", error: `${url.host} sent an unexpected answer` };
      let version = body.trim().split("\n")[0]?.trim() ?? "";

      if (body.trimStart().startsWith("{")) {
        const tags = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(body));
        version = Predicate.isString(tags["latest"]) ? tags["latest"] : "";
      }

      return SEMVER.test(version) ? { version, error: "" } : { version: "", error: `${url.host} sent no version` };
    } catch (error) {
      return {
        version: "",
        error:
          error instanceof Error && error.name === "TimeoutError"
            ? "the source did not answer in time"
            : "the source could not be reached",
      };
    }
  }
}
