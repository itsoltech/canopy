import type { VisualEdge, VisualFlowNode, VisualNode } from "../src/visuals/types.ts";
import { isNumber } from "../src/json.ts";
import type { KitContext } from "./context.ts";
import { append, el, srOnly, svg, uid } from "./dom.ts";

type Flow = Extract<VisualNode, { type: "flow" }>;

/** Layer per node: longest path from a source, ignoring edges that close a cycle. */
export function flowLayers(nodes: readonly VisualFlowNode[], edges: readonly VisualEdge[]): Map<string, number> {
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const state = new Map<string, "visiting" | "done">();
  const order: string[] = [];
  const forward: VisualEdge[] = [];

  for (const edge of edges) outgoing.get(edge.from)?.push(edge.to);

  // Iterative DFS: post-order gives a reverse topological order of the acyclic part.
  for (const start of nodes) {
    if (state.has(start.id)) continue;
    const stack: [string, number][] = [[start.id, 0]];
    state.set(start.id, "visiting");

    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const targets = outgoing.get(top[0]) ?? [];

      if (top[1] >= targets.length) {
        state.set(top[0], "done");
        order.push(top[0]);
        stack.pop();
        continue;
      }

      const target = targets[top[1]]!;
      top[1] += 1;

      if (state.get(target) === "visiting") continue;
      forward.push({ from: top[0], to: target });

      if (!state.has(target)) {
        state.set(target, "visiting");
        stack.push([target, 0]);
      }
    }
  }

  const layers = new Map<string, number>(nodes.map((node) => [node.id, 0]));

  for (const id of order.reverse())
    for (const edge of forward)
      if (edge.from === id) layers.set(edge.to, Math.max(layers.get(edge.to)!, layers.get(id)! + 1));

  return layers;
}

function arrowMarker(id: string): SVGDefsElement {
  const defs = svg("defs");

  const marker = svg("marker", {
    id,
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    markerWidth: 7,
    markerHeight: 7,
    orient: "auto-start-reverse",
  });

  marker.append(svg("path", { d: "M0,0 L10,5 L0,10 z", class: "v-arrow-head" }));
  defs.append(marker);

  return defs;
}

export function flow(ctx: KitContext, node: Flow): HTMLElement {
  const figure = el("figure", "v-flow");
  const canvas = el("div", "v-flow-canvas");
  const lines = svg("svg", { class: "v-flow-lines", "aria-hidden": "true" });
  const markerId = uid("arrow");
  const layers = flowLayers(node.nodes, node.edges);
  const depth = Math.max(...layers.values()) + 1;
  const boxes = new Map<string, HTMLElement>();
  const rows = new Map<number, number>();
  const connections = el("ul", "v-sr");

  for (const item of node.nodes) {
    const box = el("div", "v-flow-node");
    const layer = layers.get(item.id)!;
    const row = rows.get(layer) ?? 0;
    rows.set(layer, row + 1);
    box.dataset["tone"] = item.tone ?? "neutral";
    box.dataset["shape"] = item.shape ?? "box";
    box.dataset["layer"] = String(layer);
    box.dataset["row"] = String(row);
    append(box, el("span", "v-flow-label", item.label), item.detail && el("span", "v-muted", item.detail));
    boxes.set(item.id, box);
    canvas.append(box);
  }

  for (const edge of node.edges) {
    const from = node.nodes.find((n) => n.id === edge.from)!.label;
    const to = node.nodes.find((n) => n.id === edge.to)!.label;
    connections.append(el("li", undefined, `${from} to ${to}${edge.label ? `: ${edge.label}` : ""}`));
  }

  figure.setAttribute("role", "group");
  figure.setAttribute("aria-label", node.label ?? "Flow diagram");
  canvas.dataset["loops"] = String(node.edges.some((edge) => layers.get(edge.to)! <= layers.get(edge.from)!));
  canvas.append(lines);
  append(figure, node.label && el("figcaption", "v-caption", node.label), canvas, srOnly("Connections:"), connections);

  const layout = () => {
    const wide = (node.direction ?? "horizontal") === "horizontal" && canvas.clientWidth >= depth * 150;
    canvas.dataset["direction"] = wide ? "horizontal" : "vertical";

    for (const box of boxes.values()) {
      const along = Number(box.dataset["layer"]) + 1;
      const across = Number(box.dataset["row"]) + 1;
      box.style.gridColumn = String(wide ? along : across);
      box.style.gridRow = String(wide ? across : along);
    }

    drawEdges(node, boxes, canvas, lines, markerId, wide);
  };

  ctx.onResize(canvas, layout);

  if (node.highlight_from) {
    const key = node.highlight_from;
    ctx.store.watch([key], () => {
      const value = ctx.store.get(key);
      const stepped = value !== undefined && isNumber(value);
      const active = stepped ? (node.nodes[value]?.id ?? "") : String(value);
      const index = node.nodes.findIndex((n) => n.id === active);

      for (const [i, item] of node.nodes.entries()) {
        const box = boxes.get(item.id)!;
        box.dataset["state"] = item.id === active ? "current" : stepped && i < index ? "done" : "";
        box.toggleAttribute("aria-current", item.id === active);
      }
    });
  }

  return figure;
}

