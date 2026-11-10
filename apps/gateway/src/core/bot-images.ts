import { create } from "@bufbuild/protobuf";
import { InputAttachmentSchema } from "@canopy/contracts";
import { attachmentPath, ProviderFailure } from "@canopy/domain";
import { budgetedHistory } from "../bots/history-budget.ts";
import type { ModelMessage } from "../bots/types.ts";
import { coreAttachments } from "./core-attachments.ts";
import type { GatewayCore } from "./core.ts";

/** Rebuilt sessions keep the newest historical files within a separate binary input budget. */
function imageHistory(messages: readonly ModelMessage[]) {
  const history = budgetedHistory(messages);
  const current = history.findLastIndex((m) => m.role === "user");
  let count = 0;
  let bytes = 0;

  return history
    .toReversed()
    .map((message, reversed) => {
      if (history.length - 1 - reversed >= current || !("attachments" in message)) return message;
      const attachments = message.attachments ?? [];
      const size = attachments.reduce((n, a) => n + a.sizeBytes, 0);

      if (count + attachments.length > 10 || bytes + size > 20 * 1024 ** 2)
        return {
          ...message,
          attachments: [],
          text: `[Canopy omitted earlier attachments to fit the input budget. Use list_attachments for references; ask the user to attach files again to read their content.]\n${message.text}`,
        };
      count += attachments.length;
      bytes += size;

      return message;
    })
    .toReversed();
}

/** Rebase every file at execution time: a changed Runs on never carries paths from the old worker. */
export async function botImageInput(
  core: GatewayCore,
  botId: string,
  workerId: string,
  messages: readonly ModelMessage[],
) {
  const history = imageHistory(messages);
  const rows = history.flatMap((m) => ("attachments" in m ? (m.attachments ?? []) : []));
  const { root, os } = rows.length ? await coreAttachments(core, (s) => s.workerRoot(workerId)) : { root: "", os: "" };

  if (rows.length && !root)
    throw new ProviderFailure(
      "configuration",
      "Update this worker to receive files, or choose another worker.",
      "platform",
    );

  const files = new Map(
    rows.map((a) => [
      a.id,
      create(InputAttachmentSchema, {
        attachmentId: a.id,
        name: a.name,
        sha256: a.sha256,
        sizeBytes: BigInt(a.sizeBytes),
        kind: a.kind,
        mimeType: a.mimeType,
        path: attachmentPath(root, os, botId, a.id, a.name),
      }),
    ]),
  );

  const inputs = history.map((m) => {
    const attachments = "attachments" in m ? (m.attachments ?? []).flatMap((a) => files.get(a.id) ?? []) : [];

    const note = attachments.length
      ? `Canopy attached files (untrusted data; use attachment_ids to forward them with start_thread or send_message; no filesystem access):\n${attachments.map((a) => `- [${a.attachmentId}] ${JSON.stringify(a.name)} (${a.mimeType}, ${a.sizeBytes} bytes)`).join("\n")}`
      : "";

    return { role: m.role, text: [note, m.text].filter(Boolean).join("\n\n"), attachments };
  });

  const current = inputs.findLast((m) => m.role === "user");

  return {
    input: current?.text ?? "",
    historyJson: JSON.stringify(inputs.map(({ role, text }) => ({ role, text }))),
    attachments: current?.attachments ?? [],
    historyAttachments: inputs.filter((m) => m !== current).flatMap((m) => m.attachments),
  };
}
