import { duration } from "#lib/shared/ui/motion.ts";
import type { MascotShape } from "./mascot.ts";
import { canAnimate, clampEyes, eyeLimits, eyeOffset, idleDelay, type EyeOffset, type MascotState } from "./behaviour-math.ts";
import { watchAnimatedMascots } from "./animated-mascots.ts";

export type { MascotState } from "./behaviour-math.ts";
export interface MascotBehaviour {
  shape: MascotShape;
  alive?: boolean;
  state?: MascotState;
  /** Change this token on a live message, never on a historical row's initial mount. */
  event?: unknown;
  /** A name change gives the same quiet lift as hover. */
  reaction?: string;
  playful?: boolean;
  pupils?: boolean;
}

type Attention = "squash" | "wobble" | "error" | "hop" | "happy" | "lift";
interface Character {
  node: SVGSVGElement;
  eyes: SVGGElement;
  lids: SVGGElement;
  body: SVGGElement;
  options: MascotBehaviour;
  visible: boolean;
  active: boolean;
  hovered: boolean;
  rect: DOMRectReadOnly;
  userTarget?: EyeOffset | undefined;
  gaze: EyeOffset;
  glance: EyeOffset;
  glanceUntil: number;
  blinkAt: number;
  blinkStart: number;
  glanceAt: number;
  phase: number;
  attention?: { kind: Attention; start: number; ms: number } | undefined;
  pending?: Attention | undefined;
  transforms: string[];
}

// One coordinator per screen. No reactive state and no SVG reconstruction on animation frames.
const characters = new Map<SVGSVGElement, Character>();
let observer: IntersectionObserver | undefined;
let sizes: ResizeObserver | undefined;
let dispose: (() => void) | undefined;
let frame = 0;
let lastFrame = 0;
let geometryDirty = true;
let reduced = false;
let enabled = true;
let attentionOwner: Character | undefined;
let pointer = { x: 0, y: 0, at: -Infinity, touch: false };
let timings = { blink: 160, attention: 350, breath: 6000, glance: 1000, ease: 80 };

function awake(c: Character): boolean {
  return canAnimate({ alive: c.options.alive ?? true, reduced: reduced || !enabled, hidden: document.hidden,
    visible: c.visible, size: Math.min(c.rect.width, c.rect.height) });
}

function reset(c: Character): void {
  if (!c.active) return;
  c.active = false;
  c.gaze = { x: 0, y: 0 };
  c.attention = undefined;
  c.blinkStart = 0;
  c.glanceUntil = 0;
  c.transforms = [];
  c.eyes.removeAttribute("transform");
  c.lids.removeAttribute("transform");
  c.body.removeAttribute("transform");
  if (attentionOwner === c) attentionOwner = undefined;
}

function schedule(): void {
  if (frame || reduced || !enabled || document.hidden) return;
  if ([...characters.values()].some((c) => c.visible && c.options.alive !== false)) frame = requestAnimationFrame(tick);
}

function reconcile(): void {
  for (const c of characters.values()) if (!awake(c)) reset(c);
  if (reduced || !enabled || document.hidden) { cancelAnimationFrame(frame); frame = 0; lastFrame = 0; }
  else schedule();
}

function attention(c: Character, kind: Attention, now = performance.now()): void {
  if (!awake(c) || attentionOwner && attentionOwner !== c) return;
  attentionOwner = c;
  c.attention = { kind, start: now, ms: timings.attention * (kind === "wobble" ? 1.4 : 1) };
  schedule();
}

function write(c: Character, group: SVGGElement, value: string, index: number): void {
  if (c.transforms[index] === value) return;
  group.setAttribute("transform", value);
  c.transforms[index] = value;
}