/** Forward edges curve between facing sides; edges back to an earlier layer loop around the far side. */
interface EdgePath {
  readonly d: string;
  /** Label position. */
  readonly x: number;
  readonly y: number;
}

function edgePath(a: DOMRect, b: DOMRect, origin: DOMRect, wide: boolean): EdgePath {
  const ax = a.left - origin.left;
  const ay = a.top - origin.top;
  const bx = b.left - origin.left;
  const by = b.top - origin.top;

  if (wide && b.left >= a.right - 1) {
    const [sx, sy, ex, ey] = [ax + a.width, ay + a.height / 2, bx, by + b.height / 2];
    const mid = (sx + ex) / 2;

    return { d: `M${sx},${sy} C${mid},${sy} ${mid},${ey} ${ex},${ey}`, x: mid, y: (sy + ey) / 2 - 6 };
  }

  if (!wide && b.top >= a.bottom - 1) {
    const [sx, sy, ex, ey] = [ax + a.width / 2, ay + a.height, bx + b.width / 2, by];
    const mid = (sy + ey) / 2;

    return { d: `M${sx},${sy} C${sx},${mid} ${ex},${mid} ${ex},${ey}`, x: (sx + ex) / 2, y: mid - 6 };
  }

  if (wide) {
    const low = Math.max(ay + a.height, by + b.height) + 18;
    const [sx, ex] = [ax + a.width / 2, bx + b.width / 2];

    return { d: `M${sx},${ay + a.height} V${low} H${ex} V${by + b.height}`, x: (sx + ex) / 2, y: low - 6 };
  }

  const side = Math.max(ax + a.width, bx + b.width) + 18;
  const [sy, ey] = [ay + a.height / 2, by + b.height / 2];

  return { d: `M${ax + a.width},${sy} H${side} V${ey} H${bx + b.width}`, x: side + 4, y: (sy + ey) / 2 };
}

function drawEdges(
  node: Flow,
  boxes: ReadonlyMap<string, HTMLElement>,
  canvas: HTMLElement,
  lines: SVGSVGElement,
  markerId: string,
  wide: boolean,
): void {
  const origin = canvas.getBoundingClientRect();
  lines.replaceChildren(arrowMarker(markerId));

  for (const edge of node.edges) {
    const a = boxes.get(edge.from)!.getBoundingClientRect();
    const b = boxes.get(edge.to)!.getBoundingClientRect();
    const path = edgePath(a, b, origin, wide);

    lines.append(svg("path", { d: path.d, class: "v-flow-edge", "marker-end": `url(#${markerId})` }));

    if (edge.label) {
      const label = svg("text", { x: path.x, y: path.y, class: "v-flow-edge-label" });
      label.textContent = edge.label;
      lines.append(label);
    }
  }
}
