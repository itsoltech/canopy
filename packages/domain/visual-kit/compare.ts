import type { VisualNode } from "../src/visuals/types.ts";
import { renderChildren, stateText, type KitContext } from "./context.ts";
import { frame } from "./content.ts";
import { panels } from "./controls.ts";
import { append, button, el, rovingKeys, show } from "./dom.ts";

type Of<T extends VisualNode["type"]> = Extract<VisualNode, { type: T }>;

/**
 * Side by side when the frame is wide enough (container query in the kit CSS), otherwise one side at a time with a
 * Before/After switch. The switch is local UI, not visual state.
 */
export function beforeAfter(ctx: KitContext, node: Of<"before_after">): HTMLElement {
  const wrap = el("div", "v-compare");
  const picker = el("div", "v-segmented v-compare-picker");
  const sides = [node.before, node.after] as const;
  const labels = [node.before.label ?? "Before", node.after.label ?? "After"];

  const bodies = sides.map((side, index) => {
    const body = el("section", "v-compare-side");
    body.setAttribute("aria-label", labels[index]!);
    append(body, el("span", "v-label", labels[index]!), renderChildren(ctx, el("div", "v-stack"), side.children));

    return body;
  });

  picker.setAttribute("role", "radiogroup");
  picker.setAttribute("aria-label", "Compare");
  let selected = 0;

  const items = labels.map((label, index) => {
    const item = button("v-segment", label, () => select(index));
    item.setAttribute("role", "radio");
    picker.append(item);

    return item;
  });

  const select = (index: number) => {
    selected = index;

    for (const [i, item] of items.entries()) {
      item.setAttribute("aria-checked", String(i === selected));
      item.tabIndex = i === selected ? 0 : -1;
    }

    for (const [i, body] of bodies.entries()) body.dataset["selected"] = String(i === selected);
  };

  rovingKeys(items, select);
  select(0);
  append(wrap, picker, ...bodies);

  return wrap;
}

export function artboards(ctx: KitContext, node: Of<"artboards">): HTMLElement {
  return panels(ctx, node.state_key, node.label ?? "Artboards", node.artboards, (board) => {
    const device = node.artboards.find((entry) => entry.value === board.value)?.device;
    const content = renderChildren(ctx, el("div", "v-stack"), board.children);

    return device ? frame(device, undefined, content) : content;
  });
}

/** A non-interactive picture of a button in the chosen variant, size and state. */
export function buttonPreview(ctx: KitContext, node: Of<"button_preview">): HTMLElement {
  const wrap = el("div", "v-preview");
  const sample = el("span", "v-button v-button-sample");
  const label = el("span", undefined, node.label);
  const spinner = el("span", "v-spinner");

  const keys = [node.variant_from, node.size_from, node.disabled_from, node.loading_from].filter(
    (key): key is string => key !== undefined,
  );

  spinner.setAttribute("aria-hidden", "true");
  sample.setAttribute("role", "img");
  append(sample, spinner, label);
  wrap.append(sample);
  ctx.store.watch(keys, () => {
    const variant = stateText(ctx, node.variant_from) ?? node.variant ?? "primary";
    const size = stateText(ctx, node.size_from) ?? node.size ?? "md";
    const disabled = node.disabled_from ? ctx.store.get(node.disabled_from) === true : (node.disabled ?? false);
    const loading = node.loading_from ? ctx.store.get(node.loading_from) === true : (node.loading ?? false);

    sample.dataset["variant"] = variant;
    sample.dataset["size"] = size;
    sample.dataset["disabled"] = String(disabled);
    show(spinner, loading);
    sample.setAttribute(
      "aria-label",
      `${node.label} button preview: ${variant}, size ${size}${disabled ? ", disabled" : ""}${loading ? ", loading" : ""}`,
    );
  });

  return wrap;
}
