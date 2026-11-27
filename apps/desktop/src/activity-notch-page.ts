import { randomBytes } from "node:crypto";
import { motion } from "@canopy/ui";
import { activityNotchLogoSize } from "@canopy/ui/desktop";
import { icons, iconStyle } from "@canopy/ui/icons";
import { threadSpinner } from "@canopy/ui/thread-row";
import { activityNotchMotionScript } from "./activity-notch-motion-script.ts";
import { activityNotchMotionStyles } from "./activity-notch-motion-styles.ts";
import { activityNotchPanelDelay, activityNotchStyles } from "./activity-notch-styles.ts";
import type { ActivityNotchRow } from "./activity-notch.ts";

const statuses = {
  approval: { label: "Needs approval", one: "needs approval", many: "need approval" },
  answer: { label: "Needs an answer", one: "needs an answer", many: "need an answer" },
  failed: { label: "Failed", one: "failed", many: "failed" },
  working: { label: "Working", one: "working", many: "working" },
  completed: { label: "Completed", one: "completed", many: "completed" },
} satisfies Record<ActivityNotchRow["state"], { label: string; one: string; many: string }>;

// The same marks as the thread list: a raised hand when someone has to act, the shared ring while working.
const activityGlyphs = {
  approval: icons["hand-raised"],
  answer: icons["hand-raised"],
  failed: icons["x-circle"],
  working: [],
  completed: icons["check-circle"],
} satisfies Record<ActivityNotchRow["state"], readonly string[]>;

const { center, radius: ring, strokeWidth, trackOpacity, path } = threadSpinner;
const spinner = `<svg class="spinner" viewBox="${threadSpinner.viewBox}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round"><circle cx="${center}" cy="${center}" r="${ring}" opacity="${trackOpacity}"/><path d="${path}"/></svg>`;

const glyphs = Object.entries(activityGlyphs)
  .map(([state, paths]) => {
    const icon = paths.length
      ? `<svg viewBox="${iconStyle.viewBox}" fill="none" stroke="currentColor" stroke-width="${iconStyle.strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>`
      : spinner;

    return `<span class="state-layer" data-state="${state}">${icon}</span>`;
  })
  .join("")
  .concat('<span class="ping"></span>');

