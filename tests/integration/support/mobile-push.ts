import { createDecipheriv, randomBytes } from "node:crypto";
import { Provider } from "@canopy/contracts";
import { BasicConstraintsExtension, SubjectAlternativeNameExtension, X509CertificateGenerator } from "@peculiar/x509";
import { Schema } from "effect";
import { eventually, type TestGateway } from "./gateway.ts";

export const readPush = Schema.decodeUnknownPromise(
  Schema.Struct({ token: Schema.String, receiptId: Schema.String, platform: Schema.String, preview: Schema.String }),
);

const readDismissal = Schema.decodeUnknownPromise(
  Schema.Struct({
    token: Schema.String,
    platform: Schema.String,
    dismissId: Schema.String,
    receiptIds: Schema.Array(Schema.String),
    badge: Schema.optionalKey(Schema.String),
  }),
);

export type RelayedPush = Awaited<ReturnType<typeof readPush>>;

export type RelayedDismissal = Awaited<ReturnType<typeof readDismissal>>;

export async function relayCertificate() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: "CN=127.0.0.1",
    keys,
    signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    extensions: [
      new BasicConstraintsExtension(true),
      new SubjectAlternativeNameExtension([{ type: "ip", value: "127.0.0.1" }]),
    ],
  });

  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");

  return {
    cert: certificate.toString("pem"),
    key: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----\n`,
  };
}

/** A manual relay. `dismissStatus` stands in for a relay without the dismissal route (404). */
export async function relayFixture() {
  const tls = await relayCertificate();
  const bearer = randomBytes(32).toString("base64url");
  const received: RelayedPush[] = [];
  const dismissals: RelayedDismissal[] = [];
  const state = { dismissStatus: 204 };

  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${bearer}`) return new Response(null, { status: 401 });

      if (new URL(request.url).pathname === "/v1/dismiss") {
        if (state.dismissStatus !== 204) return new Response(null, { status: state.dismissStatus });
        dismissals.push(await readDismissal(await request.json()));

        return new Response(null, { status: 204 });
      }

      received.push(await readPush(await request.json()));

      return Response.json({ ticketId: "expo-ticket" }, { status: 202 });
    },
  });

  return { relay, options: { origin: relay.url.origin, ca: tls.cert, bearer }, received, dismissals, state };
}

function open(envelope: string, key: Buffer, aad: string) {
  const bytes = Buffer.from(envelope, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(-16));

  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
}

export function openPreview(payload: RelayedPush, key: Buffer, receiptId = payload.receiptId) {
  return open(payload.preview, key, `canopy-push-preview-v1:${receiptId}`);
}

export function openBadge(envelope: string, key: Buffer, dismissId: string) {
  return open(envelope, key, `canopy-push-badge-v1:${dismissId}`);
}

export async function finishPushThread(gateway: TestGateway, snoozed = false) {
  const { api, workerId } = gateway;
  const projectId = (await api.createProject({ name: "Private project" })).project!.id;
  const workspaceId = (await api.createWorkspace({ projectId, workerId, rootPath: "/repo/push" })).workspace!.id;

  const threadId = (
    await api.createThread({ projectId, workspaceId, title: "Private title", provider: Provider.CODEX })
  ).thread!.id;

  await eventually(
    () => api.getThread({ threadId }),
    (result) => result.thread?.status === "idle",
  );

  if (snoozed) await api.setThreadSnooze({ threadId, snoozed: true });

  await api.sendMessage({ threadId, text: "Private reply", clientRequestId: "push-1" });
  await eventually(
    () => api.getThread({ threadId }),
    (result) => result.thread?.unseenResult === "completed",
  );

  return threadId;
}

export async function seedBotPushes(gateway: TestGateway) {
  const query = gateway.core.linkedAgents.query.bind(gateway.core.linkedAgents);
  const botId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();
  await query(
    `INSERT INTO bots (id, owner_user_id, client_request_id, configuration, provider, provider_instance)
      VALUES ($1::uuid, $2::uuid, 'push-bot', '{"name":"Private bot"}', 'codex', 'native')`,
    [botId, gateway.userId],
  );
  await query(
    `INSERT INTO bot_turns (id, bot_id, client_request_id, input, status)
      VALUES ($1::uuid, $2::uuid, 'push-turn', '', 'waiting')`,
    [turnId, botId],
  );

  const [message] = await query<{ seq: string }>(
    `INSERT INTO bot_messages (id, bot_id, turn_id, message_key, sender_id, recipient_id, text)
      VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'push-message', $1::uuid::text, 'user', 'Private message') RETURNING seq`,
    [botId, turnId],
  );

  await query(
    `INSERT INTO bot_tool_calls (id, turn_id, call_key, tool, arguments)
      VALUES ($1::uuid, $2::uuid, 'push-question', '{}', '{}')`,
    [approvalId, turnId],
  );
  await query(
    `INSERT INTO bot_approvals (id, bot_id, turn_id, kind, prompt, expires_at)
      VALUES ($1::uuid, $2::uuid, $3::uuid, 'question', 'Private question', now() + interval '1 day')`,
    [approvalId, botId, turnId],
  );

  return { botId, approvalId, seq: BigInt(message!.seq) };
}
