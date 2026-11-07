/**
 * Exact matching of many known secret values in one linear pass (Aho–Corasick over UTF-16 code units), and a
 * linear scan for token formats with a distinctive prefix (docs/import.md, "Maskowanie"). Both return spans; the
 * masker replaces their union. No regular expression here can backtrack: every input costs time in its length.
 */

export type Span = readonly [start: number, end: number];

/** Many fixed strings, found in one pass: at each position the longest value that ends there. */
export class ExactMatcher {
  readonly #next = new Map<number, number>();
  readonly #fail: number[] = [0];
  /** Longest value that is a suffix of the node's string (0: none). */
  readonly #length: number[] = [0];
  #nodes = 1;

  constructor(values: Iterable<string>) {
    for (const value of values) {
      let node = 0;

      for (let i = 0; i < value.length; i++) node = this.#child(node, value.charCodeAt(i));
      this.#length[node] = Math.max(this.#length[node] ?? 0, value.length);
    }

    this.#links();

    for (const [key, node] of this.#next) if (key < 65_536) this.#root[key] = node;
  }

  /** The root's transitions by code unit (0: none): most of a text is read at the root. */
  readonly #root = new Int32Array(65_536);

  #child(node: number, code: number): number {
    const key = node * 65_536 + code;
    const known = this.#next.get(key);

    if (known !== undefined) return known;
    const created = this.#nodes++;
    this.#next.set(key, created);
    this.#fail[created] = 0;
    this.#length[created] ??= 0;
    this.#children(node).push(created);
    this.#codes[created] = code;

    return created;
  }

  readonly #kids = new Map<number, number[]>();
  readonly #codes: number[] = [0];

  #children(node: number): number[] {
    let list = this.#kids.get(node);

    if (!list) this.#kids.set(node, (list = []));

    return list;
  }

  /** Failure links breadth first; each node inherits the longest value of its failure node. */
  #links(): void {
    const queue = [...(this.#kids.get(0) ?? [])];

    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]!;

      for (const child of this.#kids.get(node) ?? []) {
        const code = this.#codes[child]!;
        let fail = this.#fail[node]!;

        while (fail !== 0 && !this.#next.has(fail * 65_536 + code)) fail = this.#fail[fail]!;
        const target = this.#next.get(fail * 65_536 + code);
        this.#fail[child] = target !== undefined && target !== child ? target : 0;
        this.#length[child] = Math.max(this.#length[child] ?? 0, this.#length[this.#fail[child]!] ?? 0);
        queue.push(child);
      }
    }

    this.#kids.clear();
  }

  get empty(): boolean {
    return this.#nodes === 1;
  }

  spans(text: string): Span[] {
    const found: Span[] = [];

    if (this.empty) return found;
    let node = 0;

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);

      while (node !== 0 && !this.#next.has(node * 65_536 + code)) node = this.#fail[node]!;
      node = node === 0 ? (this.#root[code] ?? 0) : (this.#next.get(node * 65_536 + code) ?? 0);
      const length = this.#length[node] ?? 0;

      if (length > 0) found.push([i + 1 - length, i + 1]);
    }

    return found;
  }
}

const isWord = (code: number) =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

/** Characters of a token run: word characters, `-` and `.`. */
const isRun = (code: number) => isWord(code) || code === 45 || code === 46;

const ALNUM = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const WORD_DASH = (code: number) => isWord(code) || code === 45;
const UPPER_DIGIT = (code: number) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90);
const ALNUM_DASH = (code: number) => ALNUM(code) || code === 45;

interface Token {
  readonly prefixes: readonly string[];
  readonly allowed: (code: number) => boolean;
  /** At least this many characters after the prefix; with `exact`, exactly this many and a boundary after. */
  readonly length: number;
  readonly exact?: boolean;
}

/** Token formats (the prefix is matched at a word boundary), longest prefixes first. */
const TOKENS: readonly Token[] = [
  { prefixes: ["sk-ant-"], allowed: WORD_DASH, length: 20 },
  { prefixes: ["sk-proj-", "sk-svcacct-", "sk-admin-", "sk-"], allowed: WORD_DASH, length: 32 },
  { prefixes: ["xai-"], allowed: ALNUM, length: 32 },
  { prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], allowed: ALNUM, length: 30 },
  { prefixes: ["github_pat_"], allowed: isWord, length: 40 },
  { prefixes: ["AKIA", "ASIA"], allowed: UPPER_DIGIT, length: 16, exact: true },
  { prefixes: ["xoxa-", "xoxb-", "xoxe-", "xoxp-", "xoxr-", "xoxs-"], allowed: ALNUM_DASH, length: 20 },
  { prefixes: ["AIza"], allowed: WORD_DASH, length: 35, exact: true },
  { prefixes: ["glpat-"], allowed: WORD_DASH, length: 20 },
  { prefixes: ["npm_"], allowed: ALNUM, length: 36, exact: true },
];

