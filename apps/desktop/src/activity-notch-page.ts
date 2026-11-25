import { randomBytes } from "node:crypto";
import { motion, palette, radius } from "@canopy/ui";
import { themeVariables } from "@canopy/ui/themes";
import type { ActivityNotchRow } from "./activity-notch.ts";

const colors = themeVariables("ash", "dark");

const statuses = {
  approval: { label: "Needs approval", one: "needs approval", many: "need approval" },
  answer: { label: "Needs an answer", one: "needs an answer", many: "need an answer" },
  failed: { label: "Failed", one: "failed", many: "failed" },
  working: { label: "Working", one: "working", many: "working" },
  completed: { label: "Completed", one: "completed", many: "completed" },
} satisfies Record<ActivityNotchRow["state"], { label: string; one: string; many: string }>;

const styles = `
  :root {
    color-scheme: dark;
    --notch-height: 40px;
    --control-overlay: 1.75rem;
    --type-compact: 0.8125rem;
    --type-meta: 0.71875rem;
    --icon-compact: 0.875rem;
    --radius-md: ${radius.md}px;
    --canvas: ${colors.canvas};
    --panel: ${palette.zinc[950]};
    --hover: ${colors.hover};
    --ink: ${colors.ink};
    --muted: ${colors.muted};
    --border: ${colors.border};
    --acc-expand: ${motion.fast}ms;
    --acc-collapse: ${motion.quick}ms;
    --acc-ease: cubic-bezier(${motion.smoothOut.join(", ")});
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    overflow: hidden;
    color: var(--ink);
    font: var(--type-compact) / 1.25rem system-ui, sans-serif;
    user-select: none;
  }
  button {
    appearance: none;
    border: 0;
    color: inherit;
    background: none;
    font: inherit;
  }
  button:not(:disabled) { cursor: pointer; }
  button:focus-visible {
    outline: 2px solid ${palette.sky[400]};
    outline-offset: -3px;
  }
  .t-acc {
    position: relative;
    overflow: hidden;
    border-radius: calc(var(--notch-height) / 2);
    background: var(--canvas);
  }
  .t-acc::after {
    position: absolute;
    inset: 0;
    border: 1px solid var(--border);
    border-radius: inherit;
    pointer-events: none;
    content: "";
  }
  .t-acc-head, .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: start;
  }
  .t-acc-head {
    grid-template-columns: minmax(0, 1fr) minmax(0, auto) var(--icon-compact);
    height: var(--notch-height);
    padding: 0 0.75rem;
    border-radius: inherit;
    font-weight: 600;
  }
  .t-acc-head:not(:disabled):hover, .row:hover { background: var(--hover); }
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    color: var(--muted);
    font-size: var(--type-meta);
    line-height: 1rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .status::before {
    flex: none;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: var(--indicator, transparent);
    content: "";
  }
  [data-state="working"] { --indicator: ${palette.sky[400]}; }
  [data-state="approval"], [data-state="answer"] { --indicator: ${palette.amber[400]}; }
  [data-state="completed"] { --indicator: ${palette.emerald[400]}; }
  [data-state="failed"] { --indicator: ${palette.rose[400]}; }
  .t-acc-chevron {
    display: grid;
    place-items: center;
    width: var(--icon-compact);
    height: var(--icon-compact);
    color: var(--muted);
    transition: transform var(--acc-expand) var(--acc-ease);
  }
  .t-acc-chevron::before {
    width: 0.375rem;
    height: 0.375rem;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: translateY(-1.5px) rotate(45deg);
    content: "";
  }
  .t-acc[data-open="true"] .t-acc-chevron { transform: scaleY(-1); }
  .t-acc-head:disabled .t-acc-chevron { visibility: hidden; }
  .t-acc-panel {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--acc-collapse) var(--acc-ease);
  }
  .t-acc[data-open="true"] .t-acc-panel {
    grid-template-rows: 1fr;
    transition-duration: var(--acc-expand);
  }
  .t-acc-panel-inner {
    min-height: 0;
    overflow: hidden;
    background: var(--panel);
  }
  .rows {
    height: max(0px, calc(100dvh - var(--notch-height)));
    margin: 0;
    padding: 0.25rem;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-color: var(--border) transparent;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    list-style: none;
  }
  .row {
    min-height: var(--control-overlay);
    padding: 0 0.5rem;
    border-radius: var(--radius-md);
    font-variant-numeric: tabular-nums;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    .t-acc-panel, .t-acc-chevron { transition: none; }
  }
`;

