import { decodeAgentBusCall } from "@canopy/domain";
import { Result } from "effect";
import type { ThreadEventInit } from "../journal/journal.ts";

export function projectSecretRequest(argumentsJson: string): boolean {
  const decoded = decodeAgentBusCall("request_secret", argumentsJson);

  return (
    Result.isSuccess(decoded) &&
    decoded.success.tool === "request_secret" &&
    Boolean(decoded.success.args.project_secret)
  );
}

function toolContent(event: ThreadEventInit) {
  const body = event.body;

  if (body?.case === "itemStarted" || body?.case === "itemCompleted") return body.value.item?.content;

  return undefined;
}

function isProjectSecretItem(event: ThreadEventInit): boolean {
  const content = toolContent(event);

  if (content?.case === "agentBusCall")
    return content.value.toolName === "request_secret" && projectSecretRequest(content.value.argumentsJson ?? "");

  return (
    content?.case === "toolCall" &&
    !content.value.connectorAccountId &&
    (!content.value.server || content.value.server === "canopy") &&
    content.value.name?.replace(/^mcp__canopy__/, "") === "request_secret" &&
    projectSecretRequest(content.value.inputJson ?? "")
  );
}

export function hideProjectSecretCall(event: ThreadEventInit): ThreadEventInit {
  if (!isProjectSecretItem(event)) return event;
  const safe = structuredClone(event);
  const content = toolContent(safe);
  safe.rawJson = "";

  if (content?.case === "agentBusCall") {
    content.value.argumentsJson = "{}";
    content.value.resultJson = "";
  }

  if (content?.case === "toolCall") {
    content.value.inputJson = "{}";
    content.value.output = "";
  }

  return safe;
}