function tick(now: number): void {
  frame = 0;
  if (reduced || !enabled || document.hidden) return;
  const dt = Math.min(64, lastFrame ? now - lastFrame : 16);
  lastFrame = now;
  // Read all geometry before writing any transforms; scroll/resize merely invalidate the cache.
  if (geometryDirty) {
    const composers = new Map<Element, DOMRect>();
    for (const c of characters.values()) if (c.visible) {
      c.rect = c.node.getBoundingClientRect();
      if (c.options.state === "waiting") {
        const composer = c.node.closest("[data-mascot-chat]")?.querySelector("textarea");
        if (composer) {
          const rect = composers.get(composer) ?? composer.getBoundingClientRect();
          composers.set(composer, rect);
          c.userTarget = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
    }
    geometryDirty = false;
  }
  let count = 0;
  for (const c of characters.values()) {
    if (!awake(c)) { reset(c); continue; }
    count++;
    if (!c.active) {
      c.active = true;
      c.blinkAt = now + idleDelay("blink");
      c.glanceAt = now + idleDelay("glance");
    }
    if (c.pending) { attention(c, c.pending, now); c.pending = undefined; }
    const state = c.options.state ?? "idle";
    const working = state === "working" || state === "typing";
    const limit = eyeLimits(c.options.shape, c.options.pupils);
    let target: EyeOffset = { x: 0, y: 0 };
    const recentPointer = now - pointer.at < (pointer.touch ? timings.glance : 5000);
    if (c.hovered || recentPointer && !working && state !== "waiting") {
      target = eyeOffset(pointer.x - (c.rect.x + c.rect.width / 2), pointer.y - (c.rect.y + c.rect.height / 2), c.options.shape, c.options.pupils);
    } else if (working) target = clampEyes({ x: -limit.x * 0.7, y: limit.y * 0.65 }, limit);
    else if (state === "waiting") {
      target = c.userTarget
        ? eyeOffset(c.userTarget.x - (c.rect.x + c.rect.width / 2), c.userTarget.y - (c.rect.y + c.rect.height / 2), c.options.shape, c.options.pupils)
        : clampEyes({ x: 0, y: limit.y }, limit);
    } else if (now - pointer.at > 5000 && now >= c.glanceAt) {
      c.glance = clampEyes({ x: (Math.random() - 0.5) * limit.x, y: (Math.random() - 0.5) * limit.y }, limit);
      c.glanceUntil = now + timings.glance;
      c.glanceAt = now + idleDelay("glance");
    }
    if (!working && state === "idle" && !c.hovered && !recentPointer && now < c.glanceUntil) target = c.glance;
    const ease = 1 - Math.exp(-dt / timings.ease);
    c.gaze.x += (target.x - c.gaze.x) * ease;
    c.gaze.y += (target.y - c.gaze.y) * ease;
    write(c, c.eyes, `translate(${c.gaze.x.toFixed(3)} ${c.gaze.y.toFixed(3)})`, 0);

    if (now >= c.blinkAt && !c.blinkStart) { c.blinkStart = now; c.blinkAt = now + idleDelay("blink"); }
    const blinkProgress = c.blinkStart ? (now - c.blinkStart) / timings.blink : 1;
    let lid = blinkProgress < 1 ? 1 - 0.92 * Math.sin(blinkProgress * Math.PI) ** 2 : 1;
    if (blinkProgress >= 1) c.blinkStart = 0;
    const breath = Math.sin(now / timings.breath * Math.PI * 2 + c.phase);
    let scaleX = 1 + breath * 0.006;
    let scaleY = scaleX;
    let y = working ? breath * 0.18 : 0;
    let x = 0;
    let angle = 0;
    if (c.attention) {
      const p = Math.min(1, (now - c.attention.start) / c.attention.ms);
      const wave = Math.sin(p * Math.PI);
      switch (c.attention.kind) {
        case "squash": scaleX += wave * 0.016; scaleY -= wave * 0.02; break;
        case "wobble": angle = Math.sin(p * Math.PI * 4) * (1 - p) * 3; break;
        case "error": x = Math.sin(p * Math.PI * 6) * (1 - p) * 0.65; break;
        case "hop": y -= wave * 0.7; break;
        case "lift": y -= wave * 0.45; break;
        case "happy": lid = Math.min(lid, 1 - wave * 0.7); break;
      }
      if (p === 1) { c.attention = undefined; if (attentionOwner === c) attentionOwner = undefined; }
    }
    write(c, c.lids, `translate(20 ${c.options.shape.eyeY}) scale(1 ${lid.toFixed(3)}) translate(-20 ${-c.options.shape.eyeY})`, 1);
    write(c, c.body, `translate(${x.toFixed(3)} ${y.toFixed(3)}) translate(20 24) rotate(${angle.toFixed(3)}) scale(${scaleX.toFixed(4)} ${scaleY.toFixed(4)}) translate(-20 -24)`, 2);
  }
  if (count) frame = requestAnimationFrame(tick);
  else lastFrame = 0;
}

function connect(): void {
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  reduced = media.matches;
  const readTimings = () => {
    timings = { blink: (duration("micro") || 80) * 2, attention: duration("medium") || 350,
      breath: (duration("very-slow") || 500) * 12, glance: (duration("very-slow") || 500) * 2, ease: duration("micro") || 80 };
  };
  readTimings();
  const motion = () => { reduced = media.matches; if (!reduced) readTimings(); reconcile(); };
  const invalidate = () => { geometryDirty = true; schedule(); };
  const move = (event: PointerEvent) => {
    if (reduced || !enabled || document.hidden || event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY, at: performance.now(), touch: false };
    schedule();
  };
  const tap = (event: PointerEvent) => {
    if (reduced || !enabled || document.hidden) return;
    pointer = { x: event.clientX, y: event.clientY, at: performance.now(), touch: event.pointerType === "touch" };
    schedule();
  };
  const focus = (event: FocusEvent) => {
    if (reduced || !enabled || document.hidden || !(event.target instanceof HTMLElement)) return;
    const rect = event.target.getBoundingClientRect();
    pointer = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, at: performance.now(), touch: true };
    schedule();
  };
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const c = characters.get(entry.target as SVGSVGElement);
      if (c) { c.visible = entry.isIntersecting; c.rect = entry.boundingClientRect; if (!c.visible) reset(c); }
    }
    geometryDirty = true;
    schedule();
  });
  sizes = new ResizeObserver(invalidate);
  const preference = watchAnimatedMascots((value) => { enabled = value; reconcile(); });
  media.addEventListener("change", motion);
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("pointerdown", tap, { passive: true });
  window.addEventListener("focusin", focus);
  window.addEventListener("scroll", invalidate, { passive: true, capture: true });
  window.addEventListener("resize", invalidate, { passive: true });
  document.addEventListener("visibilitychange", reconcile);
  dispose = () => {
    preference();
    media.removeEventListener("change", motion);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerdown", tap);
    window.removeEventListener("focusin", focus);
    window.removeEventListener("scroll", invalidate, true);
    window.removeEventListener("resize", invalidate);
    document.removeEventListener("visibilitychange", reconcile);
    observer?.disconnect(); sizes?.disconnect(); cancelAnimationFrame(frame);
    frame = 0; lastFrame = 0; attentionOwner = undefined;
    pointer = { x: 0, y: 0, at: -Infinity, touch: false };
  };
}

