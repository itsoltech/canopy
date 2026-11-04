import type { JsonValue as ProtoJson } from "@bufbuild/protobuf";
import type { bots } from "@canopy/contracts";
import type { JsonObject, JsonValue } from "@canopy/domain";

/** Stored on the call and returned to the model as JSON; `JSON.stringify` drops undefined members. */
export type ToolResult = JsonValue | undefined | readonly ToolResult[] | { readonly [key: string]: ToolResult };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonObject;
  source: "platform" | "mcp";
  serverId?: string;
  serverName?: string;
  remoteName?: string;
  readOnly?: boolean;
  dangerous?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  calls?: ToolCall[];
  callId?: string;
}

/** A tool call as a model implementation returns it; the runtime decodes its arguments into a JSON object. */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ModelReply {
  text: string;
  calls: ModelToolCall[];
}

/** A reply whose tool arguments are already decoded (the direct provider APIs). */
export interface DecodedReply extends ModelReply {
  calls: ToolCall[];
}

export interface ModelInput {
  turn?: BotTurn;
  configuration: bots.BotConfiguration;
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export type BotModel = (input: ModelInput) => Promise<ModelReply>;

export interface BotRow {
  id: string;
  owner_user_id: string;
  /** jsonb: the BotConfiguration in its protobuf JSON form. */
  configuration: ProtoJson;
  created_at: Date;
  updated_at: Date;
  revision: string | bigint;
  status_line: string;
  last_read_seq: string | bigint;
  unread_count?: number | string;
  archived_at: Date | null;
  deleted_at: Date | null;
  created_by_bot_id: string | null;
  created_by_bot_name: string;
  /** Stage 8: frozen for or moved by a move to another computer; notes of a bot that moved here. */
  moved_to?: string | null;
  move_notes?: { from_name?: string } | null;
  /** Joined: what the bot that moved here still needs connected on this computer. */
  move_reconnect?: string[] | null;
}

export interface BotTurn {
  id: string;
  bot_id: string;
  input: string;
  hops: number;
  status: string;
  checkpoint: ModelMessage[];
  lease_token: string;
  reply_to_bot_id: string | null;
  exchange_id: string | null;
  remote_recipient_ref?: string | null;
  routine_id: string | null;
  routine_title: string;
  /** jsonb: the BotConfiguration in its protobuf JSON form. */
  handoff_configuration: ProtoJson | null;
  handoff_instance_label: string | null;
  handoff_deadline: Date | null;
}

export interface StoredCall {
  id: string;
  turn_id: string;
  call_key: string;
  tool: ToolSpec;
  arguments: JsonObject;
  status: string;
  result: ToolResult;
}

export interface McpConnection {
  namespace?: string;
  id: string;
  name: string;
  url: string;
  transport: string;
  enabled: boolean;
  headers: Record<string, string>;
}
