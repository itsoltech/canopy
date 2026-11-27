import { createHash } from "node:crypto";
import { jsonArray, jsonObject, jsonString, type JsonValue } from "./json.ts";

const expoToken = /^(?:ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]{1,128}\]$/;
const uuidV4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const previewEncoding = /^[A-Za-z0-9_-]{40,2700}$/;
const badgeEncoding = /^[A-Za-z0-9_-]{40,120}$/;
const maxDismissed = 32;
const ticketId = /^[A-Za-z0-9_-]{1,128}$/;
const secret = /^[A-Za-z0-9_-]{43}$/;

export type PushPlatform = "ios" | "android";

export interface PushTarget {
  token: string;
  platform: PushPlatform;
}

export interface Push extends PushTarget {
  receiptId: string;
  preview?: string;
}

/** A silent push that lists receipts the phone may remove. Only iOS carries the encrypted badge. */
export interface Dismissal extends PushTarget {
  dismissId: string;
  receiptIds: string[];
  badge?: string;
}

export function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function isSecret(value: JsonValue | undefined): value is string {
  return jsonString(value) && secret.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}

export function isExpoToken(value: JsonValue | undefined): value is string {
  return jsonString(value) && expoToken.test(value);
}

export function isPushPlatform(value: JsonValue | undefined): value is PushPlatform {
  return value === "ios" || value === "android";
}

export function isUuidV4(value: JsonValue | undefined): value is string {
  return jsonString(value) && uuidV4.test(value);
}

export function isTicketId(value: JsonValue | undefined): value is string {
  return jsonString(value) && ticketId.test(value);
}

export function parsePush(value: JsonValue): Push | undefined {
  if (!jsonObject(value)) return;

  const { token, receiptId, platform, preview } = value;
  const hasPreview = Object.hasOwn(value, "preview");

  if (
    Object.keys(value).length !== (hasPreview ? 4 : 3) ||
    !isExpoToken(token) ||
    !isUuidV4(receiptId) ||
    !isPushPlatform(platform)
  )
    return;

  if (!hasPreview) return { token, receiptId, platform };

  if (
    !jsonString(preview) ||
    !previewEncoding.test(preview) ||
    Buffer.from(preview, "base64url").toString("base64url") !== preview
  )
    return;

  // 40 unpadded base64url characters encode at least 30 bytes: nonce, tag and JSON.
  return { token, receiptId, platform, preview };
}

function canonicalBase64url(value: string, pattern: RegExp) {
  return pattern.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}

export function parseDismissal(value: JsonValue): Dismissal | undefined {
  if (!jsonObject(value)) return;

  const { token, platform, dismissId, receiptIds, badge } = value;
  const hasBadge = Object.hasOwn(value, "badge");

  if (
    Object.keys(value).length !== (hasBadge ? 5 : 4) ||
    !isExpoToken(token) ||
    !isPushPlatform(platform) ||
    !isUuidV4(dismissId) ||
    !jsonArray(receiptIds) ||
    receiptIds.length === 0 ||
    receiptIds.length > maxDismissed
  )
    return;

  const ids: string[] = [];

  for (const id of receiptIds) {
    if (!isUuidV4(id)) return;
    ids.push(id);
  }

  if (new Set(ids).size !== ids.length) return;

  if (!hasBadge) return { token, platform, dismissId, receiptIds: ids };

  if (platform !== "ios" || !jsonString(badge) || !canonicalBase64url(badge, badgeEncoding)) return;

  // 40 characters encode at least nonce, tag and a short JSON body.
  return { token, platform, dismissId, receiptIds: ids, badge };
}

export function parseReceipt(value: JsonValue): string | undefined {
  if (!jsonObject(value) || Object.keys(value).length !== 1) return;

  return isTicketId(value["ticketId"]) ? value["ticketId"] : undefined;
}
