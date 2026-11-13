import { isString } from "../src/json.ts";
import type { VisualNode, VisualPanel, VisualStateValue } from "../src/visuals/types.ts";
import { renderChildren, type KitContext } from "./context.ts";
import { append, button, el, rovingKeys, show, uid } from "./dom.ts";

type Of<T extends VisualNode["type"]> = Extract<VisualNode, { type: T }>;

export function actionButton(ctx: KitContext, node: Of<"button">): HTMLElement {
  const element = button("v-button", node.label, () => ctx.store.apply(node.actions));
  element.dataset["variant"] = node.variant ?? "secondary";

  return element;
}

export function resetButton(ctx: KitContext, node: Of<"reset">): HTMLElement {
  const element = button("v-button", node.label ?? "Reset", () => {
    ctx.store.reset();
    ctx.announce("Reset to the start.");
  });

  element.dataset["variant"] = "ghost";

  return element;
}

interface ChoiceGroup {
  readonly group: HTMLElement;
  readonly items: HTMLButtonElement[];
}

/** A radiogroup of options; every option keeps its width when selected so nothing beside it moves. */
export function choiceGroup(
  ctx: KitContext,
  key: string,
  label: string,
  options: readonly { value: string; label: string }[],
  role: "radio" | "tab",
): ChoiceGroup {
  const group = el("div", role === "tab" ? "v-tablist" : "v-segmented");
  group.setAttribute("role", role === "tab" ? "tablist" : "radiogroup");
  group.setAttribute("aria-label", label);

  const items = options.map((option) => {
    const item = button(role === "tab" ? "v-tab" : "v-segment", option.label, () => ctx.store.set(key, option.value));
    item.setAttribute("role", role);
    group.append(item);

    return item;
  });

  rovingKeys(items, (index) => ctx.store.set(key, options[index]!.value));
  ctx.store.watch([key], () => {
    const value = ctx.store.get(key);

    for (const [index, item] of items.entries()) {
      const selected = options[index]!.value === value;
      item.setAttribute(role === "tab" ? "aria-selected" : "aria-checked", String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
  });

  return { group, items };
}

export function segmented(ctx: KitContext, node: Of<"segmented">): HTMLElement {
  const options = node.options.map((option) => (isString(option) ? { value: option, label: option } : option));

  const wrap = el("div", "v-field");
  const label = el("span", "v-label", node.label);
  wrap.append(label, choiceGroup(ctx, node.state_key, node.label, options, "radio").group);

  return wrap;
}

/** Tabs and artboards: one selected panel, the others hidden but kept. */
export function panels(
  ctx: KitContext,
  key: string,
  label: string,
  entries: readonly VisualPanel[],
  content: (panel: VisualPanel) => HTMLElement,
): HTMLElement {
  const wrap = el("div", "v-tabs");
  const { group, items } = choiceGroup(ctx, key, label, entries, "tab");

  const bodies = entries.map((entry, index) => {
    const body = el("div", "v-tabpanel");
    body.id = uid("panel");
    body.setAttribute("role", "tabpanel");
    items[index]!.id = uid("tab");
    items[index]!.setAttribute("aria-controls", body.id);
    body.setAttribute("aria-labelledby", items[index]!.id);
    body.append(content(entry));

    return body;
  });

  append(wrap, group, ...bodies);
  ctx.store.watch([key], () => {
    for (const [index, body] of bodies.entries()) show(body, entries[index]!.value === ctx.store.get(key));
  });

  return wrap;
}

export function tabs(ctx: KitContext, node: Of<"tabs">): HTMLElement {
  return panels(ctx, node.state_key, node.label ?? "Tabs", node.tabs, (tab) =>
    renderChildren(ctx, el("div", "v-stack"), tab.children),
  );
}

export function toggle(ctx: KitContext, node: Of<"toggle">): HTMLElement {
  const element = button("v-switch", "", () => ctx.store.apply([{ action: "toggle", state_key: node.state_key }]));
  const track = el("span", "v-switch-track");
  track.setAttribute("aria-hidden", "true");
  track.append(el("span", "v-switch-thumb"));
  element.setAttribute("role", "switch");
  append(element, track, el("span", "v-switch-label", node.label));
  ctx.store.watch([node.state_key], () =>
    element.setAttribute("aria-checked", String(ctx.store.get(node.state_key) === true)),
  );

  return element;
}

export function stepper(ctx: KitContext, node: Of<"stepper">): HTMLElement {
  const key = node.state_key;
  const wrap = el("div", "v-stepper");
  const rail = el("ol", "v-steps");
  const live = el("p", "v-step-status");
  const nav = el("div", "v-step-nav");
  const previous = button("v-button", "Previous", () => ctx.store.apply([{ action: "previous", state_key: key }]));
  const next = button("v-button", "Next", () => ctx.store.apply([{ action: "next", state_key: key }]));
  const current = () => Number(ctx.store.get(key) ?? 0);

  rail.setAttribute("aria-label", node.label ?? "Steps");
  previous.dataset["variant"] = "secondary";
  next.dataset["variant"] = "primary";

  const markers = node.steps.map((step, index) => {
    const item = el("li", "v-step");
    const jump = button("v-step-button", "", () => ctx.store.set(key, index));
    append(jump, el("span", "v-step-index", String(index + 1)), el("span", "v-step-title", step.title));
    item.append(jump);
    rail.append(item);

    return jump;
  });

  const bodies = node.steps.map((step) => {
    const body = el("div", "v-stack v-step-body");
    append(
      body,
      el("h4", "v-heading v-heading-3", step.title),
      step.description && el("p", "v-text", step.description),
    );
    renderChildren(ctx, body, step.children);

    return body;
  });

  live.setAttribute("aria-live", "polite");
  nav.append(previous, next);
  append(wrap, node.label && el("span", "v-label", node.label), rail, ...bodies, nav, live);
  ctx.store.watch([key], () => {
    const index = current();

    for (const [i, marker] of markers.entries()) {
      marker.parentElement!.dataset["state"] = i < index ? "done" : i === index ? "current" : "next";
      marker.toggleAttribute("aria-current", i === index);
    }

    for (const [i, body] of bodies.entries()) show(body, i === index);
    previous.disabled = index <= 0;
    next.disabled = index >= node.steps.length - 1;
    live.textContent = `Step ${index + 1} of ${node.steps.length}: ${node.steps[index]?.title ?? ""}`;
  });

  return wrap;
}

export function when(ctx: KitContext, node: Of<"when">): HTMLElement {
  const element = renderChildren(ctx, el("div", "v-when"), node.children);
  const accepted: readonly VisualStateValue[] = Array.isArray(node.equals) ? node.equals : [node.equals];
  ctx.store.watch([node.state_key], () => {
    const value = ctx.store.get(node.state_key);
    show(element, value !== undefined && accepted.includes(value));
  });

  return element;
}
