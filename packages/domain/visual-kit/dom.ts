// DOM helpers of the trusted kit. Text always goes through textContent; the kit never parses markup.

let sequence = 0;

export function uid(prefix: string): string {
  sequence += 1;

  return `v-${prefix}-${sequence}`;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  if (className) element.className = className;

  if (text !== undefined) element.textContent = text;

  return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Readonly<Record<string, string | number>> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);

  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));

  return element;
}

export function append(parent: Element, ...children: (Node | undefined | false | "")[]): void {
  for (const child of children) if (child) parent.append(child);
}

export function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = el("button", className, label);
  element.type = "button";
  element.addEventListener("click", onClick);

  return element;
}

export function srOnly(text: string): HTMLSpanElement {
  return el("span", "v-sr", text);
}

/** Arrow keys, Home and End move between the items of a tablist or radiogroup. */
export function rovingKeys(items: readonly HTMLElement[], select: (index: number) => void, vertical = false) {
  for (const [index, item] of items.entries())
    item.addEventListener("keydown", (event) => {
      const last = items.length - 1;

      const keys = new Map([
        [vertical ? "ArrowDown" : "ArrowRight", index === last ? 0 : index + 1],
        [vertical ? "ArrowUp" : "ArrowLeft", index === 0 ? last : index - 1],
        ["Home", 0],
        ["End", last],
      ]);

      const target = keys.get(event.key);

      if (target === undefined) return;
      event.preventDefault();
      select(target);
      items[target]?.focus();
    });
}

/** Elements that only change visibility keep their nodes, so focus and scroll stay put. */
export function show(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}
