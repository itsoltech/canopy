import { randomBytes } from "node:crypto";
import { motion } from "@canopy/ui";
import { icons, iconStyle } from "@canopy/ui/icons";
import { activityNotchMotionScript } from "./activity-notch-motion-script.ts";
import { activityNotchDragScript } from "./activity-notch-drag-script.ts";
import { activityNotchMotionStyles } from "./activity-notch-motion-styles.ts";
import { activityNotchOutlineStyles } from "./activity-notch-outline-styles.ts";
import {
  activityNotchProgressGlyph,
  activityNotchProgressScript,
  activityNotchProgressStyles,
} from "./activity-notch-progress.ts";
import { activityNotchRowScript } from "./activity-notch-row-script.ts";
import { activityNotchRowStyles } from "./activity-notch-row-styles.ts";
import { activityNotchPanelDelay, activityNotchStyles } from "./activity-notch-styles.ts";
import type { ActivityNotchRow } from "./activity-notch.ts";

const easing = (points: readonly number[]) => `cubic-bezier(${points.join(", ")})`;

const statuses = {
  approval: { label: "Needs approval", one: "needs approval", many: "need approval" },
  answer: { label: "Needs an answer", one: "needs an answer", many: "need an answer" },
  failed: { label: "Failed", one: "failed", many: "failed" },
  working: { label: "Working", one: "working", many: "working" },
  completed: { label: "Completed", one: "completed", many: "completed" },
} satisfies Record<ActivityNotchRow["state"], { label: string; one: string; many: string }>;

// The same marks as the thread list: a raised hand when someone has to act. Working and completed share one badge
// that morphs from the ring into the check (activity-notch-progress.ts).
const activityGlyphs = {
  approval: icons["hand-raised"],
  answer: icons["hand-raised"],
  failed: icons["x-circle"],
} satisfies Partial<Record<ActivityNotchRow["state"], readonly string[]>>;

const glyphs = Object.entries(activityGlyphs)
  .map(
    ([state, paths]) =>
      `<span class="state-layer" data-state="${state}"><svg viewBox="${iconStyle.viewBox}" fill="none" stroke="currentColor" stroke-width="${iconStyle.strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg></span>`,
  )
  .concat(
    `<span class="state-layer" data-state="working" data-states="working completed">${activityNotchProgressGlyph}</span>`,
  )
  .join("")
  .concat('<span class="ping"></span>');

/** How long a row that changed state stays out of the notch on its own while the pointer is elsewhere. */
const noticeDuration = 6_000;

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
  const wings = Array.from(toggle.querySelectorAll(".wing"));
  const list = document.querySelector(".rows");
  const leavingRows = document.querySelector(".leaving-rows");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const statuses = ${JSON.stringify(statuses)};
  const numbers = new Intl.NumberFormat("en");
  const rowViews = new Map();
