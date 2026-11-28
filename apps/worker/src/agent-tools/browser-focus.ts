import type { JsonValue } from "@canopy/domain";
import { z } from "zod";
import type { BrowserCdp } from "./browser-cdp.ts";

/** The focused element of one document, through open shadow roots; frames are followed by the worker. */
const ACTIVE_ELEMENT = `function () {
  let element = this.activeElement;
  for (let depth = 0; element && element.shadowRoot && element.shadowRoot.activeElement && depth < 32; depth++)
    element = element.shadowRoot.activeElement;
  return element;
}`;

const DESCRIBE = `function () {
  const frame = this.tagName === "IFRAME" || this.tagName === "FRAME";
  const blocked = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  const editable = !this.disabled && !this.readOnly && (this.isContentEditable || this.tagName === "TEXTAREA" ||
    (this.tagName === "INPUT" && !blocked.includes(this.type)));
  return { frame, editable };
}`;

/**
 * Replace the content of this element as typing would, without moving focus: the value goes to this element
 * only, wherever focus is by now. Frameworks see the input and change events of a user edit.
 */
const WRITE = `function (text) {
  if (!this.isConnected) return false;
  const view = this.ownerDocument.defaultView;
  if (this.isContentEditable) {
    this.focus();
    const selection = this.ownerDocument.getSelection();
    selection.selectAllChildren(this);
    if (!this.ownerDocument.execCommand("insertText", false, text)) this.textContent = text;
    return true;
  }
  const prototype = this.tagName === "TEXTAREA" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
  this.focus();
  setter.call(this, text);
  this.dispatchEvent(new view.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
  this.dispatchEvent(new view.Event("change", { bubbles: true }));
  return true;
}`;

const remoteObject = z.object({ result: z.object({ objectId: z.string().optional() }) });
const resolved = z.object({ object: z.object({ objectId: z.string().optional() }) });
const described = z.object({ result: z.object({ value: z.object({ frame: z.boolean(), editable: z.boolean() }) }) });
const written = z.object({ result: z.object({ value: z.literal(true) }) });

const frameOwner = z.object({
  node: z.object({
    frameId: z.string().optional(),
    contentDocument: z.object({ backendNodeId: z.number() }).optional(),
  }),
});

interface FrameTree {
  frame: { id: string; securityOrigin: string };
  childFrames?: FrameTree[] | undefined;
}

const frameTree: z.ZodType<FrameTree> = z.lazy(() =>
  z.object({
    frame: z.object({ id: z.string(), securityOrigin: z.string() }),
    childFrames: z.array(frameTree).optional(),
  }),
);

const tree = z.object({ frameTree });
const attachedSession = z.object({ sessionId: z.string() });

export interface FocusedField {
  /** The origin Chrome assigned to the frame that holds the field. Page scripts cannot change it. */
  origin: string;
  editable: boolean;
  /** The flattened session of a cross-origin frame, if the field is inside one. */
  sessionId: string | undefined;
  /** That frame's target: its requests are intercepted separately from the tab's. */
  frameTarget: string | undefined;
  objectId: string;
}

function findFrame(node: FrameTree, id: string): FrameTree["frame"] | undefined {
  if (node.frame.id === id) return node.frame;

  for (const child of node.childFrames ?? []) {
    const found = findFrame(child, id);

    if (found) return found;
  }

  return undefined;
}

async function frames(cdp: BrowserCdp, sessionId: string | undefined): Promise<FrameTree> {
  return tree.parse(await cdp.sendTo(sessionId, "Page.getFrameTree")).frameTree;
}

async function objectIn(
  cdp: BrowserCdp,
  sessionId: string | undefined,
  method: string,
  params: Record<string, JsonValue>,
) {
  return remoteObject.parse(await cdp.sendTo(sessionId, method, params)).result.objectId;
}

/**
 * The element that has focus, with the origin of the frame that holds it as Chrome reports it. Frames are
 * followed here, not by page script: a same-process frame through its content document, a cross-origin frame
 * through its own target.
 */
export async function focusedField(cdp: BrowserCdp): Promise<FocusedField | undefined> {
  let sessionId: string | undefined = cdp.sessionId;
  let frameTarget: string | undefined;
  let frameId = (await frames(cdp, sessionId)).frame.id;
  let document = await objectIn(cdp, sessionId, "Runtime.evaluate", { expression: "document", returnByValue: false });

  for (let depth = 0; document && depth < 8; depth++) {
    const element = await objectIn(cdp, sessionId, "Runtime.callFunctionOn", {
      objectId: document,
      functionDeclaration: ACTIVE_ELEMENT,
      returnByValue: false,
    });

    if (!element) return;

    const info = described.parse(
      await cdp.sendTo(sessionId, "Runtime.callFunctionOn", {
        objectId: element,
        functionDeclaration: DESCRIBE,
        returnByValue: true,
      }),
    ).result.value;

    if (!info.frame) {
      const frame = findFrame(await frames(cdp, sessionId), frameId);

      return (
        frame && { origin: frame.securityOrigin, editable: info.editable, sessionId, frameTarget, objectId: element }
      );
    }

    const owner = frameOwner.parse(await cdp.sendTo(sessionId, "DOM.describeNode", { objectId: element })).node;

    if (!owner.frameId) return;
    frameId = owner.frameId;

    if (owner.contentDocument) {
      document = resolved.parse(
        await cdp.sendTo(sessionId, "DOM.resolveNode", { backendNodeId: owner.contentDocument.backendNodeId }),
      ).object.objectId;
      continue;
    }

    frameTarget = owner.frameId;
    sessionId = attachedSession.parse(
      await cdp.sendTo(undefined, "Target.attachToTarget", { targetId: owner.frameId, flatten: true }),
    ).sessionId;
    document = await objectIn(cdp, sessionId, "Runtime.evaluate", { expression: "document", returnByValue: false });
  }

  return undefined;
}

/** Write into the verified element itself; fails if the element left its document meanwhile. */
export async function writeField(cdp: BrowserCdp, field: FocusedField, text: string): Promise<boolean> {
  const result = await cdp
    .sendTo(field.sessionId, "Runtime.callFunctionOn", {
      objectId: field.objectId,
      functionDeclaration: WRITE,
      arguments: [{ value: text }],
      returnByValue: true,
    })
    .catch(() => undefined);

  return written.safeParse(result).success;
}

export async function pressEnter(cdp: BrowserCdp): Promise<void> {
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", ...key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

/** The tab's origin as Chrome reports it, or undefined for a page that is not http or https. */
export async function pageOrigin(cdp: BrowserCdp): Promise<string | undefined> {
  const origin = (await frames(cdp, cdp.sessionId)).frame.securityOrigin;

  return /^https?:\/\//.test(origin) ? origin : undefined;
}
