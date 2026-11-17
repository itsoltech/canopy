import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { USAGE_STATS } from "./capabilities.ts";
import { linkedMessage } from "./remote-policy.ts";
import { computersChannel } from "./runtime-remote.ts";
import { usageCursor, saveUsagePage } from "./usage-store.ts";
import type { LinkedComputers } from "./runtime.ts";

const INTERVAL_MS = 30_000;
const DEADLINE_MS = 15_000;
const PAGE_SIZE = 256;
const MAX_PAGES = 8;
const CONCURRENCY = 2;

type Pending = { controller: AbortController; task: Promise<void> };

/** Incremental accounting is independent of mirrors and never participates in a UI read. */
export class UsageSync {
  readonly #running = new Map<string, Pending>();
  readonly #refresh = new Set<string>();
  readonly #retry = new Map<string, { at: number; failures: number }>();
  #closed = false;

  constructor(readonly host: LinkedComputers) {}

  connected(node: string) {
    this.#retry.delete(node);

    if (this.#running.has(node)) this.#refresh.add(node);
    else this.tick(node);
  }

  tick(node: string) {
    if (
      this.#closed ||
      this.#running.has(node) ||
      this.#running.size >= CONCURRENCY ||
      (this.#retry.get(node)?.at ?? 0) > Date.now() ||
      !computersChannel(this.host, node, USAGE_STATS) ||
      this.host.relay.entries.has(node) ||
      !this.host.hello().capabilities.includes(USAGE_STATS) ||
      !this.host.capabilities(node).includes(USAGE_STATS)
    )
      return;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);

    const task = this.#sync(node, controller.signal)
      .then((hasMore) => {
        this.#retry.set(node, { at: Date.now() + (hasMore ? 0 : INTERVAL_MS), failures: 0 });
      })
      .catch((error) => {
        const failures = Math.min((this.#retry.get(node)?.failures ?? 0) + 1, 6);
        this.#retry.set(node, { at: Date.now() + Math.min(300_000, 5000 * 2 ** (failures - 1)), failures });

        if (!controller.signal.aborted)
          console.warn("Linked usage sync failed", { peer: node, code: ConnectError.from(error).code });
      })
      .finally(() => {
        clearTimeout(deadline);
        this.#running.delete(node);

        if (this.#refresh.delete(node)) this.connected(node);
      });

    this.#running.set(node, { controller, task });
  }

  async #sync(node: string, signal: AbortSignal) {
    let cursor = await usageCursor(this.host.store, node, signal);

    for (let page = 0; page < MAX_PAGES; page++) {
      signal.throwIfAborted();
      const request = create(link.UsageBucketsRequestSchema, { afterRevision: cursor, limit: PAGE_SIZE });
      let response: link.UsageBucketsResponse | undefined;

      for await (const message of this.host.remote(node, link.UsageService.method.getUsageBuckets, request, signal)) {
        if (response) throw new ConnectError("Unexpected usage response", Code.DataLoss);
        response = linkedMessage(link.UsageBucketsResponseSchema, message);
      }

      signal.throwIfAborted();

      if (!response) throw new ConnectError("Missing usage response", Code.DataLoss);
      await saveUsagePage(this.host.store, node, cursor, response, PAGE_SIZE, signal);
      cursor = response.nextRevision;

      if (!response.hasMore) return false;
    }

    return true;
  }

  async close() {
    this.#closed = true;

    for (const { controller } of this.#running.values()) controller.abort();
    await Promise.allSettled([...this.#running.values()].map(({ task }) => task));
    this.#retry.clear();
    this.#refresh.clear();
  }
}
