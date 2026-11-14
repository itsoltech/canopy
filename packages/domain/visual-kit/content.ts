import type { VisualNode } from "../src/visuals/types.ts";
import { renderChildren, type KitContext } from "./context.ts";
import { append, el, uid } from "./dom.ts";

type Of<T extends VisualNode["type"]> = Extract<VisualNode, { type: T }>;

export function stack(ctx: KitContext, node: Of<"stack">): HTMLElement {
  const element = el("div", "v-stack");
  element.dataset["direction"] = node.direction ?? "vertical";
  element.dataset["gap"] = node.gap ?? "md";
  element.dataset["align"] = node.align ?? "stretch";

  return renderChildren(ctx, element, node.children);
}

export function grid(ctx: KitContext, node: Of<"grid">): HTMLElement {
  const element = el("div", "v-grid");
  element.dataset["columns"] = String(node.columns);
  element.dataset["gap"] = node.gap ?? "md";

  return renderChildren(ctx, element, node.children);
}

export function card(ctx: KitContext, node: Of<"card">): HTMLElement {
  const element = el("section", "v-card");
  element.dataset["tone"] = node.tone ?? "neutral";

  if (node.title || node.subtitle) {
    const header = el("header", "v-card-header");
    append(
      header,
      node.title && el("h3", "v-card-title", node.title),
      node.subtitle && el("p", "v-muted", node.subtitle),
    );
    element.append(header);
  }

  if (node.children) element.append(renderChildren(ctx, el("div", "v-stack"), node.children));

  return element;
}

export function heading(node: Of<"heading">): HTMLElement {
  const tags = { 1: "h2", 2: "h3", 3: "h4" } as const;

  return el(tags[node.level ?? 2], `v-heading v-heading-${node.level ?? 2}`, node.text);
}

export function text(node: Of<"text">): HTMLElement {
  const element = el("p", "v-text", node.text);
  element.dataset["variant"] = node.variant ?? "body";

  return element;
}

export function code(node: Of<"code">): HTMLElement {
  const figure = el("figure", "v-code");

  if (node.label) figure.append(el("figcaption", "v-caption", node.label));
  const pre = el("pre");
  pre.tabIndex = 0;
  pre.append(el("code", undefined, node.text));
  figure.append(pre);

  return figure;
}

export function list(node: Of<"list">): HTMLElement {
  const element = el(node.ordered ? "ol" : "ul", "v-list");

  for (const item of node.items) element.append(el("li", undefined, item));

  return element;
}

export function badge(node: Of<"badge">): HTMLElement {
  const element = el("span", "v-badge", node.text);
  element.dataset["tone"] = node.tone ?? "neutral";

  return element;
}

export function stat(node: Of<"stat">): HTMLElement {
  const element = el("div", "v-stat");
  element.dataset["tone"] = node.tone ?? "neutral";
  append(
    element,
    el("span", "v-caption", node.label),
    el("span", "v-stat-value", node.value),
    node.detail && el("span", "v-muted", node.detail),
  );

  return element;
}

export function callout(node: Of<"callout">): HTMLElement {
  const element = el("div", "v-callout");
  element.setAttribute("role", "note");
  element.dataset["tone"] = node.tone ?? "info";
  append(element, node.title && el("strong", "v-callout-title", node.title), el("p", "v-text", node.text));

  return element;
}

export function table(node: Of<"table">): HTMLElement {
  const wrap = el("div", "v-table");
  const element = el("table");
  const head = el("thead");
  const headRow = el("tr");
  const body = el("tbody");

  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", node.caption ?? "Table");

  if (node.caption) element.append(el("caption", "v-caption", node.caption));

  for (const column of node.columns) {
    const cell = el("th", undefined, column);
    cell.scope = "col";
    headRow.append(cell);
  }

  for (const row of node.rows) {
    const tr = el("tr");

    for (const [index] of node.columns.entries()) tr.append(el("td", undefined, row[index] ?? ""));
    body.append(tr);
  }

  head.append(headRow);
  element.append(head, body);
  wrap.append(element);

  return wrap;
}

export function divider(): HTMLElement {
  return el("hr", "v-divider");
}

export function deviceFrame(ctx: KitContext, node: Of<"device_frame">): HTMLElement {
  return frame(node.device, node.label, renderChildren(ctx, el("div", "v-stack"), node.children));
}

/** Phone, tablet, desktop or browser chrome around content, sized by the container. */
export function frame(
  device: Of<"device_frame">["device"],
  label: string | undefined,
  content: HTMLElement,
): HTMLElement {
  const figure = el("figure", "v-device");
  const screen = el("div", "v-device-screen");
  figure.dataset["device"] = device;

  if (device === "browser" || device === "desktop") {
    const bar = el("div", "v-device-bar");
    bar.setAttribute("aria-hidden", "true");
    append(bar, el("span"), el("span"), el("span"));
    figure.append(bar);
  }

  screen.append(content);
  figure.append(screen);

  if (label) {
    const caption = el("figcaption", "v-caption", label);
    caption.id = uid("frame");
    figure.setAttribute("aria-labelledby", caption.id);
    figure.append(caption);
  }

  return figure;
}
