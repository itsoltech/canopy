import type { VisualNode } from "../src/visuals/types.ts";
import type { Store } from "./store.ts";

export interface KitContext {
  readonly store: Store;
  /** Renders a child node; used by containers. */
  readonly render: (node: VisualNode) => HTMLElement;
  /** Reads a step's result to assistive technology (one shared live region). */
  readonly announce: (text: string) => void;
  /** One shared observer re-lays out diagrams and charts when their width changes. */
  readonly onResize: (element: Element, layout: () => void) => void;
}

export function renderChildren(ctx: KitContext, parent: HTMLElement, nodes: readonly VisualNode[] | undefined) {
  for (const node of nodes ?? []) parent.append(ctx.render(node));

  return parent;
}

export function stateText(ctx: KitContext, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const value = ctx.store.get(key);

  return value === undefined ? undefined : String(value);
}