${activityNotchMotionScript}
${activityNotchProgressScript}
  const rowAnimations = new Set();
  let collapseTimer;
  let openedByHover = false;
  let layoutRevision;
  let layoutArea;
  let layoutExpanded = false;
  let noticeId;
  let dismissedNotice;
  let noticeTimer;
  let lingering;
  let latestRows;
  let press;
  let pressFrame;
  let dropped = false;

  function setExpanded(expanded) {
    clearTimeout(collapseTimer);
    openedByHover = false;
    if (!expanded) clearTimeout(noticeTimer);
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
    // The closed list keeps the last notice row while it fades; opening it lists every row again.
    if (expanded && lingering !== undefined) {
      lingering = undefined;
      if (latestRows) renderRows(...latestRows);
    }
    if (setExpanded(expanded)) bridge.setExpanded(expanded);
  }

  function syncPanel() {
    panel.toggleAttribute("data-visible", layoutExpanded && notch.dataset.open === "true");
  }

  /** Hides the row that popped out alone. The next open shows the whole list again. */
  function dismissNotice() {
    clearTimeout(noticeTimer);
    clearTimeout(collapseTimer);
    if (noticeId === undefined) return false;
    dismissedNotice = noticeId;
    lingering = noticeId;
    noticeId = undefined;
    notch.removeAttribute("data-notice");
    setExpanded(false);
    bridge.dismissNotice(dismissedNotice);
    return true;
  }

  function scheduleNotice() {
    clearTimeout(noticeTimer);
    if (!surface.matches(":hover")) noticeTimer = setTimeout(dismissNotice, ${noticeDuration});
  }

  /** Opens the notch with only the notice row, or closes it when the notice ends. Returns the rows to list. */
  function showNotice(rows, notice) {
    if (notice === undefined) dismissedNotice = undefined;
    const next = notice !== dismissedNotice ? notice : undefined;
    if (next !== noticeId) {
      const ended = noticeId !== undefined && next === undefined;
      lingering = ended ? noticeId : undefined;
      noticeId = next;
      notch.toggleAttribute("data-notice", next !== undefined);
      if (ended) setExpanded(false);
      if (next !== undefined) {
        setExpanded(true);
        syncPanel();
        scheduleNotice();
      }
    }
    const only = noticeId ?? lingering;
    return only === undefined ? rows : rows.filter((row) => row.id === only);
  }

  function setLengths(entries) {
    for (const [name, value] of entries) notch.style.setProperty(name, value + "px");
  }

  /** On a side edge the closed tab stacks its wings; they glide between the stack and the header with the outline. */
  function setVertical(vertical, animate, shrinking) {
    if (notch.hasAttribute("data-vertical") === vertical) return;
    const before = wings.map((wing) => wing.getBoundingClientRect());
    notch.toggleAttribute("data-vertical", vertical);
    if (!animate || reducedMotion.matches) return;

    for (const [index, wing] of wings.entries()) {
      const from = before[index];
      const to = wing.getBoundingClientRect();
      const dx = from.x + from.width / 2 - to.x - to.width / 2;
      const dy = from.y + from.height / 2 - to.y - to.height / 2;
      wing.animate([{ translate: dx + "px " + dy + "px" }, { translate: "0 0" }], shrinking
        ? { duration: ${motion.fast}, delay: ${motion.stagger}, easing: "${easing(motion.inOut)}", fill: "backwards" }
        : { duration: ${motion.medium}, easing: "${easing(motion.smoothOut)}" });
    }
  }

  function applyLayout({ revision, side, header, draggable, expanded, moving, headerHeight, shape, tab, list }) {
    layoutRevision = revision;
    const animate = notch.hasAttribute("data-layout") && !moving;
    const area = shape.width * shape.height;
    const shrinking = area < (layoutArea ?? area);
    // A move or a new place applies at once: the native window moved with it.
    notch.toggleAttribute("data-animate", animate);
    notch.toggleAttribute("data-shrinking", shrinking);
    layoutArea = area;
    layoutExpanded = expanded;
    // The list fades in once the outline has nearly its open size; the stylesheet holds that delay.
    syncPanel();
    notch.dataset.side = side;
    notch.dataset.header = header;
    notch.toggleAttribute("data-draggable", draggable);
    setLengths([["--x", shape.x], ["--y", shape.y], ["--w", shape.width], ["--h", shape.height], ["--header", headerHeight]]);
    // The list keeps the open place while the outline closes over it.
    if (expanded || !notch.hasAttribute("data-layout")) {
      setLengths([
        ["--list-x", list.x], ["--list-y", list.y], ["--list-w", list.width], ["--list-h", list.height],
        ["--origin-x", tab.x + tab.width / 2 - list.x], ["--origin-y", header === "end" ? list.height : 0],
      ]);
    }
    setVertical((side === "left" || side === "right") && !expanded, animate, shrinking);
    notch.dataset.layout = "";

    const animations = [...notch.getAnimations(), ...surface.getAnimations()];
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (revision === layoutRevision) bridge.layoutSettled(revision);
    });
  }

