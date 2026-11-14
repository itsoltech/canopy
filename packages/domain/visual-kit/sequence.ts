import type { VisualNode } from "../src/visuals/types.ts";
import type { KitContext } from "./context.ts";
import { append, el, srOnly } from "./dom.ts";

type Sequence = Extract<VisualNode, { type: "sequence" }>;

/** Participants as equal columns; each message is a row spanning from its sender's column to its receiver's. */
export function sequence(ctx: KitContext, node: Sequence): HTMLElement {
  const figure = el("figure", "v-sequence");
  const scroller = el("div", "v-sequence-scroll");
  const grid = el("div", "v-sequence-grid");
  const column = new Map(node.participants.map((p, index) => [p.id, index + 1]));
  const label = (id: string) => node.participants.find((p) => p.id === id)!.label;

  grid.style.setProperty("--participants", String(node.participants.length));
  scroller.tabIndex = 0;
  scroller.setAttribute("role", "region");
  scroller.setAttribute("aria-label", node.label ?? "Sequence diagram");

  for (const [index, participant] of node.participants.entries()) {
    const head = el("div", "v-sequence-participant", participant.label);
    const lifeline = el("div", "v-sequence-lifeline");
    head.style.gridColumn = String(index + 1);
    head.style.gridRow = "1";
    lifeline.style.gridColumn = String(index + 1);
    lifeline.style.gridRow = `2 / span ${node.messages.length}`;
    lifeline.setAttribute("aria-hidden", "true");
    grid.append(head, lifeline);
  }

  const rows = node.messages.map((message, index) => {
    const from = column.get(message.from)!;
    const to = column.get(message.to)!;
    const row = el("div", "v-sequence-message");
    const line = el("div", "v-sequence-line");
    const kind = from === to ? "note" : (message.kind ?? "call");
    const start = Math.min(from, to);
    const span = Math.abs(to - from) + 1;

    row.dataset["kind"] = kind;
    row.dataset["direction"] = to >= from ? "right" : "left";
    row.style.gridColumn = `${start} / span ${span}`;
    row.style.gridRow = String(index + 2);
    row.style.setProperty("--span", String(span));
    line.setAttribute("aria-hidden", "true");
    append(
      row,
      srOnly(`${index + 1}. ${label(message.from)} to ${label(message.to)}${message.label ? ": " : ""}`),
      el("span", "v-sequence-label", message.label ?? ""),
      kind === "note" ? undefined : line,
    );
    grid.append(row);

    return row;
  });

  scroller.append(grid);
  append(figure, node.label && el("figcaption", "v-caption", node.label), scroller);

  if (node.step_from) {
    const key = node.step_from;
    ctx.store.watch([key], () => {
      const step = Number(ctx.store.get(key) ?? 0);

      for (const [index, row] of rows.entries()) {
        row.dataset["state"] = index < step ? "done" : index === step ? "current" : "later";
        row.toggleAttribute("aria-current", index === step);
      }
    });
  }

  return figure;
}
