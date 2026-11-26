import { randomBytes } from "node:crypto";
import { motion } from "@canopy/ui";
import { activityNotchLogoSize } from "@canopy/ui/desktop";
import { icons } from "@canopy/ui/icons";
import { activityNotchStyles } from "./activity-notch-styles.ts";
import type { ActivityNotchRow } from "./activity-notch.ts";

const statuses = {
  approval: { label: "Needs approval", one: "needs approval", many: "need approval" },
  answer: { label: "Needs an answer", one: "needs an answer", many: "need an answer" },
  failed: { label: "Failed", one: "failed", many: "failed" },
  working: { label: "Working", one: "working", many: "working" },
  completed: { label: "Completed", one: "completed", many: "completed" },
} satisfies Record<ActivityNotchRow["state"], { label: string; one: string; many: string }>;

const activityGlyphs = {
  approval: icons["shield-exclamation"],
  answer: icons["chat-bubble-bottom-center-text"],
  failed: icons["x-circle"],
  working: [],
  completed: icons["check-circle"],
} satisfies Record<ActivityNotchRow["state"], readonly string[]>;

const glyphs = Object.entries(activityGlyphs)
  .map(([state, paths]) => {
    const icon = paths.length
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths.map((path) => `<path d="${path}"/>`).join("")}</svg>`
      : '<span class="spinner"></span>';

    return `<span class="state-layer" data-state="${state}">${icon}</span>`;
  })
  .join("");

const script = `
  const bridge = window.canopyActivityNotch;
  const notch = document.querySelector(".notch");
  const surface = document.querySelector(".notch-body");
  const toggle = document.querySelector(".notch-toggle");
  const toggleAction = document.getElementById("toggle-action");
  const panel = document.getElementById("activity-panel");
  const summary = document.getElementById("activity-summary");
  const summaryText = document.getElementById("activity-description");
  const glyphs = summary.querySelectorAll("[data-state]");
  const total = document.getElementById("activity-count");
  const list = document.querySelector(".rows");
  const statuses = ${JSON.stringify(statuses)};
  const logoSize = ${activityNotchLogoSize};
  const logoBytes = logoSize * logoSize * 4;
  const encodedLogoLength = Math.ceil(logoBytes / 3) * 4;
  const numbers = new Intl.NumberFormat("en");
  const rowViews = new Map();
  let collapseTimer;
  let openedByHover = false;

  function setExpanded(expanded) {
    clearTimeout(collapseTimer);
    openedByHover = false;
    if (notch.dataset.open === String(expanded)) return false;

    if (!expanded && panel.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    notch.dataset.open = String(expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggleAction.textContent = expanded ? "Hide activity" : "Show activity";
    panel.setAttribute("aria-hidden", String(!expanded));
    panel.inert = !expanded;
    return true;
  }

  function requestExpanded(expanded) {
    if (setExpanded(expanded)) bridge.setExpanded(expanded);
  }

  function showState(layers, state) {
    for (const layer of layers) layer.classList.toggle("active", layer.dataset.state === state);
  }

  function applyLayout({ center, width, height, headerHeight, revision }) {
    if (notch.hasAttribute("data-layout")) notch.dataset.animate = "";
    notch.style.setProperty("--notch-center", center + "px");
    notch.style.setProperty("--notch-width", width + "px");
    notch.style.setProperty("--notch-size", height + "px");
    notch.style.setProperty("--notch-height", headerHeight + "px");
    notch.dataset.layout = "";

    const animations = [...notch.getAnimations(), ...surface.getAnimations()];
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => bridge.layoutSettled(revision));
  }

  function createRow(id) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const badge = document.createElement("span");
    const label = document.createElement("span");
    const status = document.createElement("span");
    button.type = "button";
    button.className = "row";
    badge.className = "project-mark";
    badge.hidden = true;
    badge.setAttribute("aria-hidden", "true");
    label.className = "truncate";
    status.className = "row-status";
    status.setAttribute("aria-hidden", "true");
    for (const [state, { label }] of Object.entries(statuses)) {
      const layer = document.createElement("span");
      layer.className = "status state-layer";
      layer.dataset.state = state;
      layer.textContent = label;
      status.append(layer);
    }
    button.append(badge, label, status);
    item.append(button);
    button.addEventListener("click", () => bridge.open(id));
    return { item, button, badge, label, status };
  }

  function projectLogo(pixels) {
    if (pixels?.length !== encodedLogoLength) return;

    let decoded;
    try {
      decoded = atob(pixels);
    } catch {
      return;
    }
    if (decoded.length !== logoBytes) return;

    const canvas = document.createElement("canvas");
    canvas.width = logoSize;
    canvas.height = logoSize;
    const context = canvas.getContext("2d");
    if (!context) return;

    const rgba = Uint8ClampedArray.from(decoded, (byte) => byte.charCodeAt(0));
    context.putImageData(new ImageData(rgba, logoSize, logoSize), 0, 0);
    return canvas;
  }

  function updateProjectMark(view, mark) {
    const previous = view.projectMark;
    if (
      previous?.initials === mark?.initials &&
      previous?.foreground === mark?.foreground &&
      previous?.background === mark?.background &&
      previous?.pixels === mark?.pixels
    ) return;

    const logo = projectLogo(mark?.pixels);
    view.badge.replaceChildren(logo ?? mark?.initials ?? "");
    view.badge.style.color = mark?.foreground ?? "";
    view.badge.style.backgroundColor = logo ? "" : mark?.background ?? "";
    view.badge.hidden = !mark;
    view.projectMark = mark;
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
    for (const { id, kind, number, state, projectMark } of rows) {
      const view = rowViews.get(id) ?? createRow(id);
      rowViews.set(id, view);
      const mark = kind === "Thread" ? projectMark : undefined;
      const label = kind + " " + numbers.format(number);
      const status = statuses[state].label;
      updateProjectMark(view, mark);
      if (view.label.textContent !== label) view.label.textContent = label;
      showState(view.status.children, state);
      const project = mark ? ", project " + mark.initials : "";
      const accessibleLabel = "Open " + label + project + ", " + status;
      if (view.button.getAttribute("aria-label") !== accessibleLabel) {
        view.button.setAttribute("aria-label", accessibleLabel);
      }
      if (view.item !== nextItem) list.insertBefore(view.item, nextItem);
      nextItem = view.item.nextElementSibling;
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    if (list.contains(activeRow) && document.activeElement !== activeRow) activeRow.focus({ preventScroll: true });

    const state = Object.keys(statuses).find((candidate) => counts.has(candidate));
    total.textContent = state ? numbers.format(rows.length) : "";
    let description = "No activity";
    if (state) {
      const count = counts.get(state);
      const status = statuses[state][count === 1 ? "one" : "many"];
      const itemCount = total.textContent + (rows.length === 1 ? " item" : " items");
      description = itemCount + ". " + numbers.format(count) + " " + status + ".";
    } else {
      requestExpanded(false);
    }
    if (summaryText.textContent !== description) summaryText.textContent = description;
    showState(glyphs, state);
    toggle.disabled = !state;
  }

  surface.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse" || toggle.disabled) return;
    clearTimeout(collapseTimer);
    if (notch.dataset.open === "true") return;

    requestExpanded(true);
    openedByHover = true;
  });
  surface.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse" || notch.dataset.open !== "true") return;
    collapseTimer = setTimeout(() => requestExpanded(false), ${motion.fast});
  });
  surface.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });
  toggle.addEventListener("click", (event) => {
    // The pointer had to hover the header to click it. Treat the first click as an open.
    if (event.detail > 0 && openedByHover) {
      openedByHover = false;
      return;
    }
    requestExpanded(notch.dataset.open !== "true");
  });
  notch.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !setExpanded(false)) return;
    event.preventDefault();
    bridge.setExpanded(false);
  });
  bridge.onCollapse(() => setExpanded(false));
  bridge.onLayout(applyLayout);
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
  <style nonce="${nonce}">${activityNotchStyles}</style>
</head>
<body>
  <main class="notch" data-open="false">
    <div class="notch-body">
      <button class="notch-toggle" type="button" aria-expanded="false" aria-controls="activity-panel" aria-describedby="activity-description" disabled>
        <span id="toggle-action" class="sr-only">Show activity</span>
        <span id="activity-summary" class="wing" aria-hidden="true">${glyphs}</span>
        <span id="activity-count" class="wing count" aria-hidden="true"></span>
      </button>
      <p id="activity-description" class="sr-only" role="status">No activity</p>
      <div id="activity-panel" class="panel" aria-hidden="true" inert>
        <ul class="rows" aria-label="Activity"></ul>
      </div>
    </div>
  </main>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