const script = `
  const bridge = window.canopyActivityNotch;
  const notch = document.querySelector(".notch");
  const surface = document.querySelector(".notch-body");
  const toggle = document.querySelector(".notch-toggle");
  const toggleAction = document.getElementById("toggle-action");
  const panel = document.getElementById("activity-panel");
  const summary = document.getElementById("activity-summary");
  const summaryText = document.getElementById("activity-description");
  const glyphs = summary.querySelectorAll(".state-layer");
  const ring = summary.querySelector(".ping");
  const total = document.getElementById("activity-count");
  const list = document.querySelector(".rows");
  const leavingRows = document.querySelector(".leaving-rows");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const statuses = ${JSON.stringify(statuses)};
  const logoSize = ${activityNotchLogoSize};
  const logoBytes = logoSize * logoSize * 4;
  const encodedLogoLength = Math.ceil(logoBytes / 3) * 4;
  const numbers = new Intl.NumberFormat("en");
  const rowViews = new Map();
${activityNotchMotionScript}
  const rowAnimations = new Set();
  let collapseTimer;
  let openedByHover = false;
  let layoutRevision;
  let layoutHeight;

  function setExpanded(expanded) {
    clearTimeout(collapseTimer);
    openedByHover = false;
    if (notch.dataset.open === String(expanded)) return false;

    if (!expanded && panel.contains(document.activeElement)) toggle.focus({ preventScroll: true });
    if (!expanded) panel.removeAttribute("data-visible");
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

  function applyLayout({ center, width, height, headerHeight, revision }) {
    layoutRevision = revision;
    if (notch.hasAttribute("data-layout")) notch.dataset.animate = "";
    notch.toggleAttribute("data-shrinking", height < (layoutHeight ?? height));
    layoutHeight = height;
    // The list fades in once the outline has nearly its open size; the stylesheet holds that delay.
    panel.toggleAttribute("data-visible", height > headerHeight && notch.dataset.open === "true");
    notch.style.setProperty("--notch-center", center + "px");
    notch.style.setProperty("--notch-width", width + "px");
    notch.style.setProperty("--notch-size", height + "px");
    notch.style.setProperty("--notch-height", headerHeight + "px");
    if (height > headerHeight) notch.style.setProperty("--open-width", width + "px");
    notch.dataset.layout = "";

    const animations = [...notch.getAnimations(), ...surface.getAnimations()];
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (revision === layoutRevision) bridge.layoutSettled(revision);
    });
  }

  function createRow(id) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const badge = document.createElement("span");
    const text = document.createElement("span");
    const label = document.createElement("span");
    const detail = document.createElement("span");
    const status = document.createElement("span");
    button.type = "button";
    button.className = "row";
    badge.className = "row-mark";
    badge.hidden = true;
    badge.setAttribute("aria-hidden", "true");
    text.className = "row-text";
    label.className = "truncate";
    label.dir = "auto";
    detail.className = "row-detail truncate";
    detail.dir = "auto";
    detail.hidden = true;
    text.append(label, detail);
    status.className = "row-status";
    status.setAttribute("aria-hidden", "true");
    for (const [state, { label }] of Object.entries(statuses)) {
      const layer = document.createElement("span");
      layer.className = "status state-layer";
      layer.dataset.state = state;
      layer.textContent = label;
      status.append(layer);
    }
    button.append(badge, text, status);
    item.append(button);
    button.addEventListener("click", () => bridge.open(id));
    return { item, button, badge, label, detail, status };
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

  function updateRowMark(view, mark, mascot) {
    const previous = view.projectMark;
    if (
      view.botMascot === mascot &&
      previous?.initials === mark?.initials &&
      previous?.foreground === mark?.foreground &&
      previous?.background === mark?.background &&
      previous?.pixels === mark?.pixels
    ) return;

    const image = mascot ? document.createElement("img") : projectLogo(mark?.pixels);
    if (mascot) {
      image.alt = "";
      image.src = mascot;
    }
    view.badge.replaceChildren(image ?? mark?.initials ?? "");
    view.badge.style.color = mark?.foreground ?? "";
    view.badge.style.backgroundColor = image ? "" : mark?.background ?? "";
    view.badge.hidden = !mark && !mascot;
    view.projectMark = mark;
    view.botMascot = mascot;
  }

  function animateRow(item, frames, duration, delay = 0) {
    const animation = item.animate(frames, {
      duration, delay, fill: "backwards", easing: "cubic-bezier(${motion.smoothOut.join(", ")})",
    });
    rowAnimations.add(animation);
    const forget = () => rowAnimations.delete(animation);
    void animation.finished.then(forget, forget);
    return animation;
  }

  function removeRow(item, position, viewport) {
    if (!position || position.rect.bottom <= viewport.top || position.rect.top >= viewport.bottom) {
      item.remove();
      return;
    }

    const origin = leavingRows.getBoundingClientRect();
    const { left, top, width, bottom } = position.rect;
    item.getAnimations().forEach((animation) => animation.cancel());
    item.style.left = left - origin.left + "px";
    item.style.top = top - origin.top + "px";
    item.style.width = width + "px";
    item.style.clipPath = "inset(" + Math.max(0, viewport.top - top) + "px 0 " + Math.max(0, bottom - viewport.bottom) + "px)";
    leavingRows.append(item);
    const remove = () => item.remove();
    void animateRow(item, { opacity: [position.opacity, 0] }, ${motion.micro}).finished.then(remove, remove);
  }

  function animateList(positions) {
    const items = Array.from(list.children);
    for (const item of items) item.getAnimations().forEach((animation) => animation.cancel());

    const bottom = surface.getBoundingClientRect().bottom;
    const moved = items.map((item) => ({ item, current: item.getBoundingClientRect(), previous: positions.get(item) }));
    for (const { item, current, previous } of moved) {
      if (!previous) {
        const delay = current.bottom > bottom ? ${activityNotchPanelDelay} : 0;
        animateRow(item, { opacity: [0, 1], translate: ["0 ${motion.distance.micro}px", "0 0"] }, ${motion.micro}, delay);
      } else {
        const offset = previous.rect.top - current.top;
        if (Math.abs(offset) >= 0.5 || previous.opacity < 1) {
          animateRow(item, { opacity: [previous.opacity, 1], translate: ["0 " + offset + "px", "0 0"] }, ${motion.quick});
        }
      }
    }
  }

  function renderRows(rows, revision) {
    notch.toggleAttribute("data-active", rows.length > 0);
    if (!rows.length) {
      setExpanded(false);
      const fades = notch.getAnimations().filter((animation) => animation.transitionProperty === "opacity");
      void Promise.allSettled(fades.map((animation) => animation.finished)).then(() => bridge.hidden(revision));
    }

    const counts = new Map();
    const activeRow = document.activeElement;
    const ids = new Set(rows.map((row) => row.id));
    const orderChanged = rows.length !== list.children.length || rows.some(({ id }, index) => rowViews.get(id)?.item !== list.children[index]);
    const positions = orderChanged && panel.hasAttribute("data-visible") && !reducedMotion.matches
      ? new Map(Array.from(list.children, (item) => [item, { rect: item.getBoundingClientRect(), opacity: Number(getComputedStyle(item).opacity) }]))
      : undefined;
    const viewport = positions && list.getBoundingClientRect();
    for (const [id, view] of rowViews) {
      if (ids.has(id)) continue;
      if (view.button === activeRow) toggle.focus({ preventScroll: true });
      removeRow(view.item, positions?.get(view.item), viewport);
      rowViews.delete(id);
    }

    let nextItem = list.firstElementChild;
    for (const [index, { id, label, detail, state, projectMark, botMascot }] of rows.entries()) {
      const existing = rowViews.get(id);
      const view = existing ?? createRow(id);
      rowViews.set(id, view);
      // The reveal staggers rows by their place in the list.
      if (view.item.style.getPropertyValue("--i") !== String(index)) view.item.style.setProperty("--i", String(index));
      const status = statuses[state].label;
      updateRowMark(view, projectMark, botMascot);
      if (view.label.textContent !== label) {
        view.label.textContent = label;
        view.label.title = label;
      }
      if (view.detail.textContent !== (detail ?? "")) {
        view.detail.textContent = detail ?? "";
        view.detail.title = detail ?? "";
        view.detail.hidden = !detail;
      }
      showState(view.status.children, state, existing && "text");
      const project = projectMark ? ", project " + projectMark.initials : "";
      const accessibleLabel = "Open " + label + project + (detail ? ", " + detail : "") + ", " + status;
      if (view.button.getAttribute("aria-label") !== accessibleLabel) {
        view.button.setAttribute("aria-label", accessibleLabel);
      }
      if (view.item !== nextItem) list.insertBefore(view.item, nextItem);
      nextItem = view.item.nextElementSibling;
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    if (list.contains(activeRow) && document.activeElement !== activeRow) activeRow.focus({ preventScroll: true });
    if (positions) animateList(positions);

    const state = Object.keys(statuses).find((candidate) => counts.has(candidate));
    const formattedCount = renderCount(rows.length);
    let description = "No activity";
    if (state) {
      const count = counts.get(state);
      const status = statuses[state][count === 1 ? "one" : "many"];
      const itemCount = formattedCount + (rows.length === 1 ? " item" : " items");
      description = itemCount + ". " + numbers.format(count) + " " + status + ".";
    }
    if (summaryText.textContent !== description) summaryText.textContent = description;
    if (showState(glyphs, state, "icon") && state) ping(ring, state);
    toggle.disabled = !state;
  }

  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) rowAnimations.forEach((animation) => animation.cancel());
  });
  // The transparent sides of the window pass the pointer through to the apps below.
  surface.addEventListener("pointerenter", () => bridge.setInteractive(true));
  surface.addEventListener("pointerleave", () => bridge.setInteractive(false));
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>Canopy activity</title>
  <style nonce="${nonce}">${activityNotchStyles}${activityNotchMotionStyles}</style>
</head>
<body>
  <main class="notch" data-open="false">
    <div class="notch-body">
      <button class="notch-toggle" type="button" aria-expanded="false" aria-controls="activity-panel" aria-describedby="activity-description" disabled>
        <span id="toggle-action" class="sr-only">Show activity</span>
        <span id="activity-summary" class="wing" aria-hidden="true">${glyphs}</span>
        <span class="wing count" aria-hidden="true"><span id="activity-count"></span></span>
      </button>
      <p id="activity-description" class="sr-only" role="status">No activity</p>
      <div id="activity-panel" class="panel" aria-hidden="true" inert>
        <ul class="rows" aria-label="Activity"></ul>
        <ul class="leaving-rows" aria-hidden="true" inert></ul>
      </div>
    </div>
  </main>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
