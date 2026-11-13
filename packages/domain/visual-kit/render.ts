import type { VisualNode } from "../src/visuals/types.ts";
import { chart } from "./chart.ts";
import { artboards, beforeAfter, buttonPreview } from "./compare.ts";
import * as content from "./content.ts";
import type { KitContext } from "./context.ts";
import { actionButton, resetButton, segmented, stepper, tabs, toggle, when } from "./controls.ts";
import { flow } from "./flow.ts";
import { sequence } from "./sequence.ts";

export function renderNode(ctx: KitContext, node: VisualNode): HTMLElement {
  switch (node.type) {
    case "stack":
      return content.stack(ctx, node);
    case "grid":
      return content.grid(ctx, node);
    case "card":
      return content.card(ctx, node);
    case "divider":
      return content.divider();
    case "heading":
      return content.heading(node);
    case "text":
      return content.text(node);
    case "code":
      return content.code(node);
    case "list":
      return content.list(node);
    case "badge":
      return content.badge(node);
    case "stat":
      return content.stat(node);
    case "callout":
      return content.callout(node);
    case "table":
      return content.table(node);
    case "button":
      return actionButton(ctx, node);
    case "reset":
      return resetButton(ctx, node);
    case "tabs":
      return tabs(ctx, node);
    case "segmented":
      return segmented(ctx, node);
    case "toggle":
      return toggle(ctx, node);
    case "stepper":
      return stepper(ctx, node);
    case "when":
      return when(ctx, node);
    case "before_after":
      return beforeAfter(ctx, node);
    case "artboards":
      return artboards(ctx, node);
    case "device_frame":
      return content.deviceFrame(ctx, node);
    case "button_preview":
      return buttonPreview(ctx, node);
    case "flow":
      return flow(ctx, node);
    case "sequence":
      return sequence(ctx, node);
    case "chart":
      return chart(ctx, node);
  }
}
