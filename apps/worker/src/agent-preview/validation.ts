import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentPreviewInputBatchSchema,
  RunAgentToolSchema,
  type AgentPreviewInput,
  type StartAgentPreview,
} from "@canopy/contracts";
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

  if (scope.target || scope.value || (scope.operation && scope.operation !== "screenshot"))
    throw new Error("Preview scope does not accept operations or action arguments");

  if (scope.session && agentToolSession(scope.session) !== agentToolSession(start.threadId))
    throw new Error("Preview must use the current thread session");

  return create(RunAgentToolSchema, { ...scope, operation: "screenshot", session: agentToolSession(start.threadId) });
}

export function validatePreviewInputs(inputs: readonly AgentPreviewInput[], previewId = ""): void {
  if (
    !inputs.length ||
    inputs.length > 64 ||
    toBinary(AgentPreviewInputBatchSchema, create(AgentPreviewInputBatchSchema, { previewId, inputs: [...inputs] }))
      .byteLength >
      32 * 1024
  )
    throw new Error("Preview input batch exceeds its limit");

  for (const input of inputs) {
    if (!INPUT_KINDS.has(input.kind)) throw new Error("Unsupported preview input kind");

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
