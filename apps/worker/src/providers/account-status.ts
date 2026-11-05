import { create } from "@bufbuild/protobuf";
import { ProviderAccountStatusSchema, type ProviderAccountStatus } from "@canopy/contracts";
import { processKey, runProcess, ProcessTimeoutError } from "@canopy/process-governor";
import { accountResult, parseClaudeAccount, parseCodexAccount } from "./account-parser.ts";
import { accountText, sanitizeAccountStatus } from "@canopy/domain/provider-accounts";

export interface AccountQuery {
  harness: "claude" | "codex" | "grok";
  id: string;
  executable: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  args: readonly string[];
  configVersion: bigint;
  secrets: readonly string[];
  proxy?: { name: string; configured: boolean };
  codexMetadata?: () => Promise<{ email: string; plan: string } | undefined>;
}

export const ACCOUNT_STATUS_TTL_MS = 15 * 60_000;

/** Per-worker, per-instance sanitized cache. Reading a view never launches a process. */
export class AccountStatuses {
  readonly #cache = new Map<string, { result: ProviderAccountStatus; until: number }>();
  readonly #flights = new Map<string, Promise<ProviderAccountStatus>>();
  readonly #abort = new AbortController();
  #epoch = 0;

  constructor(
    readonly timeoutMs = 8_000,
    readonly ttlMs = ACCOUNT_STATUS_TTL_MS,
  ) {}

  invalidate(): void {
    this.#epoch++;
    this.#cache.clear();
  }
  async close(): Promise<void> {
    this.#abort.abort();
    this.#cache.clear();
    await Promise.allSettled(this.#flights.values());
  }

  read(query: AccountQuery, refresh = false): Promise<ProviderAccountStatus> {
    const command = {
      argv: [
        query.executable,
        ...query.args,
        query.harness,
        query.id,
        String(query.configVersion),
        String(this.#epoch),
      ],
      env: query.env,
      cwd: query.configDir,
    };

    const key = processKey(command);
    const existing = this.#flights.get(key);

    if (existing) return existing;
    const cached = this.#cache.get(key);

    if (!refresh && cached && cached.until > Date.now())
      return Promise.resolve(create(ProviderAccountStatusSchema, cached.result));
    const epoch = this.#epoch;

    const task = this.#probe(query)
      .catch((error) =>
        accountResult(
          "error",
          query.configDir,
          error instanceof ProcessTimeoutError
            ? "The account check timed out."
            : "Could not read account status from the CLI.",
        ),
      )
      .then((result) => {
        result = sanitizeAccountStatus(result, query.secrets);

        if (!this.#abort.signal.aborted && epoch === this.#epoch) {
          if (this.#cache.size >= 256) this.#cache.delete(this.#cache.keys().next().value!);
          this.#cache.set(key, { result, until: Date.now() + (result.state === "error" ? 60_000 : this.ttlMs) });
        }

        return result;
      })
      .finally(() => this.#flights.delete(key));

    this.#flights.set(key, task);

    return task;
  }

  async #probe(query: AccountQuery): Promise<ProviderAccountStatus> {
    if (query.proxy) {
      const result = accountResult(query.proxy.configured ? "signed_in" : "signed_out", query.configDir);
      result.authMethod = "Proxy";
      result.proxyName = accountText(query.proxy.name, query.secrets);

      return result;
    }

    // CLI availability is reported separately; a missing CLI has no account to read.
    if (!query.executable) return accountResult("unknown", query.configDir);

    // Grok Build 1.0.70 has login/logout but no read-only auth status command, so nothing is launched.
    if (query.harness === "grok") {
      const status = accountResult("unknown", query.configDir);

      if (query.env["XAI_API_KEY"] || query.env["GROK_CODE_XAI_API_KEY"]) status.authMethod = "API key configured";

      return status;
    }

    const commands = { claude: ["auth", "status", "--json"], codex: ["login", "status"] };
    const argv = [query.executable, ...query.args, ...commands[query.harness]];

    const result = await runProcess(
      {
        argv,
        cwd: query.configDir,
        env: query.env,
        timeoutMs: this.timeoutMs,
        maxBytes: 64 * 1024,
        signal: this.#abort.signal,
      },
      { kind: "probe" },
    );

    if (query.harness === "claude") {
      const status = parseClaudeAccount(result.stdout, query.configDir, query.secrets);

      return result.code === 0 || status.state === "signed_out"
        ? status
        : accountResult("error", query.configDir, "Could not read account status from the CLI.");
    }

    const status = parseCodexAccount(result.stdout + "\n" + result.stderr, result.code, query.configDir);

    if (status.state === "signed_in" && status.authMethod === "ChatGPT" && query.codexMetadata) {
      const metadata = await query.codexMetadata().catch(() => undefined);

      if (metadata) {
        status.email = accountText(metadata.email, query.secrets);
        status.plan = accountText(metadata.plan, query.secrets);
      }
    }

    return status;
  }
}
