import { MentionKind, type UserInput } from "@canopy/contracts";
import type { v2 } from "@canopy/codex-protocol";

/** Image files a model can look at when mentioned (Codex localImage). */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Codex turn input from the platform's (docs/codex-adapter.md, "Wzmianki"): the text with a text_element per mention
 * (UTF-8 byte range and its placeholder, as the Codex composer records them), then native items:
 * - skill -> { type: "skill", name, path } (Codex injects the SKILL.md),
 * - plugin or app -> { type: "mention", name, path } (path plugin://… or app://…),
 * - an image file -> { type: "localImage", path } (the model sees it); other files stay "@path" in the text,
 *   relative to the thread's folder, like the Codex composer inserts them.
 * Commands and threads have no Codex item (the gateway already added the thread note to the text).
 */
export function codexUserInput(input: Pick<UserInput, "text" | "mentions">): v2.UserInput[] {
  const { text, mentions } = input;
  const encoder = new TextEncoder();
  const bytes = (end: number) => encoder.encode(text.slice(0, end)).length;

  const items: v2.UserInput[] = [
    {
      type: "text",
      text,
      text_elements: mentions
        .filter((m) => m.end > m.start && m.end <= text.length)
        .map((m) => ({
          byteRange: { start: bytes(m.start), end: bytes(m.end) },
          placeholder: text.slice(m.start, m.end),
        })),
    },
  ];

  const seen = new Set<string>();

  for (const m of mentions) {
    const key = `${m.kind}:${m.path || m.name}`;

    if (seen.has(key)) continue;
    seen.add(key);

    if (m.kind === MentionKind.SKILL && m.path) items.push({ type: "skill", name: m.name, path: m.path });
    else if (m.kind === MentionKind.PLUGIN && m.path) items.push({ type: "mention", name: m.name, path: m.path });
    else if (m.kind === MentionKind.FILE && !m.isDir && m.path && IMAGE_FILE.test(m.path))
      items.push({ type: "localImage", path: m.path });
  }

  return items;
}