/** The shortest token any format above matches (`AKIA` and 16 characters). */
const MIN_TOKEN = 20;

/** The end of a token starting at `start`, or -1. */
function tokenAt(text: string, start: number, end: number): number {
  for (const token of TOKENS) {
    const prefix = token.prefixes.find((p) => text.startsWith(p, start));

    if (!prefix) continue;
    const from = start + prefix.length;
    let stop = from;
    const limit = token.exact ? Math.min(end, from + token.length) : end;

    while (stop < limit && token.allowed(text.charCodeAt(stop))) stop++;

    if (stop - from < token.length) continue;

    if (token.exact && stop < text.length && isWord(text.charCodeAt(stop))) continue;

    return stop;
  }

  return -1;
}

/** JWTs in a run: three dot-separated parts, the first two starting `eyJ`. */
function jwts(text: string, start: number, end: number, found: Span[]): void {
  const parts: Span[] = [];
  let from = start;

  for (let i = start; i <= end; i++) {
    if (i === end || text.charCodeAt(i) === 46) {
      parts.push([from, i]);
      from = i + 1;
    }
  }

  for (let i = 0; i + 2 < parts.length; i++) {
    const [a, b, c] = [parts[i]!, parts[i + 1]!, parts[i + 2]!];
    const segment = (p: Span) => p[1] - p[0] >= 10 && /^[A-Za-z0-9_-]+$/.test(text.slice(p[0], p[1]));

    if (
      text.startsWith("eyJ", a[0]) &&
      text.startsWith("eyJ", b[0]) &&
      a[1] - a[0] >= 13 &&
      b[1] - b[0] >= 13 &&
      segment(a) &&
      segment(b) &&
      segment(c)
    ) {
      found.push([a[0], c[1]]);
      i += 2;
    }
  }
}

const PEM_MARKER = /-----(BEGIN|END) [A-Z ]{0,40}PRIVATE KEY-----/g;

/**
 * Private key blocks: each BEGIN with the first END after it; a BEGIN without one hides the rest, an END without one
 * what comes before it (fail closed).
 */
export function pems(text: string, found: Span[]): void {
  const markers = [...text.matchAll(PEM_MARKER)].map((m) => ({
    begin: m[1] === "BEGIN",
    at: m.index,
    end: m.index + m[0].length,
  }));

  let open: number | undefined;
  // An END without its BEGIN (the header was cut off or masked apart): everything before it back to the last pair.
  let closed = 0;

  for (const marker of markers) {
    if (marker.begin) open ??= marker.at;
    else {
      found.push([open ?? closed, marker.end]);
      open = undefined;
      closed = marker.end;
    }
  }

  if (open !== undefined) found.push([open, text.length]);
}

/** Token formats in one pass over runs of token characters, plus private key blocks. */
export function tokenSpans(text: string): Span[] {
  const found: Span[] = [];
  let i = 0;

  while (i < text.length) {
    if (!isRun(text.charCodeAt(i))) {
      i++;
      continue;
    }

    let end = i;
    let dotted = false;

    for (; end < text.length && isRun(text.charCodeAt(end)); end++) dotted ||= text.charCodeAt(end) === 46;

    // Shorter than the shortest token format: nothing to find (most words and paths).
    if (end - i < MIN_TOKEN) {
      i = end;
      continue;
    }

    if (dotted) jwts(text, i, end, found);

    for (let s = i; s < end; s++) {
      // A token starts at a word boundary: the run's start, or after `-` or `.`.
      if (s > i && isWord(text.charCodeAt(s - 1))) continue;
      const stop = tokenAt(text, s, end);

      if (stop > 0) {
        found.push([s, stop]);
        s = stop - 1;
      }
    }

    i = end;
  }

  pems(text, found);

  return found;
}

/** Overlapping and touching spans as one, in order. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];

  for (const [start, end] of sorted) {
    const last = merged.at(-1);

    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  return merged;
}
