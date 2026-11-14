import type { VisualNode } from "../src/visuals/types.ts";
import type { KitContext } from "./context.ts";
import { append, button, el, svg, uid } from "./dom.ts";

type Chart = Extract<VisualNode, { type: "chart" }>;

const HEIGHT = 220;
const MARKERS = ["circle", "square", "triangle", "diamond", "ring", "bar"] as const;

/** The axis spans at most ±1e15: larger finite values are drawn at the edge (the data table shows them as given). */
const AXIS_LIMIT = 1e15;

export const onAxis = (value: number) => Math.min(AXIS_LIMIT, Math.max(-AXIS_LIMIT, value));

/** Round tick steps (1, 2, 5 × 10ⁿ) covering the data and zero. */
export function ticks(min: number, max: number, count = 5): number[] {
  const low = Math.min(0, onAxis(min));
  const high = Math.max(0, onAxis(max)) === low ? low + 1 : Math.max(0, onAxis(max));
  const raw = (high - low) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((factor) => factor * power >= raw) ?? 10) * power;
  const values: number[] = [];

  for (let value = Math.floor(low / step) * step; values.length < 50; value += step) {
    values.push(Number(value.toPrecision(12)));

    if (value >= high) break;
  }

  return values;
}

function marker(shape: (typeof MARKERS)[number], x: number, y: number, series: number): SVGElement {
  const attrs = { class: `v-chart-marker v-series-${series}` };

  switch (shape) {
    case "circle":
    case "ring":
      return svg("circle", { ...attrs, cx: x, cy: y, r: 3.5, "data-shape": shape });
    case "square":
    case "bar":
      return svg("rect", { ...attrs, x: x - 3.5, y: y - 3.5, width: 7, height: 7, "data-shape": shape });
    case "triangle":
      return svg("path", { ...attrs, d: `M${x},${y - 4.5} L${x + 4.5},${y + 3.5} L${x - 4.5},${y + 3.5} z` });
    case "diamond":
      return svg("path", { ...attrs, d: `M${x},${y - 4.5} L${x + 4.5},${y} L${x},${y + 4.5} L${x - 4.5},${y} z` });
  }
}

function dataTable(node: Chart, format: (value: number) => string): HTMLElement {
  const wrap = el("div", "v-table");
  const table = el("table");
  const head = el("tr");
  const body = el("tbody");

  head.append(el("th", undefined, ""), ...node.series.map((series) => el("th", undefined, series.name)));

  for (const [index, category] of node.categories.entries()) {
    const row = el("tr");
    const th = el("th", undefined, category);
    th.scope = "row";
    row.append(th, ...node.series.map((series) => el("td", undefined, format(series.values[index]!))));
    body.append(row);
  }

  const thead = el("thead");
  thead.append(head);
  table.append(el("caption", "v-sr", node.label), thead, body);
  wrap.tabIndex = 0;
  wrap.append(table);

  return wrap;
}

export function chart(ctx: KitContext, node: Chart): HTMLElement {
  const figure = el("figure", "v-chart");
  const legend = el("ul", "v-chart-legend");
  const plot = el("div", "v-chart-plot");
  const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  const format = (value: number) => `${numbers.format(value)}${node.unit ? ` ${node.unit}` : ""}`;
  const table = dataTable(node, format);

  const toggle = button("v-button", "Show data", () => {
    table.hidden = !table.hidden;
    toggle.setAttribute("aria-expanded", String(!table.hidden));
    toggle.textContent = table.hidden ? "Show data" : "Hide data";
  });

  table.id = uid("data");
  table.hidden = true;
  toggle.dataset["variant"] = "ghost";
  toggle.setAttribute("aria-controls", table.id);
  toggle.setAttribute("aria-expanded", "false");
  plot.setAttribute("aria-hidden", "true");

  for (const [index, series] of node.series.entries()) {
    const item = el("li");
    const swatch = svg("svg", { width: 12, height: 12, "aria-hidden": "true" });
    swatch.append(marker(MARKERS[index]!, 6, 6, index + 1));
    append(item, swatch, el("span", undefined, series.name));
    legend.append(item);
  }

  append(figure, el("figcaption", "v-caption", node.label), legend, plot, toggle, table);
  ctx.onResize(plot, () => plot.replaceChildren(draw(node, Math.max(240, plot.clientWidth), format)));

  return figure;
}

function draw(node: Chart, width: number, format: (value: number) => string): SVGSVGElement {
  const values = node.series.flatMap((series) => series.values);
  const scale = ticks(Math.min(...values), Math.max(...values));
  const low = scale[0]!;
  const high = scale[scale.length - 1]!;
  const left = Math.max(...scale.map((value) => format(value).length)) * 7 + 12;
  const plotWidth = width - left - 8;
  const plotHeight = HEIGHT - 32;
  const band = plotWidth / node.categories.length;
  const y = (value: number) => 8 + plotHeight - ((onAxis(value) - low) / (high - low)) * plotHeight;
  const every = Math.ceil((node.categories.length * 72) / plotWidth);
  const root = svg("svg", { width: "100%", height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, class: "v-chart-svg" });

  for (const tick of scale) {
    root.append(svg("line", { x1: left, x2: width - 8, y1: y(tick), y2: y(tick), class: "v-chart-grid" }));
    const label = svg("text", { x: left - 6, y: y(tick) + 4, "text-anchor": "end", class: "v-chart-tick" });
    label.textContent = format(tick);
    root.append(label);
  }

  for (const [index, category] of node.categories.entries()) {
    if (index % every) continue;

    const label = svg("text", {
      x: left + band * (index + 0.5),
      y: HEIGHT - 6,
      "text-anchor": "middle",
      class: "v-chart-tick",
    });

    label.textContent = category.length > 14 ? `${category.slice(0, 13)}…` : category;
    root.append(label);
  }

  for (const [s, series] of node.series.entries()) {
    const points = series.values.map((value, index) => [left + band * (index + 0.5), y(value)] as const);

    if (node.kind === "line")
      root.append(
        svg("path", {
          d: `M${points.map(([px, py]) => `${px},${py}`).join(" L")}`,
          class: `v-chart-line v-series-${s + 1}`,
        }),
      );

    for (const [index, value] of series.values.entries()) {
      const title = svg("title");
      title.textContent = `${node.categories[index]} · ${series.name}: ${format(value)}`;
      const inner = band * 0.8;
      const barWidth = inner / node.series.length;

      const shape =
        node.kind === "bar"
          ? svg("rect", {
              x: left + band * index + band * 0.1 + barWidth * s,
              y: Math.min(y(value), y(0)),
              width: Math.max(1, barWidth - 2),
              height: Math.max(1, Math.abs(y(value) - y(0))),
              class: `v-chart-bar v-series-${s + 1}`,
            })
          : marker(MARKERS[s]!, points[index]![0], points[index]![1], s + 1);

      shape.append(title);
      root.append(shape);
    }
  }

  return root;
}
