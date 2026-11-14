/**
 * Shared logic of the access pickers in Settings (connector accounts, provider instances, environment
 * assignment) on web and mobile: who may use something, as "all" (also ones added later) or chosen ids.
 */
export interface AccessChoice {
  readonly all: boolean;
  readonly ids: readonly string[];
}

/** Lists longer than this get a search field. */
export const ACCESS_SEARCH_THRESHOLD = 8;

/** Names shown in the summary before it switches to a count. */
const NAMED_LIMIT = 2;

/**
 * The trigger text: "All workers", "No workers", "Canopy Bot, Main Bot" or "3 of 12 workers". `noun` is the
 * plural, lower case ("workers"). Ids of items not in `options` (another computer's workers) count but have no name.
 */
export function accessSummary(
  choice: AccessChoice,
  options: readonly { readonly id: string; readonly name: string }[],
  noun: string,
): string {
  if (choice.all) return `All ${noun}`;

  if (!choice.ids.length) return `No ${noun}`;

  const names = choice.ids.map((id) => options.find((o) => o.id === id)?.name);

  if (choice.ids.length <= NAMED_LIMIT && names.every(Boolean)) return names.join(", ");

  const total = new Set([...options.map((o) => o.id), ...choice.ids]).size;

  return `${choice.ids.length} of ${total} ${noun}`;
}

/** Turning "all" off starts from everyone who can be chosen, so nobody loses access until unchecked. */
export function accessWithAll(choice: AccessChoice, all: boolean, selectable: readonly string[]): AccessChoice {
  if (all) return { all: true, ids: choice.ids };

  return { all: false, ids: choice.ids.length ? choice.ids : selectable };
}

export function accessToggled(choice: AccessChoice, id: string, on: boolean): AccessChoice {
  const ids = choice.ids.filter((v) => v !== id);

  return { all: false, ids: on ? [...ids, id] : ids };
}

export function sameAccess(a: AccessChoice, b: AccessChoice): boolean {
  return a.all === b.all && a.ids.length === b.ids.length && a.ids.every((id) => b.ids.includes(id));
}

/** Case-insensitive match of every word against the name and the extra text (group, host). */
export function accessMatches(query: string, ...texts: readonly (string | undefined)[]): boolean {
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}
