import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ImportRootSchema, ImportScanSchema } from "@canopy/contracts";
import type { AppliedConfig } from "../config/remote.ts";
import { loadMasker, type Masker } from "./masking.ts";
import { scanClaude } from "./scan-claude.ts";
import { scanCodex } from "./scan-codex.ts";
import { scanGrok } from "./scan-grok.ts";
import type { ScanContext, SummaryInit } from "./scan-types.ts";
import { importKey, rootId, type AgentCli, type ImportRootPath } from "./source-key.ts";

/** Limits of one scan (docs/import.md, "Limity"). */
export const SCAN_LIMITS = { maxThreads: 20_000, millisPerCli: 20_000 } as const;

const CLIS: readonly AgentCli[] = ["claude", "codex", "grok"];

const SCANNERS = { claude: scanClaude, codex: scanCodex, grok: scanGrok } satisfies Record<
  AgentCli,
  (root: ImportRootPath, context: ScanContext) => Generator<SummaryInit>
>;

export interface ImportHomes {
  readonly claude: string;
  readonly codex: string;
  readonly grok: string;
}

type RootInit = MessageInitShape<typeof ImportRootSchema>;

/**
 * The worker side of the CLI import (docs/import.md). Roots come only from this worker: the device owner's CLI
 * homes and the home paths of its provider instances. Nothing here writes to them.
 */
export class WorkerImport {
  readonly #dataDir: string;
  readonly #homes: () => ImportHomes;
  readonly #config: () => AppliedConfig | undefined;
  #key: Buffer | undefined;

  constructor(options: { dataDir: string; homes: () => ImportHomes; config: () => AppliedConfig | undefined }) {
    this.#dataDir = options.dataDir;
    this.#homes = options.homes;
    this.#config = options.config;
  }

  get key(): Buffer {
    this.#key ??= importKey(this.#dataDir);

    return this.#key;
  }

  /** Existing CLI homes, by real path and without duplicates; plus the ones that are missing (with a problem). */
  roots(only: readonly string[] = []) {
    const homes = this.#homes();
    const config = this.#config();
    const roots: ImportRootPath[] = [];
    const listed: RootInit[] = [];
    const seen = new Set<string>();

    for (const cli of CLIS) {
      if (only.length > 0 && !only.includes(cli)) continue;

      const paths = [
        homes[cli],
        ...(config?.profiles ?? []).flatMap((p) =>
          (p.config.providers ?? ["claude", "codex"]).includes(cli) && p.config.runtime?.homePath
            ? [p.config.runtime.homePath]
            : [],
        ),
      ];

      for (const path of paths) {
        const real = realDirectory(path);
        const cliVersion = config?.[cli].version ?? "";

        if (!real) {
          if (!seen.has(`${cli}\0${path}`))
            listed.push({ id: "", agentCli: cli, path, cliVersion, problem: "Directory not found" });
          seen.add(`${cli}\0${path}`);
          continue;
        }

        if (seen.has(`${cli}\0${real}`)) continue;
        seen.add(`${cli}\0${real}`);
        const root = { id: rootId(this.key, cli, real), agentCli: cli, path: real };
        roots.push(root);
        listed.push({ id: root.id, agentCli: cli, path: real, cliVersion, problem: "" });
      }
    }

    return { roots, listed };
  }

  masker(roots: readonly ImportRootPath[]): Masker {
    const extra = (this.#config()?.profiles ?? []).flatMap((p) => (p.config.env ?? []).map((v) => v.value));

    return loadMasker(roots, extra, homedir());
  }

  async scan(agentClis: readonly string[], now = Date.now): Promise<MessageInitShape<typeof ImportScanSchema>> {
    const { roots, listed } = this.roots(agentClis);
    // Secrets of every CLI home count: a Codex token may appear in a Claude session.
    const masker = this.masker(this.roots().roots);
    const threads: SummaryInit[] = [];
    let truncated = false;
    let skipped = 0;
    // Many sessions share a directory: each is checked once per scan.
    const known = new Map<string, boolean>();

    const exists = (path: string) => {
      let found = known.get(path);

      if (found === undefined) known.set(path, (found = existsSync(path)));

      return found;
    };

    for (const root of roots) {
      const deadline = now() + SCAN_LIMITS.millisPerCli;

      const context: ScanContext = {
        key: this.key,
        masker,
        exists,
        skipped: 0,
        full: () => {
          const full = threads.length >= SCAN_LIMITS.maxThreads || now() > deadline;
          truncated ||= full;

          return full;
        },
      };

      const scanner = SCANNERS[root.agentCli];

      for (const thread of scanner(root, context)) {
        threads.push(thread);

        // A long scan must not hold up the gateway link (heartbeats, other commands).
        if (threads.length % 50 === 0) await Bun.sleep(0);
      }

      skipped += context.skipped;
    }

    return { roots: listed, threads, truncated, skipped };
  }
}

function realDirectory(path: string): string | undefined {
  try {
    const real = realpathSync(path);

    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}
