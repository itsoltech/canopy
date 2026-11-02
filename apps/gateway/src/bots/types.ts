import type { bots } from "@open-agents/contracts";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  source: "platform" | "mcp";
  serverId?: string;
  serverName?: string;
  remoteName?: string;
  readOnly?: boolean;
  dangerous?: boolean;
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  calls?: ToolCall[];
  callId?: string;
}
export interface ModelReply { text: string; calls: ToolCall[] }
export interface ModelInput {
  configuration: bots.BotConfiguration;
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
}
export type BotModel = (input: ModelInput) => Promise<ModelReply>;
export interface BotRow {
  id: string; owner_user_id: string; configuration: unknown;
  created_at: Date; updated_at: Date; revision: string | bigint;
  status_line: string;
  archived_at: Date | null;
}
export interface BotTurn {
  id: string; bot_id: string; input: string; hops: number;
  status: string; checkpoint: ModelMessage[]; lease_token: string;
  reply_to_bot_id: string | null; exchange_id: string | null;
}
export interface StoredCall {
  id: string; turn_id: string; call_key: string; tool: ToolSpec;
  arguments: Record<string, unknown>; status: string; result: unknown;
}
export interface McpConnection {
  id: string; name: string; url: string; transport: string;
  enabled: boolean; headers: Record<string, string>;
}
