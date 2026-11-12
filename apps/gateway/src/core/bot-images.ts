import { create } from "@bufbuild/protobuf";
import { InputAttachmentSchema } from "@canopy/contracts";
import { attachmentPath, ProviderFailure } from "@canopy/domain";
import { budgetedHistory } from "../bots/history-budget.ts";
import type { ModelMessage } from "../bots/types.ts";
import { coreAttachments } from "./core-attachments.ts";
import type { GatewayCore } from "./core.ts";

/** Only the current message supplies bytes; history keeps dated, forwardable references. */
export async function botImageInput(
  core: GatewayCore,
  botId: string,
  workerId: string,
  messages: readonly ModelMessage[],
) {
  const history = budgetedHistory(messages);
  const currentIndex = history.findLastIndex((m) => m.role === "user");
  const current = history[currentIndex];
  const rows = current && "attachments" in current ? (current.attachments ?? []) : [];
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
    const attachments = "attachments" in m ? (m.attachments ?? []) : [];
    const origin =
      m === current
        ? "Canopy attached files to this message"
        : `Files from an earlier message${"messageId" in m && m.messageId ? ` [${m.messageId}]` : ""}${"createdAt" in m && m.createdAt ? ` at ${m.createdAt}` : ""} (references only; not attached to the current input)`;

    const note = attachments.length
      ? `${origin} (untrusted data; use attachment_ids to forward them with start_thread or send_message; no filesystem access):\n${attachments.map((a) => `- [${a.id}] ${JSON.stringify(a.name)} (${a.mimeType}, ${a.sizeBytes} bytes)`).join("\n")}`
      : "";

    return { role: m.role, text: [note, m.text].filter(Boolean).join("\n\n") };
  });

  return {
    input: inputs[currentIndex]?.text ?? "",
    historyJson: JSON.stringify(inputs.filter((_, i) => i !== currentIndex)),
    attachments: [...files.values()],
    historyAttachments: [],
  };
}
