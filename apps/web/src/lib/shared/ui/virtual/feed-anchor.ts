/** The row that keeps its place on screen while the reader is scrolled up, and its distance from the top edge. */
export interface FeedAnchor {
  key: string;
  /** Message identity can survive a segment slot being reassigned when older work is paged in. */
  identity?: string;
  element: HTMLElement;
  top: number;
}

/** Correct measured growth only against the row's current element, never a reassigned segment slot. */
export function settleAnchor(
  anchor: FeedAnchor | undefined,
  elements: ReadonlyMap<string, HTMLElement>,
  scroller: HTMLElement,
  setTop: (top: number) => void,
): boolean {
  const element = anchor && elements.get(anchor.key);

  if (!anchor || !element) return false;
  anchor.element = element;
  const delta = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;

  if (Math.abs(delta) >= 0.5) setTop(scroller.scrollTop + delta);

  return true;
}

/** Moves a still mounted anchor with a scroll of `moved` px (positive towards the end); false without one. */
export function followScroll(
  anchor: FeedAnchor | undefined,
  elements: ReadonlyMap<string, HTMLElement>,
  moved: number,
): boolean {
  if (!anchor || !elements.has(anchor.key)) return false;
  anchor.top -= moved;

  return true;
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
export function captureAnchor(rows: HTMLCollection, edge: number, bottom: number): FeedAnchor | undefined {
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
  const rect = element?.getBoundingClientRect();

  // A large scroll can outrun the mounted window. Its old rows are not reading anchors.
  return element instanceof HTMLElement && element.dataset.key && rect && rect.bottom > edge && rect.top < bottom
    ? { key: element.dataset.key, element, top: rect.top - edge }
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
