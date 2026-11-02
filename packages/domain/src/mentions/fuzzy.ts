/**
 * Fuzzy matching for the composer's mention popup, the worker's file search and the gateway's thread search
 * (docs/ui-api.md, "Wzmianki"): the query's characters in order, case-insensitive. Matches at word starts, in a
 * row and in the last path segment rank higher; long gaps and long targets rank lower.
 */

export interface FuzzyMatch {
  readonly score: number;
  /** Positions of the matched characters in the target (UTF-16 indices). */
  readonly indices: readonly number[];
}

const SEPARATORS = new Set(["/", "\\", "-", "_", ".", " ", ":", "#", "$", "@"]);

/** Undefined when the query's characters are not all in the target, in order. An empty query matches everything. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | undefined {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return { score: 0, indices: [] };
  const t = target.toLowerCase();
  const base = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\")) + 1;
  // Two candidates: from the start, and anchored in the last path segment when the query fits there.
  const candidates = [scan(q, target, t, 0, base)];
  if (base > 0) candidates.push(scan(q, target, t, base, base));
  let best: FuzzyMatch | undefined;
  for (const candidate of candidates) if (candidate && (!best || candidate.score > best.score)) best = candidate;
  return best;
}

function scan(q: string, target: string, t: string, from: number, base: number): FuzzyMatch | undefined {
  const indices: number[] = [];
  let score = 0;
  let at = from;
  let previous = -2;
  for (const ch of q) {
    // Prefer the next word start that has the character; else its next occurrence.
    const next = t.indexOf(ch, at);
    if (next < 0) return undefined;
    let pick = next;
    if (previous !== next - 1) {
      for (let i = next; i < t.length; i++) {
        if (t[i] === ch && isWordStart(target, i)) {
          pick = i;
          break;
        }
      }
      // Jump to a word start only when it is not much further than the plain match.
      if (pick - next > 24) pick = next;
    }
    let gain = 1;
    if (pick === previous + 1) gain += 6;
    if (isWordStart(target, pick)) gain += 8;
    if (pick === base) gain += 6;
    if (pick >= base) gain += 2;
    gain -= Math.min(previous < 0 ? pick - from : pick - previous - 1, 6) * 0.5;
    score += gain;
    indices.push(pick);
    previous = pick;
    at = pick + 1;
  }
  // Shorter targets and exact prefixes rank higher.
  score -= target.length * 0.05;
  if (t.startsWith(q) || t.slice(base).startsWith(q)) score += 10;
  if (t === q || t.slice(base) === q) score += 20;
  return { score, indices };
}

function isWordStart(target: string, i: number): boolean {
  if (i === 0) return true;
  const before = target[i - 1] ?? "";
  const ch = target[i] ?? "";
  if (SEPARATORS.has(before)) return true;
  // camelCase: a capital after a lower-case letter.
  return ch !== ch.toLowerCase() && before === before.toLowerCase() && before !== before.toUpperCase();
}

/** Ranks candidates by their best field; ties keep the input order (e.g. newest first). */
export function fuzzyRank<T>(query: string, items: readonly T[], fields: (item: T) => readonly string[], limit = Infinity): { item: T; match: FuzzyMatch }[] {
  const ranked: { item: T; match: FuzzyMatch; order: number }[] = [];
  items.forEach((item, order) => {
    let best: FuzzyMatch | undefined;
    fields(item).forEach((field, i) => {
      const match = fuzzyMatch(query, field);
      // Later fields (descriptions) count less than the first (the name).
      const scored = match && i > 0 ? { score: match.score - 15 * i, indices: [] } : match;
      if (scored && (!best || scored.score > best.score)) best = scored;
    });
    if (best) ranked.push({ item, match: best, order });
  });
  ranked.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
  return ranked.slice(0, limit).map(({ item, match }) => ({ item, match }));
}
