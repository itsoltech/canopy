import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseModelRates, rateHash, type FrozenModelRates } from "./model-rates.ts";

const CATALOG_ROOT = "https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers";

type PricingProvider = "openai" | "xai" | "google" | "anthropic";

type CatalogOptions = { source?: string; now?: () => number };

const DAY = 86_400_000;
const MAX_MODELS = 256;
const MAX_BYTES = 256_000;

const entrySchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/),
  retryAt: z.number().finite(),
  text: z.string().max(MAX_BYTES).optional(),
  sourceDate: z.string().max(128).optional(),
});

const diskSchema = z.object({
  schema: z.literal(1),
  cooldown: z.number().finite(),
  entries: z.array(entrySchema).max(MAX_MODELS),
});

type Entry = z.infer<typeof entrySchema> & { frozen?: FrozenModelRates };

/** Provider-scoped prices, durable misses and backoff survive worker restarts. */
export class ModelPricingCatalog {
  readonly #entries = new Map<string, Entry>();
  readonly #path: string;
  readonly #now: () => number;
  readonly #source: string;
  #cooldown = 0;
  #pending: Promise<void> | undefined;
  #fetchingModel: string | undefined;

  constructor(
    dataDir: string,
    readonly provider: PricingProvider,
    options: CatalogOptions = {},
  ) {
    this.#path = join(dataDir, "pricing", `${provider}.json`);
    this.#source = options.source ?? `${CATALOG_ROOT}/${provider}/models/`;
    this.#now = options.now ?? Date.now;
    this.#restore();
  }

  get(model: string): FrozenModelRates | undefined {
    return this.#entries.get(model)?.frozen;
  }

  now(): number {
    return this.#now();
  }

  async prepare(model: string): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(model)) return;

    if (this.#fetchingModel !== model && (this.#entries.get(model)?.retryAt ?? 0) > this.#now()) return;

    if (!this.#pending && this.#cooldown > this.#now()) return;

    // One fetch at a time across models, and the same in-flight promise for concurrent callers.
    if (this.#pending) {
      await this.#pending;

      return this.prepare(model);
    }

    if ((this.#entries.get(model)?.retryAt ?? 0) > this.#now() || this.#cooldown > this.#now()) return;
    this.#fetchingModel = model;
    this.#pending = this.#refresh(model)
      .catch(() => {})
      .finally(() => {
        this.#pending = undefined;
        this.#fetchingModel = undefined;
      });
    await this.#pending;
  }

  #freeze(entry: Entry): void {
    if (!entry.text || !entry.sourceDate) return;
    entry.frozen = {
      model: entry.id,
      source: `${this.#source}${entry.id}.toml`,
      sourceDate: entry.sourceDate,
      hash: rateHash(entry.text),
      rates: parseModelRates(entry.text, this.provider),
    };
  }

  async #refresh(id: string): Promise<void> {
    const entry = this.#entries.get(id) ?? { id, retryAt: 0 };
    entry.retryAt = this.#now() + 300_000;
    this.#cooldown = entry.retryAt;
    this.#entries.delete(id);
    this.#entries.set(id, entry);

    while (this.#entries.size > MAX_MODELS) this.#entries.delete(this.#entries.keys().next().value!);
    this.#save(); // Persist before I/O: a process interruption must not reset failure backoff.

    try {
      const response = await fetch(`${this.#source}${id}.toml`, {
        signal: AbortSignal.timeout(4000),
        redirect: "error",
      });

      if (!response.ok) await response.body?.cancel();

      if (response.status === 404) {
        entry.retryAt = this.#now() + DAY;
        this.#cooldown = 0;

        return;
      }

      if (!response.ok) throw new Error("catalog unavailable");
      const text = await boundedText(response);

      const candidate: Entry = {
        id,
        retryAt: this.#now() + DAY,
        text,
        sourceDate: response.headers.get("last-modified")?.slice(0, 128) ?? new Date(this.#now()).toISOString(),
      };

      this.#freeze(candidate);
      this.#entries.set(id, candidate);
      this.#cooldown = 0;
    } catch {
      // A missing or broken catalog never fails inference; last-good rates remain usable.
    } finally {
      this.#save();
    }
  }

  #restore(): void {
    try {
      const file = readFileSync(this.#path, "utf8");

      if (file.length > MAX_MODELS * MAX_BYTES + 100_000) return;
      const disk = diskSchema.parse(JSON.parse(file));
      this.#cooldown = disk.cooldown;

      for (const saved of disk.entries) {
        const entry: Entry = saved;

        try {
          this.#freeze(entry);
        } catch {
          entry.text = undefined;
        }

        this.#entries.set(entry.id, entry);
      }
    } catch {
      // A fresh worker or corrupt optional cache simply starts with no quotes.
    }
  }

  #save(): void {
    try {
      mkdirSync(join(this.#path, ".."), { recursive: true, mode: 0o700 });

      const entries = [...this.#entries.values()].map(({ id, retryAt, text, sourceDate }) => ({
        id,
        retryAt,
        text,
        sourceDate,
      }));

      writeFileSync(`${this.#path}.tmp`, JSON.stringify({ schema: 1, cooldown: this.#cooldown, entries }), {
        mode: 0o600,
      });
      renameSync(`${this.#path}.tmp`, this.#path);
    } catch {
      // Read-only storage must not prevent a turn; the process still retains its bounded cache.
    }
  }
}

export class OpenAiPricingCatalog extends ModelPricingCatalog {
  constructor(dataDir: string, options: CatalogOptions = {}) {
    super(dataDir, "openai", options);
  }
}

export class XaiPricingCatalog extends ModelPricingCatalog {
  constructor(dataDir: string, options: CatalogOptions = {}) {
    super(dataDir, "xai", options);
  }
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();

  if (!reader) throw new Error("empty catalog");
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > MAX_BYTES) throw new Error("catalog too large");
      chunks.push(chunk.value);
    }

    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}