const script = `
  const bridge = window.canopyActivityNotch;
  const notch = document.querySelector(".t-acc");
  const toggle = document.querySelector(".t-acc-head");
  const toggleAction = document.getElementById("toggle-action");
  const panel = document.getElementById("activity-panel");
  const summary = document.getElementById("activity-summary");
  const summaryText = summary.firstElementChild;
  const list = document.querySelector(".rows");
  const statuses = ${JSON.stringify(statuses)};
  const numbers = new Intl.NumberFormat("en");
  const rowViews = new Map();

  function setExpanded(expanded) {
    if (notch.dataset.open === String(expanded)) return false;

    if (!expanded && panel.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    notch.dataset.open = String(expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggleAction.textContent = expanded ? "Hide " : "Show ";
    panel.setAttribute("aria-hidden", String(!expanded));
    panel.inert = !expanded;
    return true;
  }

  function createRow(id) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const label = document.createElement("span");
    const status = document.createElement("span");
    button.type = "button";
    button.className = "row";
    label.className = "truncate";
    status.className = "status";
    button.append(label, status);
    item.append(button);
    button.addEventListener("click", () => bridge.open(id));
    return { item, button, label, status };
  }

  function renderRows(rows) {
    const counts = new Map();
    const activeRow = document.activeElement;
    const ids = new Set(rows.map((row) => row.id));
    for (const [id, view] of rowViews) {
      if (ids.has(id)) continue;
      if (view.button === activeRow) toggle.focus({ preventScroll: true });
      view.item.remove();
      rowViews.delete(id);
    }

    let nextItem = list.firstElementChild;
    for (const { id, kind, number, state } of rows) {
      const view = rowViews.get(id) ?? createRow(id);
      rowViews.set(id, view);
      const label = kind + " " + numbers.format(number);
      if (view.label.textContent !== label || view.status.dataset.state !== state) {
        const status = statuses[state].label;
        view.label.textContent = label;
        view.status.textContent = status;
        view.status.dataset.state = state;
        view.button.setAttribute("aria-label", "Open " + label + ", " + status);
      }
      if (view.item !== nextItem) list.insertBefore(view.item, nextItem);
      nextItem = view.item.nextElementSibling;
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    if (list.contains(activeRow) && document.activeElement !== activeRow) activeRow.focus({ preventScroll: true });

    const state = Object.keys(statuses).find((candidate) => counts.has(candidate));
    if (state) {
      const count = counts.get(state);
      summaryText.textContent = numbers.format(count) + " " + statuses[state][count === 1 ? "one" : "many"];
      summary.dataset.state = state;
    } else {
      summaryText.textContent = "No activity";
      delete summary.dataset.state;
      if (setExpanded(false)) bridge.setExpanded(false);
    }
    toggle.disabled = !state;
  }

  toggle.addEventListener("click", () => {
    const expanded = notch.dataset.open !== "true";
    setExpanded(expanded);
    bridge.setExpanded(expanded);
  });
  notch.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !setExpanded(false)) return;
    event.preventDefault();
    bridge.setExpanded(false);
  });
  bridge.onCollapse(() => setExpanded(false));
  bridge.onRows(renderRows);
`;

export function activityNotchPage(): string {
  const nonce = randomBytes(18).toString("base64");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
  <title>Canopy activity</title>
  <style nonce="${nonce}">${styles}</style>
</head>
<body>
  <main class="t-acc" data-open="false">
    <button class="t-acc-head" type="button" aria-expanded="false" aria-controls="activity-panel" disabled>
      <span class="truncate"><span id="toggle-action" class="sr-only">Show </span>Activity</span>
      <span id="activity-summary" class="status"><span class="truncate">No activity</span></span>
      <span class="t-acc-chevron" aria-hidden="true"></span>
    </button>
    <div id="activity-panel" class="t-acc-panel" aria-hidden="true" inert>
      <div class="t-acc-panel-inner">
        <ul class="rows" aria-label="Activity"></ul>
      </div>
    </div>
  </main>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
