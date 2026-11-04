/** ACP v1 wire types used by Canopy. Extensions remain available through _meta. */
export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text: string; mimeType?: string } };

export type McpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };

export interface InitializeResult {
  protocolVersion: number;
  agentInfo?: { name: string; version: string };
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
    mcpCapabilities?: { http?: boolean; sse?: boolean };
  };
  authMethods?: { id: string; name: string }[];
}

export interface SessionResult {
  sessionId: string;
  modes?: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] };
  models?: { currentModelId: string; availableModels: { modelId: string; name: string; description?: string }[] };
}

export interface ToolCall {
  toolCallId: string;
  title?: string;
  kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: (
    | { type: "content"; content: Content }
    | { type: "diff"; path: string; oldText?: string | null; newText: string }
    | { type: "terminal"; terminalId: string }
  )[];
  locations?: { path: string; line?: number }[];
}

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"; content: Content }
  | ({ sessionUpdate: "tool_call" | "tool_call_update" } & ToolCall)
  | { sessionUpdate: "plan"; entries: { content: string; status: string; priority?: string }[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: "usage_update"; used: number; size: number; cost?: { amount: number; currency: string } };

export interface PermissionRequest {
  sessionId: string;
  toolCall: ToolCall;
  options: { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }[];
}

export type PermissionResult = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };

export interface ClientCallbacks {
  requestPermission?(request: PermissionRequest, signal: AbortSignal): Promise<PermissionResult>;
  readTextFile?(params: {
    sessionId: string;
    path: string;
    line?: number;
    limit?: number;
  }): Promise<{ content: string }>;
  writeTextFile?(params: { sessionId: string; path: string; content: string }): Promise<Record<string, never>>;
  /** Only advertise terminal when every terminal method is handled. */
  terminal?(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
}

export type PromptEvent =
  | { type: "update"; update: SessionUpdate }
  | { type: "complete"; stopReason: string; usage?: unknown };
