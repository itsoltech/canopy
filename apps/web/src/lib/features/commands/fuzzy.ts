/**
 * Fuzzy matching for the command palette: the query's characters in order anywhere in the text
 * (case-insensitive), scored so that matches at word starts, in runs and early in the text rank first;
 * matches scattered over the insides of words are rejected.
 * `indices` are the matched positions of `text` (for highlighting).
 *
 *   fuzzyMatch("nt", "New thread")   // { score: …, indices: [0, 4] }
 *   fuzzyMatch("xyz", "New thread")  // undefined
 */
export interface FuzzyMatch {
  readonly score: number;
  readonly indices: readonly number[];
}

const WORD_START = 8;
const TEXT_START = 2;
const CAMEL = 6;
const RUN = 6;
const GAP = 0.5;
const LEADING_GAP = 0.1;

const isSeparator = (char: string) => /[\s\-_/.:·,()[\]]/.test(char);

/** Bonus for a match at `index`: the start of a word (or the text), a camelCase hump, else nothing. */
function bonusAt(text: string, index: number): number {
  if (index === 0) return WORD_START + TEXT_START;
  const before = text[index - 1]!;

  if (isSeparator(before)) return WORD_START;
  const char = text[index]!;

  if (before === before.toLowerCase() && char !== char.toLowerCase()) return CAMEL;

  return 0;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const m = q.length;
  const n = t.length;

  if (m === 0) return { score: 0, indices: [] };

  if (m > n) return undefined;

  // Quick reject: not even a subsequence.
  for (let i = 0, j = 0; i < m; i++, j++) {
    j = t.indexOf(q[i]!, j);

    if (j < 0) return undefined;
  }

  // ending[i][j]: best score of q[0..i] with q[i] matched at t[j]; best[i][j]: best of q[0..i] within
  // t[0..j], carrying a gap penalty for every character skipped since its match.
  const ending = Array.from({ length: m }, () => new Float64Array(n).fill(-Infinity));
  const best = Array.from({ length: m }, () => new Float64Array(n).fill(-Infinity));
  const bonus = Array.from({ length: n }, (_, j) => bonusAt(text, j));

  for (let i = 0; i < m; i++) {
    for (let j = i; j < n; j++) {
      if (q[i] === t[j]) {
        if (i === 0) ending[i]![j] = bonus[j]! - j * LEADING_GAP;
        else if (j > 0) {
          const run = ending[i - 1]![j - 1]! + RUN + bonus[j]!;
          const jump = best[i - 1]![j - 1]! + bonus[j]!;
          ending[i]![j] = Math.max(run, jump);
        }
      }

      best[i]![j] = Math.max(ending[i]![j]!, j > 0 ? best[i]![j - 1]! - GAP : -Infinity);
    }
  }

  // Walk back from the best end to recover the positions.
  let end = -1;

  for (let j = m - 1; j < n; j++) if (end < 0 || ending[m - 1]![j]! > ending[m - 1]![end]!) end = j;
  const score = ending[m - 1]![end]!;

  if (!Number.isFinite(score)) return undefined;
  const indices = Array.from({ length: m }, () => 0);
  indices[m - 1] = end;

  for (let i = m - 1; i > 0; i--) {
    const j = indices[i]!;
    const here = ending[i]![j]! - bonus[j]!;

    // A run from the previous character when that is what scored, else the best earlier match.
    if (Math.abs(ending[i - 1]![j - 1]! + RUN - here) < 1e-9) {
      indices[i - 1] = j - 1;
      continue;
    }

    let pick = -1;
    let pickScore = -Infinity;

    for (let k = i - 1; k < j; k++) {
      const value = ending[i - 1]![k]! - (j - 1 - k) * GAP;

      if (value > pickScore) {
        pickScore = value;
        pick = k;
      }
    }

    indices[i - 1] = pick;
  }

  // Too scattered to be meant: more pieces starting inside a word than one (one per three characters
  // typed for longer queries), e.g. "ocean" in "navigation collapse expand"; a single character only at a
  // word start. Pieces at word starts are always fine ("nt" in "New thread").
  let inside = 0;

  for (let i = 0; i < m; i++)
    if ((i === 0 || indices[i - 1] !== indices[i]! - 1) && bonus[indices[i]!] === 0) inside += 1;

  if (inside > (m === 1 ? 0 : Math.max(1, Math.floor(m / 3)))) return undefined;
  // A whole-word or prefix hit beats a scattered one with the same bonuses.
  const exact = t.startsWith(q) ? 4 : t.includes(q) ? 2 : 0;

  return { score: score + exact, indices };
}

/** A command's searchable text: its title (highlighted) and extra keywords (matched, never shown). */
export interface Searchable {
  readonly title: string;
  readonly keywords?: string | undefined;
}

/** How much a keyword match counts against a title match. */
const KEYWORD_WEIGHT = 0.6;

/**
 * Every word of the query must match the title or the keywords; the score is the sum, the indices are
 * those of the title matches. Undefined when a word matches neither.
 */
export function matchCommand(query: string, item: Searchable): FuzzyMatch | undefined {
  const words = query.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return { score: 0, indices: [] };
  let score = 0;
  const indices = new Set<number>();

  for (const word of words) {
    const inTitle = fuzzyMatch(word, item.title);
    const inKeywords = item.keywords ? fuzzyMatch(word, item.keywords) : undefined;
    const keywordScore = inKeywords ? inKeywords.score * KEYWORD_WEIGHT : -Infinity;

    if (inTitle && inTitle.score >= keywordScore) {
      score += inTitle.score;

      for (const index of inTitle.indices) indices.add(index);
    } else if (inKeywords) score += keywordScore;
    else return undefined;
  }

  return { score, indices: [...indices].sort((a, b) => a - b) };
}
