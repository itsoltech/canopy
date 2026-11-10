/** Scripted app-server wire sequence, based on CLIProxyAPI's late-interrupt error; no inference or device data. */
import type { ServerNotification, v2 } from "@canopy/codex-protocol";

export const INTERRUPT_ERROR = JSON.stringify({
  type: "error",
  status: 400,
  error: { message: "no active upstream websocket for response.interrupt", type: "invalid_request_error" },
});

export const turnError: v2.TurnError = {
  message: INTERRUPT_ERROR,
  codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } },
  additionalDetails: null,
  misalignment: null,
};

export function turn(id: string, status: v2.TurnStatus = "inProgress"): v2.Turn {
  return {
    id,
    status,
    rootTurnId: id,
    items: [],
    itemsView: "notLoaded",
    error: status === "failed" ? turnError : null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

export function errorTurn(threadId: string, id: string, willRetry: boolean): ServerNotification[] {
  return [
    { method: "turn/started", params: { threadId, turn: turn(id) } },
    { method: "error", params: { threadId, turnId: id, willRetry, error: turnError } },
    { method: "thread/status/changed", params: { threadId, status: { type: "systemError" } } },
    commentary(threadId, id, "Work continues after the provider notice"),
  ];
}

export function commentary(threadId: string, turnId: string, text: string): ServerNotification {
  return {
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: 0,
      item: {
        type: "agentMessage",
        id: `message-${turnId}-${text}`,
        text,
        phase: "commentary",
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    },
  };
}

export function completed(threadId: string, id: string, status: v2.TurnStatus = "completed"): ServerNotification {
  return { method: "turn/completed", params: { threadId, turn: turn(id, status) } };
}
