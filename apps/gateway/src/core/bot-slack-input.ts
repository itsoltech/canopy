import { setTimeout as delay } from "node:timers/promises";
import type { AttachmentKind, AttachmentLimits } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { prepareAttachment, type PreparedAttachment } from "../attachments/prepare.ts";
import { storedBotImage } from "../bots/attachments.ts";
import type { BotTurn, ModelInput } from "../bots/types.ts";
import { messengerAdapter } from "../messengers/adapters.ts";
import { messengerLabel } from "../messengers/provider.ts";
import { MAX_SLACK_MESSAGE_FILES } from "../messengers/slack-events.ts";
import { MessengerStore } from "../messengers/store.ts";
import { inboundSlackTurnFiles, type InboundSlackFile } from "../messengers/store-inbound-files.ts";
import type { AttachmentRow, StoredAttachment } from "../store/attachments.ts";
import { coreAttachments } from "./core-attachments.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { bindBotSlackAttachment } from "./slack-attachment-store.ts";

/** Names the provider when the turn's files say which one it is. */
const fileUnavailable = (files: readonly InboundSlackFile[]) =>
  `[Canopy] Some ${files[0] ? `${messengerLabel(files[0].provider)} ` : ""}attachments were unavailable.`;

function workerSupports(kind: AttachmentKind, capabilities: readonly string[]) {
  return capabilities.includes(kind === "image" ? "bot_images_v1" : "bot_files_v1");
}

async function slackInputCapabilities(core: GatewayCore, workerId: string, turn: BotTurn, signal: AbortSignal) {
  try {
    for (;;) {
      signal.throwIfAborted();
      const connection = core.link.connections.get(workerId);

      if (connection?.isOpen) return connection.hello.capabilities;
      core.bots.waiting(turn.id, true);
      await delay(500, undefined, { signal });
    }
  } finally {
    core.bots.waiting(turn.id, false);
  }
}

function slackTurnSource(core: GatewayCore, turn: BotTurn) {
  const { runtime, userId, messengerTransport } = core[coreState].options;

  return {
    files: (id?: string) =>
      runtime.runPromise(SqlClient.SqlClient.use((sql) => inboundSlackTurnFiles(sql, userId, turn, id))),
    credentials: (accountId: string) =>
      runtime.runPromise(MessengerStore.use((s) => s.credentials(userId, accountId, messengerTransport))),
    cached: () =>
      runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql<AttachmentRow & { slack_file_id: string }>`SELECT * FROM attachments
            WHERE bot_turn_id=${turn.id}::uuid AND bot_id=${turn.bot_id}::uuid
              AND owner_user_id=${userId}::uuid AND slack_file_id IS NOT NULL`.pipe(
            Effect.map((rows) => new Map<string, AttachmentRow>(rows.map((row) => [row.slack_file_id, row]))),
          ),
        ),
      ),
    bind: (id: string, prepared: PreparedAttachment) => bindBotSlackAttachment(runtime, userId, turn, id, prepared),
    transport: messengerTransport,
  };
}

async function loadSlackInput(
  source: ReturnType<typeof slackTurnSource>,
  files: readonly InboundSlackFile[],
  options: {
    cached: ReadonlyMap<string, AttachmentRow>;
    retained: readonly StoredAttachment[];
    capabilities: readonly string[];
    limits: AttachmentLimits;
    signal: AbortSignal;
  },
) {
  const { cached, retained, capabilities, limits, signal } = options;
  const attached = new Map<string, AttachmentRow>();
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let remaining = limits.maxMessageBytes - retained.reduce((bytes, entry) => bytes + entry.sizeBytes, 0);
  let credentials: ReturnType<typeof source.credentials> | undefined;

  for (const entry of files.slice(0, MAX_SLACK_MESSAGE_FILES)) {
    signal.throwIfAborted();
    const maxBytes = Math.min(limits.maxFileBytes, remaining);

    if (retained.length + attached.size >= limits.maxFiles || maxBytes <= 0) break;

    try {
      let row = cached.get(entry.file_id);

      if (!row) {
        if (downloadSignal.aborted) continue;

        if (!credentials) {
          if (!(await source.files(entry.file_id)).length) continue;
          credentials = source.credentials(entry.account_id);
        }

        const accountCredentials = await credentials;
        const adapter = messengerAdapter(entry.provider);

        if (
          downloadSignal.aborted ||
          !adapter.fileReference.test(entry.file_id) ||
          !(await source.files(entry.file_id)).length
        )
          continue;

        const file = await adapter.download(
          accountCredentials,
          entry.file_id,
          maxBytes,
          downloadSignal,
          source.transport,
        );

        const prepared = await prepareAttachment(file.name, file.data, limits);
        signal.throwIfAborted();

        if (prepared.data.length > maxBytes || !workerSupports(prepared.kind, capabilities)) continue;
        row = await source.bind(entry.file_id, prepared);
      }

      const size = Number(row.size_bytes);

      if (size > maxBytes || !workerSupports(row.kind, capabilities)) continue;
      attached.set(entry.file_id, row);
      remaining -= size;
    } catch {
      signal.throwIfAborted();
    }
  }

  const current = await source.files();

  return current.flatMap((entry) => {
    const row = entry.files_enabled && attached.get(entry.file_id);

    return row ? [storedBotImage(row)] : [];
  });
}

/** Import only the files attached to this turn's messenger input, before the durable command is created. */
export async function withSlackBotInput(core: GatewayCore, input: ModelInput, workerId: string, turn: BotTurn) {
  if (!turn.conversation_id) return input.messages;
  const index = input.messages.findLastIndex((message) => message.role === "user");
  const message = input.messages[index];

  if (!message) return input.messages;
  const source = slackTurnSource(core, turn);
  const files = await source.files();

  if (!files.length && !message.attachments?.length) return input.messages;

  const cached = await source.cached();
  const importedIds = new Set([...cached.values()].map((row) => row.id));
  const retained = (message.attachments ?? []).filter((row) => !importedIds.has(row.id));

  const capabilities =
    files[0]?.files_enabled && input.configuration.files !== false
      ? await slackInputCapabilities(core, workerId, turn, input.signal)
      : [];

  const supported =
    capabilities.includes("bot_workspace_v1") &&
    (capabilities.includes("bot_files_v1") || capabilities.includes("bot_images_v1"));

  const { root } = supported ? await coreAttachments(core, (s) => s.workerRoot(workerId)) : { root: "" };

  // A callback can already carry attachments. Only recheck provider imports against the source message.
  const imported = root
    ? await loadSlackInput(source, files, {
        cached,
        retained,
        capabilities,
        limits: await core.attachmentLimits,
        signal: input.signal,
      })
    : [];

  const attachments = [...retained, ...imported];
  const missing = imported.length < Math.max(files.length, (message.attachments?.length ?? 0) - retained.length);
  const text = missing ? [fileUnavailable(files), message.text].filter(Boolean).join("\n\n") : message.text;

  return input.messages.map((entry, i) => (i === index ? { ...message, text, attachments } : entry));
}
