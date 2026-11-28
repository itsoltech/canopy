import type { JsonValue } from "@canopy/domain";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { BrowserCdp } from "./browser-cdp.ts";
import { browserText } from "./browser-dialogs.ts";
import { CHECK, COLLECT, HIDE, READ, READ_CHECKED, RESTORE } from "./browser-capture-scripts.ts";

// A page with more fields than this is refused rather than captured partly hidden.
const MAX_FIELDS = 20_000;
const BATCH = 200;
const HIDE_MS = 10_000;
const RESTORE_MS = 5_000;
const CHANGED = "A page changed while Canopy hid entered login values, so it discarded the capture. Take it again.";
const FAILED = "Canopy could not hide entered login values in this capture, so it took none. Try again.";

interface FrameTree {
  frame: { id: string; loaderId: string };
  childFrames?: FrameTree[] | undefined;
}

const frameTree: z.ZodType<FrameTree> = z.lazy(() =>
  z.object({
    frame: z.object({ id: z.string(), loaderId: z.string() }),
    childFrames: z.array(frameTree).optional(),
  }),
);

const tree = z.object({ frameTree });
const world = z.object({ executionContextId: z.number() });
const count = z.object({ result: z.object({ value: z.number().int().min(0).max(MAX_FIELDS) }) });
const contents = z.object({ result: z.object({ value: z.array(z.string().nullable()) }) });
const done = z.object({ result: z.object({ value: z.literal(true) }) });

const attached = z.object({
  sessionId: z.string(),
  targetInfo: z.object({ targetId: z.string(), type: z.string() }),
});

/** This target's own frames: a frame in another process, and everything below it, belongs to its own target. */
function ownFrames(node: FrameTree, remote: ReadonlySet<string>, root = true): string[] {
  if (!root && remote.has(node.frame.id)) return [];

  return [node.frame.id, ...(node.childFrames ?? []).flatMap((child) => ownFrames(child, remote, false))];
}

interface FrameSessions {
  sessions: (string | undefined)[];
  /** Frames in their own process: a parent's frame tree lists them, but only their own target can hide them. */
  remote: Set<string>;
}

/** The tab's session and the sessions of its cross-origin frames, which run in their own targets. */
async function frameSessions(cdp: BrowserCdp): Promise<FrameSessions> {
  const sessions: (string | undefined)[] = [cdp.sessionId];
  const remote = new Set<string>();
  const pending: Promise<JsonValue>[] = [];
  const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };

  cdp.onSessionEvent((method, params) => {
    const target = attached.safeParse(params);

    if (method !== "Target.attachedToTarget" || !target.success || target.data.targetInfo.type !== "iframe") return;
    sessions.push(target.data.sessionId);
    remote.add(target.data.targetInfo.targetId);
    pending.push(cdp.sendTo(target.data.sessionId, "Target.setAutoAttach", autoAttach));
  });

  await cdp.send("Target.setAutoAttach", autoAttach);

  // Nested frames attach while their parents' auto-attach completes.
  for (let index = 0; index < pending.length; index++) await pending[index];

  return { sessions, remote };
}

async function hideInFrame(
  cdp: BrowserCdp,
  sessionId: string | undefined,
  frameId: string,
  values: readonly string[],
  hiding: Hiding,
): Promise<void> {
  const contextId = world.parse(
    await cdp.sendTo(sessionId, "Page.createIsolatedWorld", { frameId, worldName: "canopy-capture" }),
  ).executionContextId;

  const evaluate = (expression: string) =>
    cdp.sendTo(sessionId, "Runtime.evaluate", { expression, contextId, returnByValue: true });

  // Registered first: collecting starts a watcher that restoring stops, even if hiding fails.
  hiding.restores.push(async () => void done.parse(await evaluate(RESTORE)));
  const total = count.parse(await evaluate(COLLECT)).result.value;
  const hidden: number[] = [];

  for (let from = 0; from < total; from += BATCH) {
    const texts = contents.parse(await evaluate(READ(from, from + BATCH))).result.value;

    texts.forEach((text, offset) => {
      if (text && values.some((value) => value && text.includes(value))) hidden.push(from + offset);
    });
  }

  // Past the deadline nothing more changes: the caller is restoring what did.
  if (hiding.stopped) throw new Error("Hiding login values took too long.");
  hiding.checks.push(() => stillHidden(evaluate, values));
  done.parse(await evaluate(HIDE(hidden)));
}

