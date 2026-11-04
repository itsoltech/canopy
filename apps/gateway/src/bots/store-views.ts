import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots } from "@canopy/contracts";
import { type JsonObject } from "@canopy/domain";
import { Predicate } from "effect";
import { Invalid } from "../store/store.ts";
import { toUiQuote, type StoredQuote } from "../store/quotes.ts";
import { storedMentions } from "./mentions.ts";
import type { BotRow } from "./types.ts";

export interface WakeupRow {
  id: string;
  prompt: string;
  run_at: Date;
  cancelled: boolean;
  delivered: boolean;
}

export interface MessageRow {
  id: string;
  seq: bigint;
  bot_id: string;
  sender_id: string;
  recipient_id: string;
  kind: string;
  text: string;
  exchange_id: string | null;
  created_at: Date;
  message_key?: string;
  turn_status?: string;
  setting_changes?: bots.BotSettingChange[];
  mentions: JsonValue[];
  quotes: StoredQuote[];
}

export interface ApprovalRow {
  id: string;
  bot_id: string;
  turn_id: string;
  kind: string;
  prompt: string;
  status: string;
  answer: string;
  created_at: Date;
  options?: unknown;
  proposed_bot: JsonValue | null;
  routine_title?: string;
}

export const botConfiguration = (row: BotRow) => fromJson(bots.BotConfigurationSchema, row.configuration);

export const botView = (row: BotRow) =>
  create(bots.BotSchema, {
    id: row.id,
    configuration: botConfiguration(row),
    createdAt: timestampFromDate(new Date(row.created_at)),
    updatedAt: timestampFromDate(new Date(row.updated_at)),
    archived: Boolean(row.archived_at),
    createdByBotId: row.created_by_bot_id ?? "",
    createdByBotName: row.created_by_bot_name,
    ownerUserId: row.owner_user_id,
    lastReadSeq: BigInt(row.last_read_seq),
    unreadCount: Number(row.unread_count ?? 0),
    movedFromName: row.move_notes?.from_name ?? "",
    reconnect: row.move_reconnect ?? [],
  });

/** A bot moved from a linked computer: its accounts and MCP servers not connected here yet (docs/linked-computers.md, stage 8). */
export const MOVE_RECONNECT = `(SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM jsonb_array_elements_text(coalesce(b.move_notes -> 'reconnect', '[]'::jsonb)) r
  WHERE NOT EXISTS (SELECT 1 FROM connector_accounts a WHERE a.owner_user_id = b.owner_user_id AND r = a.name || ' (' || a.connector_type || ')'
    AND (a.all_bots OR EXISTS (SELECT 1 FROM connector_bot_grants g WHERE g.account_id = a.id AND g.bot_id = b.id)))
    AND NOT EXISTS (SELECT 1 FROM bot_mcp_connections c JOIN bot_mcp_servers s ON s.id = c.server_id WHERE c.bot_id = b.id AND r = 'MCP server ' || s.name)) AS move_reconnect`;

export const messageView = (row: MessageRow) =>
  create(bots.BotMessageSchema, {
    id: row.id,
    seq: BigInt(row.seq),
    botId: row.bot_id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    kind: row.kind,
    text: row.text,
    exchangeId: row.exchange_id ?? "",
    createdAt: timestampFromDate(new Date(row.created_at)),
    failed: row.kind === "event" && row.message_key === "answer" && row.turn_status === "failed",
    settingChanges: row.setting_changes ?? [],
    mentions: storedMentions(row.mentions),
    quotes: row.quotes.map(toUiQuote),
  });

export const approvalView = (row: ApprovalRow) =>
  create(bots.BotApprovalSchema, {
    id: row.id,
    botId: row.bot_id,
    turnId: row.turn_id,
    kind: row.kind,
    prompt: row.prompt,
    status: row.status,
    answer: row.answer,
    createdAt: timestampFromDate(new Date(row.created_at)),
    options: Array.isArray(row.options)
      ? row.options
          .filter((o): o is string => typeof o === "string" && o.trim() !== "")
          .slice(0, 6)
          .map((o) => o.slice(0, 200))
      : [],
    proposedBot: row.proposed_bot ? fromJson(bots.BotConfigurationSchema, row.proposed_bot) : undefined,
    routineTitle: row.routine_title ?? "",
  });

export const uuid = () => Bun.randomUUIDv7();
export const MAX_BOTS_PER_USER = 50;

export function requiredString(args: JsonObject, key: string, max = 100_000): string {
  const value = args[key];

  if (!Predicate.isString(value) || !value.trim() || value.length > max)
    throw new Invalid(`${key} is required (at most ${max} characters)`);

  return value.trim();
}

export function remoteUrl(raw: string): string {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Invalid("a remote http(s) URL is required");
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw new Invalid("use an http(s) URL without credentials, query or fragment; put tokens in headers");

  // Connection definitions are explicit user input. Redirects are refused by the MCP client.
  return url.toString();
}
