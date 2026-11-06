import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { bots } from "@canopy/contracts";
import { BotViewCache, botCacheLimits, botViewOwners } from "@canopy/domain/bot-cache";
import type { ThreadCacheStorage, CacheFile } from "./thread-cache";
import { clearPairingCache } from "./thread-cache";

/** Start both close fences synchronously, before awaiting either disk deletion or credential removal. */
export function clearPairedHistory(
  caches: readonly ({ close(): Promise<void> } | null)[],
  forget: () => Promise<void>,
) {
  return clearPairingCache(
    {
      close: async () => {
        await Promise.all(caches.map((cache) => cache?.close()));
      },
    },
    forget,
  );
}

/** Bot chats/exchanges share a separate 16-view/32 MiB disk budget. Pairing owns the lifetime fence. */
export class PersistentBotCache {
  #memory = new BotViewCache({ count: 6, bytes: 16 * 1024 * 1024, entry: botCacheLimits.entry });
  #writing: Promise<void> = Promise.resolve();
  #closed = false;
  #available: Set<string> | undefined;

  constructor(
    readonly storage: ThreadCacheStorage,
    readonly limits = botCacheLimits,
  ) {}

  peek(key: string) {
    return this.#closed ? undefined : this.#memory.get(key);
  }

  load(key: string): Promise<bots.BotCachedView | undefined> {
    return this.#serial(async () => {
      if (this.#closed) return undefined;
      const cached = this.peek(key);
      const entry = (await this.#trim()).find((file) => file.id === key);

      if (cached) {
        if (entry) await this.storage.touch(entry.name, key);

        return cached;
      }

      if (!entry) return undefined;

      try {
        const bytes = await this.storage.read(entry.name);
        const view = fromBinary(bots.BotCachedViewSchema, bytes);

        if (view.key !== key || !validView(view) || !this.#allowed(view)) throw new Error("Invalid cached bot view");

        if (this.#closed) return undefined;
        this.#memory.set(view, bytes.length);
        await this.storage.touch(entry.name, key);

        return view;
      } catch {
        await this.storage.remove(entry.name);

        return undefined;
      }
    });
  }

  save(view: bots.BotCachedView): Promise<void> {
    if (this.#closed) return Promise.resolve();

    if (!validView(view)) return Promise.resolve();

    if (!this.#allowed(view)) return this.delete(view.key);
    const bytes = toBinary(bots.BotCachedViewSchema, view);
    this.#memory.set(view, bytes.length);

    return this.#serial(async () => {
      if (this.#closed || !this.#allowed(view)) return;
      const previous = (await this.storage.list()).filter((file) => file.id === view.key);

      if (bytes.length <= this.limits.entry && bytes.length <= this.limits.bytes)
        await this.storage.write(view.key, bytes);

      for (const file of previous) await this.storage.remove(file.name);
      await this.#trim();
    });
  }

  delete(key: string): Promise<void> {
    this.#memory.delete(key);

    return this.#serial(async () => {
      for (const file of await this.storage.list()) if (file.id === key) await this.storage.remove(file.name);
    });
  }

  reconcile(list: readonly bots.Bot[]): Promise<void> {
    const available = new Set(list.flatMap((bot) => (bot.archived ? [] : [bot.id])));

    if (this.#available?.size === available.size && [...available].every((id) => this.#available?.has(id)))
      return Promise.resolve();
    this.#available = available;
    this.#memory.reconcile(list);

    return this.#serial(async () => {
      for (const file of await this.storage.list()) {
        try {
          const view = fromBinary(bots.BotCachedViewSchema, await this.storage.read(file.name));

          if (!this.#allowed(view)) await this.storage.remove(file.name);
        } catch {
          await this.storage.remove(file.name);
        }
      }
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#memory.clear();

    return this.#serial(() => this.storage.clear());
  }

  #allowed(view: bots.BotCachedView) {
    const participants = view.conversation?.bot ? [view.conversation.bot] : (view.exchange?.participants ?? []);
    const available = this.#available;

    return (
      !participants.some((bot) => bot.archived) && (!available || botViewOwners(view).every((id) => available.has(id)))
    );
  }

  async #trim() {
    const files = (await this.storage.list()).sort((a, b) => b.accessed - a.accessed);
    const kept: CacheFile[] = [];
    let bytes = 0;

    for (const file of files) {
      if (
        file.bytes > this.limits.entry ||
        kept.length >= this.limits.count ||
        bytes + file.bytes > this.limits.bytes ||
        kept.some((entry) => entry.id === file.id)
      )
        await this.storage.remove(file.name);
      else {
        kept.push(file);
        bytes += file.bytes;
      }
    }

    return kept;
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#writing.then(run, run);
    this.#writing = next.then(
      () => {},
      () => {},
    );

    return next;
  }
}

function validView(view: bots.BotCachedView) {
  if (!/^(chat|exchange)_[a-z0-9_~-]+$/.test(view.key)) return false;

  return view.conversation
    ? !view.exchange && view.key === `chat_${view.conversation.bot?.id}`
    : !!view.exchange && view.key.startsWith("exchange_");
}
