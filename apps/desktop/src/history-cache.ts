import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { bots, ui } from "@canopy/contracts";
import { botViewOwners } from "@canopy/domain/bot-cache";

export const historyLimits = { count: 32, bytes: 96 * 1024 * 1024, entry: 16 * 1024 * 1024 };
const keyPattern = /^(thread|chat|exchange)_([a-f0-9-]{36}(?:~[a-f0-9]{16})?)$/;

/** Only public protobuf projections cross this boundary; unknown fields are discarded before persistence. */
function projection(key: string, bytes: Uint8Array) {
  const match = keyPattern.exec(key);

  if (!match || bytes.byteLength > historyLimits.entry) throw new Error("Invalid history entry");

  if (match[1] === "thread") {
    const value = fromBinary(ui.ThreadSnapshotSchema, bytes, { readUnknownFields: false });

    if (!value.thread || value.thread.id !== match[2] || value.thread.deletedAt)
      throw new Error("Invalid thread history");

    return toBinary(ui.ThreadSnapshotSchema, value);
  }

  const value = fromBinary(bots.BotCachedViewSchema, bytes, { readUnknownFields: false });

  if (value.key !== key || (match[1] === "chat" && (!value.conversation?.bot || value.conversation.bot.archived)))
    throw new Error("Invalid bot history");

  return toBinary(bots.BotCachedViewSchema, value);
}

/** Private app data, bounded LRU and a generation fence for mode changes/revocation. */
export class DesktopHistoryCache {
  #generation = crypto.randomUUID();
  #work: Promise<void> = Promise.resolve();

  constructor(
    readonly directory: string,
    readonly limits = historyLimits,
  ) {}

  read(key: string) {
    const generation = this.#generation;

    return this.#serial(async () => {
      if (!keyPattern.test(key)) throw new Error("Invalid history key");
      await this.#trim();
      let bytes: Uint8Array | undefined;

      try {
        bytes = projection(key, await readFile(join(this.directory, `${key}.bin`)));
        const now = new Date();
        await utimes(join(this.directory, `${key}.bin`), now, now);
      } catch {
        await rm(join(this.directory, `${key}.bin`), { force: true });
      }

      return { generation, bytes: generation === this.#generation ? bytes : undefined };
    });
  }

  write(generation: string, key: string, value: Uint8Array) {
    const bytes = projection(key, value);

    return this.#serial(async () => {
      if (generation !== this.#generation) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, "pending"), bytes, { mode: 0o600 });
      await rename(join(this.directory, "pending"), join(this.directory, `${key}.bin`));
      await this.#trim();
    });
  }

  remove(key: string) {
    if (!keyPattern.test(key)) throw new Error("Invalid history key");

    return this.#serial(() => rm(join(this.directory, `${key}.bin`), { force: true }));
  }

  reconcileBots(generation: string, availableIds: string[]) {
    return this.#serial(async () => {
      if (generation !== this.#generation) return;
      await this.#trim();
      const available = new Set(availableIds);

      for (const name of await readdir(this.directory)) {
        const key = name.replace(/\.bin$/, "");

        if (!/^(chat|exchange)_/.test(key) || !keyPattern.test(key)) continue;
        let keep = false;

        try {
          const view = fromBinary(bots.BotCachedViewSchema, await readFile(join(this.directory, name)));
          keep = botViewOwners(view).every((id) => available.has(id));
        } catch {
          // Corrupt projections are removed with unavailable bots.
        }

        if (!keep) await rm(join(this.directory, name), { force: true });
      }
    });
  }

  clear() {
    this.#generation = crypto.randomUUID();

    return this.#serial(() => rm(this.directory, { recursive: true, force: true }));
  }

  async #trim() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = await readdir(this.directory);

    const entries = await Promise.all(
      names
        .filter((name) => keyPattern.test(name.replace(/\.bin$/, "")))
        .map(async (name) => ({ name, ...(await stat(join(this.directory, name))) })),
    );

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    let count = 0;

    for (const entry of entries) {
      if (entry.size > this.limits.entry || count >= this.limits.count || bytes + entry.size > this.limits.bytes)
        await rm(join(this.directory, entry.name), { force: true });
      else {
        bytes += entry.size;
        count++;
      }
    }
  }

  #serial<T>(run: () => Promise<T>) {
    const result = this.#work.then(run, run);
    this.#work = result.then(
      () => {},
      () => {},
    );

    return result;
  }
}
