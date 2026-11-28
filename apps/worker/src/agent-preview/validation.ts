import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentPreviewInputBatchSchema,
  AgentPreviewInputSchema,
  RunAgentToolSchema,
  type AgentPreviewInput,
  type StartAgentPreview,
} from "@canopy/contracts";
import {
  LOGIN_NAME_MAX,
  LOGIN_PREVIEW_TEXT_MAX_BYTES,
  LOGIN_WEBSITE_MAX,
  LOGIN_WEBSITES_MAX,
} from "@canopy/domain/project-logins";
import { agentToolSession } from "../agent-tools/scope.ts";

const INPUT_KINDS = new Set([
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
  // A project login field the owner chose; the gateway resolved the value (browser only).
  "login-text",
]);

export function previewScope(start: StartAgentPreview) {
  if (
    !start.previewId ||
    start.previewId.length > 128 ||
    !start.threadId ||
    start.threadId.length > 128 ||
    !start.scope
  )
    throw new Error("Preview requires a bounded preview ID, thread ID and tool scope");
  const scope = start.scope;

  if (![AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE].includes(scope.tool))
    throw new Error("Unknown preview tool");

  if (start.followAgent && scope.tool !== AgentTool.DESKTOP)
    throw new Error("Only Desktop Preview can follow the agent");

  if (scope.target || scope.value || (scope.operation && scope.operation !== "screenshot"))
    throw new Error("Preview scope does not accept operations or action arguments");

  if (scope.session && agentToolSession(scope.session) !== agentToolSession(start.threadId))
    throw new Error("Preview must use the current thread session");

  return create(RunAgentToolSchema, {
    ...scope,
    // Activity selectors can disappear on the next qualified ref. All passive watches share the native session target.
    ...(start.followAgent && { app: "", windowId: "" }),
    operation: "screenshot",
    session: agentToolSession(start.threadId),
  });
}

const LOGIN_FIELDS = new Set(["username", "password", "one_time_code"]);

/** A project login value the gateway resolved: bounded by the login limits, never by keyboard input's. */
function validateLogin(input: AgentPreviewInput): void {
  const login = input.login;

  if ((input.kind === "login-text") !== Boolean(login)) throw new Error("Unsupported preview login input");

  if (!login) return;

  if (
    !login.name ||
    login.name.length > LOGIN_NAME_MAX ||
    !login.text ||
    Buffer.byteLength(login.text) > LOGIN_PREVIEW_TEXT_MAX_BYTES ||
    login.text.includes("\0") ||
    !login.websites.length ||
    login.websites.length > LOGIN_WEBSITES_MAX ||
    login.websites.some((website) => !website || website.length > LOGIN_WEBSITE_MAX) ||
    !LOGIN_FIELDS.has(login.field) ||
    (login.field === "one_time_code") !== login.expiresAtMs > 0n
  )
    throw new Error("Preview login input exceeds its limit");
}

export function validatePreviewInputs(inputs: readonly AgentPreviewInput[], previewId = ""): void {
  // The batch limit covers pointer and keyboard input; a login value has its own bound (one per batch).
  const bounded = inputs.map((input) => (input.login ? create(AgentPreviewInputSchema, { kind: input.kind }) : input));

  if (
    !inputs.length ||
    inputs.length > 64 ||
    inputs.filter((input) => input.login).length > 1 ||
    toBinary(AgentPreviewInputBatchSchema, create(AgentPreviewInputBatchSchema, { previewId, inputs: bounded }))
      .byteLength >
      32 * 1024
  )
    throw new Error("Preview input batch exceeds its limit");

  for (const input of inputs) {
    if (!INPUT_KINDS.has(input.kind)) throw new Error("Unsupported preview input kind");
    validateLogin(input);

    if (
      Buffer.byteLength(input.text) > 8192 ||
      input.text.includes("\0") ||
      input.key.length > 128 ||
      input.code.length > 128
    )
      throw new Error("Preview keyboard input exceeds its limit");

    if (
      ![input.x, input.y, input.deltaX, input.deltaY].every(Number.isFinite) ||
      input.x < 0 ||
      input.x > 1 ||
      input.y < 0 ||
      input.y > 1 ||
      Math.abs(input.deltaX) > 100_000 ||
      Math.abs(input.deltaY) > 100_000
    )
      throw new Error("Preview pointer coordinates or wheel deltas are invalid");

    if (input.button > 2 || input.buttons > 7 || input.modifiers > 15 || input.width > 8192 || input.height > 8192)
      throw new Error("Preview input flags or dimensions are invalid");

    if (input.kind === "resize" && (!input.width || !input.height))
      throw new Error("Preview resize dimensions must be positive");

    if (input.kind === "navigate") {
      const url = new URL(input.text);

      if (
        !["http:", "https:", "about:"].includes(url.protocol) ||
        (url.protocol === "about:" && url.href !== "about:blank")
      )
        throw new Error("Preview navigation supports HTTP, HTTPS and about:blank");
    }
  }
}
