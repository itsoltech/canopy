/** The row that keeps its place on screen while the reader is scrolled up, and its distance from the top edge. */
export interface FeedAnchor {
  key: string;
  element: HTMLElement;
  top: number;
}

/** Keep a closing fold's surviving header visible when its work rows disappear. */
export function holdAnchor(
  key: string,
  elements: ReadonlyMap<string, HTMLElement>,
  scroller: HTMLElement | undefined,
  focus: boolean,
): FeedAnchor | undefined {
  const element = elements.get(key);

  if (!scroller || !element) return undefined;

  if (focus) element.focus({ preventScroll: true });

  return { key, element, top: Math.max(0, element.getBoundingClientRect().top - scroller.getBoundingClientRect().top) };
}

/** The first mounted row whose bottom is below the top edge (rows are in order), as the anchor. */
export function captureAnchor(rows: HTMLCollection, edge: number): FeedAnchor | undefined {
  let low = 0;
  let high = rows.length - 1;

  while (low < high) {
    const middle = (low + high) >> 1;

    if ((rows[middle]?.getBoundingClientRect().bottom ?? 0) > edge + 1) high = middle;
    else low = middle + 1;
  }

  // Prepending a same-day turn moves the day label out of the old first start row.
  // Anchor message content instead, so its position survives that header shrinking.
  while (low < rows.length - 1) {
    const row = rows[low];

    if (!(row instanceof HTMLElement) || !/(^|:)(start|end):/.test(row.dataset.key ?? "")) break;
    low++;
  }

  const element = rows[low];

  return element instanceof HTMLElement && element.dataset.key
    ? { key: element.dataset.key, element, top: element.getBoundingClientRect().top - edge }
    : undefined;
}

/** Keys of the mounted rows between `top` and `bottom` on screen, except `skip`. */
export function rowsOnScreen(
  elements: ReadonlyMap<string, HTMLElement>,
  top: number,
  bottom: number,
  skip: string | undefined,
): string[] {
  const keys: string[] = [];

  for (const [rowKey, element] of elements) {
    const rect = element.getBoundingClientRect();

    if (rect.bottom > top && rect.top < bottom && rowKey !== skip) keys.push(rowKey);
  }

  return keys;
}

/** Focused row plus visible reading rows; a following reader has no reading range. */
export function readingKeys(
  elements: ReadonlyMap<string, HTMLElement>,
  scroller: HTMLElement | undefined,
  following: boolean,
  focused: string | undefined,
  footerHeight: number,
): string[] {
  const keys = focused === undefined ? [] : [focused];

  if (following || !scroller) return keys;
  const box = scroller.getBoundingClientRect();

  return [...keys, ...rowsOnScreen(elements, box.top, box.bottom - footerHeight, focused)];
}
