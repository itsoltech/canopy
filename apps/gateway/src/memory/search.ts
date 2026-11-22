import MiniSearch from "minisearch";
import type { MemoryNote } from "./model.ts";

const stopWords = new Set(
  (
    "a an and are as at be by can do for from how i in is it me of on or our please should that the this to we what with you which where when would could about find tell remember thanks thank okay ok yes " +
    "aby albo ale by czy dla do jak jest mam mi na nad nie o od oraz po pod przez sie ten to tym w z za ze dzieki dziekuje tak prosze ktory gdzie kiedy nasze"
  ).split(" "),
);

function terms(text: string) {
  const tokens: string[] = [];

  for (const [symbol] of text.matchAll(/#\d+|[\p{L}\p{N}]+(?:[_.:/-][\p{L}\p{N}]+)*(?:\+\+|#)?/gu)) {
    const pieces = symbol.replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2").split(/[ _.\-:/]+/);

    for (const piece of new Set([symbol, ...pieces])) {
      const term = piece.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replaceAll("ł", "l");

      if (term.length > 1 && !stopWords.has(term)) tokens.push(term);
    }
  }

  return tokens;
}

function strongMatch(note: MemoryNote, words: readonly string[], matchedTerms: readonly string[], coverage: number) {
  if (coverage >= Math.min(3, words.length) || matchedTerms.some((term) => /[.#:/_+-]/.test(term))) return true;

  return [note.title, ...note.aliases].some((name) => {
    const nameTerms = terms(name);

    return nameTerms.length > 0 && nameTerms.every((term) => words.includes(term));
  });
}

export class MemoryIndex {
  readonly sourceSize: number;
  readonly #notes = new Map<string, MemoryNote>();
  readonly #index = new MiniSearch<{ id: string; title: string; body: string; aliases: string }>({
    fields: ["title", "aliases", "body"],
    tokenize: terms,
  });

  constructor(notes: MemoryNote[]) {
    let sourceSize = 0;

    for (const note of notes) {
      this.#notes.set(note.id, note);
      const aliases = note.aliases.join(" ");
      this.#index.add({ ...note, aliases });
      sourceSize += 128 + Buffer.byteLength(note.title) + Buffer.byteLength(note.body) + Buffer.byteLength(aliases);
    }

    this.sourceSize = sourceSize;
  }

  search(queries: readonly string[], limit: number, automatic: boolean) {
    const matches = new Map<MemoryNote, number>();

    for (const query of queries.slice(0, 8)) {
      const words = [...new Set(terms(query.slice(0, 2048)))].slice(0, 64);

      if (!words.length) continue;
      // Search all language/alias variants independently so a poor variant cannot dilute a direct match.
      const references = words.filter((term) => /^#\d+$/.test(term));

      const hits = this.#index.search(query, {
        tokenize: () => words,
        boost: { title: 4, aliases: 3 },
        prefix: (term) => !automatic && term.length >= 4 && /^[a-z]+$/.test(term),
        fuzzy: (term) => (!automatic && term.length >= 6 && /^[a-z]+$/.test(term) ? 1 : false),
      });

      for (const hit of hits) {
        if (references.length && !references.some((term) => hit.terms.includes(term))) continue;
        const note = this.#notes.get(hit.id);

        if (!note || (automatic && !strongMatch(note, words, hit.terms, hit.queryTerms.length))) continue;
        matches.set(note, Math.max(matches.get(note) ?? 0, hit.score));
      }
    }

    return [...matches]
      .sort(([a, scoreA], [b, scoreB]) => scoreB - scoreA || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(([note]) => note);
  }
}

const MAX_CACHED_SOURCE_BYTES = 8 * 1024 * 1024;

interface CacheEntry {
  version: string;
  index: Promise<MemoryIndex | undefined>;
  sourceSize: number;
}

/** Share a rebuild and bound retained indexes by scope count and indexed source bytes. */
export class MemoryIndexCache {
  readonly #entries = new Map<string, CacheEntry>();

  get(key: string, version: string, load: () => Promise<MemoryNote[] | undefined>) {
    const cached = this.#entries.get(key);
    this.#entries.delete(key);

    if (cached?.version === version) {
      this.#entries.set(key, cached);

      return cached.index;
    }

    const entry: CacheEntry = {
      version,
      sourceSize: 0,
      index: load().then((notes) => notes && new MemoryIndex(notes)),
    };

    this.#entries.set(key, entry);
    this.#trim();

    return entry.index.then(
      (index) => {
        if (this.#entries.get(key) === entry) {
          if (!index || index.sourceSize > MAX_CACHED_SOURCE_BYTES) this.#entries.delete(key);
          else {
            entry.sourceSize = index.sourceSize;
            this.#trim();
          }
        }

        return index;
      },
      (error) => {
        if (this.#entries.get(key) === entry) this.#entries.delete(key);
        throw error;
      },
    );
  }

  #trim() {
    let bytes = 0;

    for (const entry of this.#entries.values()) bytes += entry.sourceSize;

    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= 32 && bytes <= MAX_CACHED_SOURCE_BYTES) break;
      this.#entries.delete(key);
      bytes -= entry.sourceSize;
    }
  }
}