/** What restores hidden fields, filled in as each frame changes, and whether hiding must stop. */
interface Hiding {
  readonly restores: (() => Promise<void>)[];
  /** After the capture: whether every field holding a value, including one the page added, still showed dots. */
  readonly checks: (() => Promise<boolean>)[];
  stopped: boolean;
}

const checked = z.object({ result: z.object({ value: z.array(z.tuple([z.string().nullable(), z.boolean()])) }) });

async function stillHidden(evaluate: (expression: string) => Promise<JsonValue>, values: readonly string[]) {
  const total = count.parse(await evaluate(CHECK)).result.value;

  for (let from = 0; from < total; from += BATCH) {
    const fields = checked.parse(await evaluate(READ_CHECKED(from, from + BATCH))).result.value;

    if (fields.some(([text, dots]) => !dots && text && values.some((value) => value && text.includes(value))))
      return false;
  }

  return true;
}

function frameDocuments(node: FrameTree): string[] {
  return [`${node.frame.id}:${node.frame.loaderId}`, ...(node.childFrames ?? []).flatMap(frameDocuments)];
}

/** The documents of the tab's frames: a navigation during a capture changes it. */
async function documents(cdp: BrowserCdp, sessions: readonly (string | undefined)[]): Promise<string> {
  const trees = await Promise.all(sessions.map((sessionId) => cdp.sendTo(sessionId, "Page.getFrameTree")));

  return trees
    .flatMap((result) => frameDocuments(tree.parse(result).frameTree))
    .sort()
    .join("\n");
}

/**
 * Hide fields holding entered values in every frame of the tab. Returns what reads the tab's documents, taken
 * before hiding, so a capture can tell whether the page it shows is the one hidden.
 */
export async function hideEnteredValues(
  cdp: BrowserCdp,
  values: readonly string[],
  hiding: Hiding,
): Promise<{ before: string; now: () => Promise<string> }> {
  const { sessions, remote } = await frameSessions(cdp);
  const now = () => documents(cdp, sessions);
  const before = await now();

  for (const sessionId of sessions) {
    const root = tree.parse(await cdp.sendTo(sessionId, "Page.getFrameTree")).frameTree;

    for (const frameId of ownFrames(root, remote)) await hideInFrame(cdp, sessionId, frameId, values, hiding);
  }

  return { before, now };
}

function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    Bun.sleep(ms).then(() => Promise.reject(new Error("Hiding login values took too long."))),
  ]);
}

/**
 * A screenshot or PDF shows entered values only as dots, even in fields that display text. Every tab is hidden:
 * the capture takes the active one. A result is discarded when a page changed meanwhile. Restoring runs even
 * after cancellation.
 */
export async function captureHidingValues(
  values: readonly string[],
  attach: (signal: AbortSignal) => Promise<BrowserCdp[]>,
  capture: () => Promise<CallToolResult | undefined>,
  signal: AbortSignal,
): Promise<CallToolResult | undefined> {
  const tabs = await attach(signal).catch(() => undefined);

  if (!tabs?.length) return browserText(FAILED, true);
  const hiding: Hiding = { restores: [], checks: [], stopped: false };

  const work = (async () => {
    const pages = [];

    for (const tab of tabs) pages.push(await hideEnteredValues(tab, values, hiding));

    return pages;
  })();

  try {
    const pages = await bounded(work, HIDE_MS).catch(async () => {
      hiding.stopped = true;
      // A frame being hidden at the deadline registers its restore before this returns.
      await bounded(work, RESTORE_MS).catch(() => undefined);
    });

    if (!pages) return browserText(FAILED, true);
    signal.throwIfAborted();
    const result = await capture();

    // A renderer that stops answering must not hold the session's queue: an unverified capture is discarded.
    const verify = async () => {
      for (const page of pages) if ((await page.now().catch(() => "")) !== page.before) return false;

      for (const check of hiding.checks) if (!(await check().catch(() => false))) return false;

      return true;
    };

    const verified = await bounded(verify(), HIDE_MS).catch(() => false);
    signal.throwIfAborted();

    return verified ? result : browserText(CHANGED, true);
  } finally {
    await Promise.allSettled(hiding.restores.map((restore) => bounded(restore(), RESTORE_MS)));

    for (const tab of tabs) tab.close();
  }
}
