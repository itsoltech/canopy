import { Schema } from "effect";

/** SQL still validates every read; this LRU only avoids reparsing the same verified JSON generation. */
export class GitHubMemoryCache {
  #entries = new Map<string, { generation: bigint; text: string; value: Schema.JsonObject; bytes: number }>();
  #bytes = 0;

  clear(prefix = "") {
    for (const [key, entry] of this.#entries) {
      if (!key.startsWith(prefix)) continue;
      this.#bytes -= entry.bytes;
      this.#entries.delete(key);
    }
  }

  read(key: string, generation: bigint, text: string | null) {
    const previous = this.#entries.get(key);

    if (text && previous?.generation === generation && previous.text === text) {
      this.#entries.delete(key);
      this.#entries.set(key, previous);

      return previous.value;
    }

    if (previous) {
      this.#bytes -= previous.bytes;
      this.#entries.delete(key);
    }

    if (!text) return null;
    const value = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(text));
    const bytes = Buffer.byteLength(text);

    if (bytes <= 33_554_432) {
      while (this.#bytes + bytes > 33_554_432) {
        const oldest = this.#entries.entries().next().value;

        if (!oldest) break;
        this.#bytes -= oldest[1].bytes;
        this.#entries.delete(oldest[0]);
      }

      this.#entries.set(key, { generation, text, value, bytes });
      this.#bytes += bytes;
    }

    return value;
  }
}
