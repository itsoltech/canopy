import { MentionKind, type Mention } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";

export interface ComposerPendingItem {
  readonly key: string;
  readonly icon: IconName;
  readonly count: number;
  readonly label: string;
}

const mentionGroups: readonly { kind: MentionKind; icon: IconName; noun: string }[] = [
  { kind: MentionKind.FILE, icon: "document-text", noun: "file" },
  { kind: MentionKind.THREAD, icon: "chat-bubble-left", noun: "thread" },
  { kind: MentionKind.COMMAND, icon: "command-line", noun: "command" },
  { kind: MentionKind.SKILL, icon: "sparkles", noun: "skill" },
  { kind: MentionKind.PLUGIN, icon: "square-2-stack", noun: "plugin" },
  { kind: MentionKind.CONNECTOR, icon: "link", noun: "connector" },
  { kind: MentionKind.BOT, icon: "chat-bubble-left-right", noun: "bot" },
];

/** Count only attached files, independently of their inline badges, so each file appears once. */
export function composerPending(
  citations: number,
  attachments: number,
  mentions: readonly Mention[],
): ComposerPendingItem[] {
  const groups = [
    { key: "citations", icon: "chat-bubble-bottom-center-text" as const, noun: "citation", count: citations },
    { key: "attachments", icon: "paper-clip" as const, noun: "attachment", count: attachments },
    ...mentionGroups.map(({ kind, icon, noun }) => ({
      key: noun,
      icon,
      noun,
      count: mentions.filter((mention) => mention.kind === kind).length,
    })),
  ];

  return groups.flatMap(({ key, icon, noun, count }) =>
    count > 0
      ? [
          {
            key,
            icon,
            count,
            label: `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`,
          },
        ]
      : [],
  );
}
