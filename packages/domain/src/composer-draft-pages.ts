import type { ui } from "@canopy/contracts";

/** The owner's store has at most 100 drafts; finish pagination before displaying target counts. */
export async function loadComposerDraftPages(fetchPage: (token: string) => Promise<ui.ComposerDraftPage>, token = "") {
  const first = await fetchPage(token);
  const drafts = new Map(first.drafts.map((row) => [row.id, row]));
  const moves = new Map(first.moves.map((move) => [move.id, move]));
  let next = first.nextPageToken;
  const seen = new Set<string>();

  while (next && drafts.size < 100 && seen.size < 5 && !seen.has(next)) {
    seen.add(next);
    const page = await fetchPage(next);

    for (const row of page.drafts) drafts.set(row.id, row);

    for (const move of page.moves) moves.set(move.id, move);
    next = page.nextPageToken;
  }

  return { ...first, drafts: [...drafts.values()].slice(0, 100), moves: [...moves.values()], nextPageToken: "" };
}
