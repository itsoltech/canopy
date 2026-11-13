import { isJsonArray, isJsonObject, type JsonValue } from "../json.ts";
import type { VisualNode } from "./types.ts";

export interface VisitedNode {
  readonly node: VisualNode;
  readonly path: string;
  /** 1 for the root. */
  readonly depth: number;
}

/** Direct child nodes with their paths relative to the parent. */
export function childNodes(node: VisualNode): readonly (readonly [string, VisualNode])[] {
  const list = (prefix: string, nodes: readonly VisualNode[] | undefined) =>
    (nodes ?? []).map((child, index) => [`${prefix}[${index}]`, child] as const);

  switch (node.type) {
    case "stack":
    case "grid":
    case "card":
    case "when":
    case "device_frame":
      return list(".children", node.children);
    case "tabs":
      return node.tabs.flatMap((tab, index) => list(`.tabs[${index}].children`, tab.children));
    case "artboards":
      return node.artboards.flatMap((board, index) => list(`.artboards[${index}].children`, board.children));
    case "stepper":
      return node.steps.flatMap((step, index) => list(`.steps[${index}].children`, step.children));
    case "before_after":
      return [...list(".before.children", node.before.children), ...list(".after.children", node.after.children)];
    default:
      return [];
  }
}

/** Depth-first, in document order, without recursion. Stops early when `visit` returns false. */
export function walkVisual(root: VisualNode, visit: (entry: VisitedNode) => boolean): void {
  const stack: VisitedNode[] = [{ node: root, path: "root", depth: 1 }];

  while (stack.length) {
    const entry = stack.pop()!;

    if (!visit(entry)) return;
    const children = childNodes(entry.node);

    for (let index = children.length - 1; index >= 0; index--) {
      const [suffix, node] = children[index]!;
      stack.push({ node, path: entry.path + suffix, depth: entry.depth + 1 });
    }
  }
}

/** Nesting depth of arbitrary JSON, bounded before a recursive decoder sees it. */
export function jsonDepthExceeds(value: JsonValue, limit: number): boolean {
  const stack: [JsonValue, number][] = [[value, 1]];

  while (stack.length) {
    const [current, depth] = stack.pop()!;

    if (depth > limit) return true;

    if (isJsonArray(current) || isJsonObject(current))
      for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }

  return false;
}
