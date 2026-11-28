import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentPreviewEventSchema,
  AgentPreviewInputBatchSchema,
  AgentTool,
  RunAgentToolSchema,
  type AgentPreviewEvent,
  type AgentPreviewInput,
  type ui,
} from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { PROJECT_SECRET_NAME_PATTERN } from "@canopy/domain";
import { validateAgentToolOperation } from "./agent-tools-validation.ts";

const INPUTS = new Set([
  "pointer-move",
  "pointer-down",
  "pointer-up",
  "wheel",
  "key-down",
  "key-up",
  "text",
  "navigate",
  "back",
  "forward",
  "reload",
  "home",
  "release",
  "resize",
  "tab",
  // The owner enters a project login field; the gateway replaces it with the value for the worker.
  "login",
]);

const LOGIN_FIELDS = new Set(["username", "password", "one_time_code"]);

const STATES = new Set(["connecting", "ready", "frame", "error", "closed"]);
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_METADATA = 32 * 1024;
const invalid = (message: string) => new ConnectError(message, Code.InvalidArgument);

function normalized(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function text(value: string, bytes: number, multiline = false): boolean {
  return (
    Buffer.byteLength(value) <= bytes &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);

      return (code < 32 && !(multiline && [9, 10, 13].includes(code))) || (code >= 127 && code <= 159);
    })
  );
}

export function agentPreviewScope(request: ui.WatchAgentPreviewRequest) {
  const scope = request.scope;

  if (!scope || scope.operation || scope.target || scope.value || scope.session)
    throw invalid("Choose a preview tool and target without command or session arguments");

  if (request.maxFps > 20) throw invalid("Preview frame rate must be between 1 and 20");

  if (request.followAgent && scope.tool !== AgentTool.DESKTOP)
    throw invalid("Choose Desktop to follow the agent's window");
  // Catalog-selected Linux/Web previews use --device; the manual adapter has no such selector.
  const catalogDevice = scope.tool === AgentTool.DEVICE && ["linux", "web"].includes(scope.platform);

  if (
    catalogDevice &&
    scope.deviceId &&
    (!text(scope.deviceId, 16_384) || !scope.deviceId.trim() || scope.deviceId.startsWith("-"))
  )
    throw invalid("Choose a bounded, non-option preview device ID");

  const checked = create(RunAgentToolSchema, {
    ...scope,
    operation: "snapshot",
    deviceId: catalogDevice ? "" : scope.deviceId,
  });

  validateAgentToolOperation(checked);

  return create(RunAgentToolSchema, { ...checked, deviceId: scope.deviceId, operation: "", session: request.threadId });
}

export function validatePreviewInputs(inputs: AgentPreviewInput[]): void {
  if (!inputs.length || inputs.length > 64) throw invalid("Send between 1 and 64 bounded preview inputs");

  // The worker bounds a login value separately from the batch: one per batch keeps that bound.
  if (inputs.filter((input) => input.kind === "login").length > 1 || inputs.some((input) => input.login))
    throw invalid("Send one project login field at a time");

  for (const input of inputs) {
    if (
      !INPUTS.has(input.kind) ||
      ![input.x, input.y].every(normalized) ||
      ![input.deltaX, input.deltaY].every((n) => Number.isFinite(n) && Math.abs(n) <= 100_000) ||
      input.button > 2 ||
      input.buttons > 7 ||
      input.modifiers > 15 ||
      input.width > 8192 ||
      input.height > 8192 ||
      !text(input.key, 128) ||
      !text(input.code, 128) ||
      !text(input.text, 8192, input.kind === "text")
    )
      throw invalid("Invalid preview input");

    if (input.kind === "resize" && (!input.width || !input.height)) throw invalid("Invalid preview viewport");

    if (input.kind === "login" && (!LOGIN_FIELDS.has(input.key) || !PROJECT_SECRET_NAME_PATTERN.test(input.text)))
      throw invalid("Choose a project login and one of its fields");

    if (input.kind === "navigate") {
      let url: URL;

      try {
        url = new URL(input.text);
      } catch {
        throw invalid("Enter a valid preview URL");
      }

      if (!["http:", "https:"].includes(url.protocol) && input.text !== "about:blank")
        throw invalid("Choose an HTTP or HTTPS preview URL");
    }
  }

  if (
    toBinary(AgentPreviewInputBatchSchema, create(AgentPreviewInputBatchSchema, { inputs })).byteLength > MAX_METADATA
  )
    throw invalid("Preview input batch is too large");
}

/** Worker data is validated before it can enter the single-frame mailbox. */
export function validPreviewEvent(event: AgentPreviewEvent, tool: AgentTool): boolean {
  if (
    !STATES.has(event.state) ||
    event.targets.length > 64 ||
    event.data.byteLength > MAX_FRAME ||
    ![event.width, event.height, event.viewportWidth, event.viewportHeight].every((n) => n <= 8192) ||
    !text(event.url, 8192) ||
    !text(event.title, 4096) ||
    !text(event.detail, 8192, true) ||
    !text(event.targetId, 1024) ||
    (event.mimeType && !["image/jpeg", "image/png"].includes(event.mimeType)) ||
    (event.mode && !["stream", "screenshots"].includes(event.mode))
  )
    return false;

  const cursor = event.cursor;

  if (
    event.agentObservation &&
    (tool !== AgentTool.DESKTOP ||
      event.state !== "frame" ||
      event.mode !== "screenshots" ||
      event.followingAgent ||
      cursor ||
      (!event.targetId && event.targets.length))
  )
    return false;

  if (
    (event.followingAgent || cursor) &&
    (tool !== AgentTool.DESKTOP || event.state !== "frame" || event.mode !== "screenshots" || !event.targetId)
  )
    return false;

  if (cursor && (!/^[a-zA-Z0-9_-]{1,64}$/.test(cursor.actionId) || ![cursor.x, cursor.y].every(normalized)))
    return false;

  if (
    event.targets.some(
      (target) =>
        !text(target.id, 1024) ||
        !text(target.label, 4096) ||
        !text(target.platform, 64) ||
        !text(target.app, 1024) ||
        !text(target.windowId, 1024) ||
        !text(target.deviceId, 1024),
    )
  )
    return false;

  if (event.state === "frame") {
    if (
      !event.frameId ||
      !event.data.byteLength ||
      !event.width ||
      !event.height ||
      !["image/jpeg", "image/png"].includes(event.mimeType)
    )
      return false;
  } else if (event.data.byteLength) return false;

  return (
    toBinary(AgentPreviewEventSchema, create(AgentPreviewEventSchema, { ...event, data: new Uint8Array() }))
      .byteLength <= MAX_METADATA
  );
}
