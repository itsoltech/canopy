import { createCipheriv, randomBytes } from "node:crypto";
import { noticePreview, safeFailureDetail } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient, type Statement } from "effect/sql";
import type { NoticeInteractionColumns } from "../store/rows.ts";
import { interactionNoticeText } from "../store/thread-notice.ts";
import { livePushJob, type PushJob } from "./store.ts";

type Preview = { title: string; body: string };

const turnLabels = { completed: "Finished", failed: "Failed", interrupted: "Stopped" };

function preview(name: string, fallback: string, label: string, snippet = ""): Preview {
  const excerpt = noticePreview(snippet);

  return { title: noticePreview(name) || fallback, body: excerpt ? `${label} · ${excerpt}` : label };
}

const turnPreview = (sql: SqlClient.SqlClient, job: Statement.Fragment) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{
      title: string;
      status: keyof typeof turnLabels;
      error: string | null;
      message: string | null;
    }>`
      SELECT t.title, u.status, left(u.error, 2000) AS error,
        (SELECT left(m.content->'agentMessage'->>'text', 2000)
         FROM thread_items m WHERE m.thread_id = t.id AND m.turn_id = u.id AND m.type = 'agent_message'
         ORDER BY m.first_seq DESC LIMIT 1) AS message
      FROM ${job} JOIN threads t ON t.id = o.destination_id JOIN turns u ON u.id = o.event_id AND u.thread_id = t.id
      LEFT JOIN thread_reads r ON r.thread_id = t.id AND r.user_id = o.owner_user_id
      WHERE (u.status IN ('completed', 'failed') OR (u.status = 'interrupted' AND u.interrupt_source IS DISTINCT FROM 'user'))
        AND (u.last_seq IS NULL OR u.last_seq > coalesce(r.seen_seq, 0))`;

    if (!row) return;
    const snippet = row.status === "failed" && row.error ? safeFailureDetail(row.error) : (row.message ?? "");

    return preview(row.title, "Untitled thread", turnLabels[row.status], snippet);
  });

const interactionPreview = (sql: SqlClient.SqlClient, job: Statement.Fragment) =>
  Effect.gen(function* () {
    const [row] = yield* sql<NoticeInteractionColumns & { title: string }>`
      SELECT t.title, i.kind, i.tool_name AS tool, i.request
      FROM ${job} JOIN threads t ON t.id = o.destination_id
      JOIN interaction_requests i ON i.id = o.event_id AND i.thread_id = t.id
      WHERE i.status = 'pending' AND (i.expires_at IS NULL OR i.expires_at > now())`;

    if (row)
      return preview(
        row.title,
        "Untitled thread",
        row.kind === "permission" ? "Needs your approval" : "Needs your answer",
        interactionNoticeText(row).slice(0, 2000),
      );

    return undefined;
  });

const botMessagePreview = (sql: SqlClient.SqlClient, job: Statement.Fragment) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{ name: string | null; message: string }>`
      SELECT b.configuration->>'name' AS name, left(m.text, 2000) AS message
      FROM ${job} JOIN bots b ON b.id = o.destination_id
      JOIN bot_messages m ON m.id = o.event_id AND m.bot_id = b.id WHERE m.seq > b.last_read_seq`;

    return row ? preview(row.name ?? "", "Bot", "New message", row.message) : undefined;
  });

const botApprovalPreview = (sql: SqlClient.SqlClient, job: Statement.Fragment) =>
  Effect.gen(function* () {
    const [row] = yield* sql<{ name: string | null; kind: string; prompt: string }>`
      SELECT b.configuration->>'name' AS name, a.kind, left(split_part(a.prompt, chr(10), 1), 2000) AS prompt
      FROM ${job} JOIN bots b ON b.id = o.destination_id JOIN bot_approvals a ON a.id = o.event_id AND a.bot_id = b.id
      WHERE a.status = 'pending' AND (a.expires_at IS NULL OR a.expires_at > now())`;

    if (row)
      return preview(
        row.name ?? "",
        "Bot",
        row.kind === "approval" ? "Needs your approval" : "Needs your answer",
        row.prompt,
      );

    return undefined;
  });

const readSource = {
  turn: turnPreview,
  interaction: interactionPreview,
  message: botMessagePreview,
  approval: botApprovalPreview,
};

export const readPushPreview = (owner: string, job: PushJob) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* readSource[job.event_kind](sql, livePushJob(sql, owner, job));
  });

export function encryptPushPreview(key: Buffer, receiptId: string, content: Preview): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`canopy-push-preview-v1:${receiptId}`));

  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(content), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}