/** Svelte action with optional parameters. Updates do not re-register listeners or reset idle clocks. */
export function mascotBehaviour(node: SVGSVGElement, options: MascotBehaviour) {
  if (!characters.size) connect();
  const c: Character = {
    node, options, eyes: node.querySelector<SVGGElement>("[data-mascot-gaze]")!,
    lids: node.querySelector<SVGGElement>("[data-mascot-lids]")!, body: node.querySelector<SVGGElement>("[data-mascot-character]")!,
    visible: false, active: false, hovered: false, rect: node.getBoundingClientRect(), gaze: { x: 0, y: 0 },
    glance: { x: 0, y: 0 }, glanceUntil: 0, blinkAt: 0, blinkStart: 0, glanceAt: 0,
    phase: Math.random() * Math.PI * 2, transforms: [],
  };
  characters.set(node, c);
  observer!.observe(node); sizes!.observe(node);
  const enter = (event: PointerEvent) => { if (event.pointerType === "touch") return; c.hovered = true; attention(c, "lift"); };
  const leave = () => { c.hovered = false; };
  node.addEventListener("pointerenter", enter);
  node.addEventListener("pointerleave", leave);
  return {
    update(next: MascotBehaviour) {
      const previous = c.options;
      c.options = next;
      if (next.event !== undefined && next.event !== previous.event) c.pending = next.playful ? "wobble" : "squash";
      if (next.reaction !== previous.reaction) c.pending = "lift";
      if (next.state !== previous.state) {
        geometryDirty = true;
        if (next.state === "waiting") c.pending = "hop";
        if (next.state === "done") c.pending = "happy";
        if (next.state === "error") c.pending = "error";
      }
      if (!awake(c)) { c.pending = undefined; reset(c); }
      schedule();
    },
    destroy() {
      reset(c);
      node.removeEventListener("pointerenter", enter); node.removeEventListener("pointerleave", leave);
      observer!.unobserve(node); sizes!.unobserve(node); characters.delete(node);
      if (!characters.size) { dispose?.(); dispose = undefined; }
    },
  };
}