${activityNotchRowScript}
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

  function renderRows(rows, revision, notice) {
    latestRows = [rows, revision, notice];
    notch.toggleAttribute("data-active", rows.length > 0);
    const listed = showNotice(rows, notice);
    if (!rows.length) {
      setExpanded(false);
      const fades = notch.getAnimations().filter((animation) => animation.transitionProperty === "opacity");
      void Promise.allSettled(fades.map((animation) => animation.finished)).then(() => bridge.hidden(revision));
    }

    const counts = new Map();
    const activeRow = document.activeElement;
    const ids = new Set(listed.map((row) => row.id));
    const orderChanged = listed.length !== list.children.length || listed.some(({ id }, index) => rowViews.get(id)?.item !== list.children[index]);
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
    for (const row of rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
    for (const [index, { id, label, meta, state, projectMark, botMascot }] of listed.entries()) {
      const existing = rowViews.get(id);
      const view = existing ?? createRow(id);
      rowViews.set(id, view);
      // The reveal staggers rows by their place in the list.
      if (view.item.style.getPropertyValue("--i") !== String(index)) view.item.style.setProperty("--i", String(index));
      const fromEnd = String(rows.length - 1 - index);
      if (view.item.style.getPropertyValue("--j") !== fromEnd) view.item.style.setProperty("--j", fromEnd);
      const status = statuses[state].label;
      updateRowMark(view, projectMark, botMascot);
      // A new title or branch in a row already shown swaps like its status; a new row shows them at once.
      setTitle(view, label, Boolean(existing));
      updateRowMeta(view, meta, Boolean(botMascot), Boolean(existing));
      showState(view.status.children, state, existing && "text");
      const project = meta?.project || projectMark?.initials ? ", project " + (meta?.project || projectMark.initials) : "";
      const accessibleLabel = "Open " + label + project + placeDescription(meta) + ", " + status;
      if (view.button.getAttribute("aria-label") !== accessibleLabel) {
        view.button.setAttribute("aria-label", accessibleLabel);
      }
      if (view.item !== nextItem) list.insertBefore(view.item, nextItem);
      nextItem = view.item.nextElementSibling;
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
    const noticeRow = listed.length === 1 && rows.find((row) => row.id === noticeId);
    if (noticeRow) description = noticeRow.label + " " + statuses[noticeRow.state].one + ". " + description;
    if (summaryText.textContent !== description) summaryText.textContent = description;
    if (showState(glyphs, state, "icon") && state) ping(ring, state);
    toggle.disabled = !state;
  }

  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) rowAnimations.forEach((animation) => animation.cancel());
  });
  // The transparent sides of the window pass the pointer through to the apps below.
  surface.addEventListener("pointerenter", () => bridge.setInteractive(true));
  surface.addEventListener("pointerleave", () => {
    if (!press?.moving) bridge.setInteractive(false);
  });
  surface.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse" || toggle.disabled) return;
    clearTimeout(collapseTimer);
    clearTimeout(noticeTimer);
    if (notch.dataset.open === "true") return;

    requestExpanded(true);
    openedByHover = true;
  });
  surface.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse" || notch.dataset.open !== "true" || press?.moving) return;
    // Leaving a notice hides it, so the next open shows every row.
    collapseTimer = setTimeout(() => dismissNotice() || requestExpanded(false), ${motion.fast});
  });
  surface.addEventListener("mousedown", (event) => {
    if (event.target.closest("button")) event.preventDefault();
  });
  toggle.addEventListener("click", (event) => {
    // A drop ends the press on the header; it is not a click.
    if (dropped) {
      dropped = false;
      return;
    }
    // The pointer had to hover the header to click it. Treat the first click as an open.
    if (event.detail > 0 && openedByHover) {
      openedByHover = false;
      return;
    }
    if (dismissNotice()) return;
    requestExpanded(notch.dataset.open !== "true");
  });
  notch.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (dismissNotice()) {
      event.preventDefault();
      return;
    }
    if (!setExpanded(false)) return;
    event.preventDefault();
    bridge.setExpanded(false);
  });
${activityNotchDragScript}
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
  <style nonce="${nonce}">${activityNotchStyles}${activityNotchRowStyles}${activityNotchMotionStyles}${activityNotchOutlineStyles}${activityNotchProgressStyles}</style>
</head>
<body>
  <main class="notch" data-open="false">
    <span class="ear ear-start" aria-hidden="true"></span>
    <span class="ear ear-end" aria-hidden="true"></span>
    <div class="notch-body">
      <button class="notch-toggle" type="button" aria-expanded="false" aria-controls="activity-panel" aria-describedby="activity-description" disabled>
        <span id="toggle-action" class="sr-only">Show activity</span>
        <span class="grip" aria-hidden="true"></span>
        <span id="activity-summary" class="wing summary" aria-hidden="true">${glyphs}</span>
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
