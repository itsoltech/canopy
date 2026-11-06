import { redactCredentials } from "./failures.ts";

/** Characters of a notification preview (docs/notifications.md). */
export const NOTICE_PREVIEW_LENGTH = 140;

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/**
 * One short plain-text line of a message for a system notification: no markdown, code blocks or full URLs
 * (a link keeps its text, a bare URL only its host), credentials redacted, cut at a word.
 */
export function noticePreview(text: string, length = NOTICE_PREVIEW_LENGTH): string {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<?(https?:\/\/[^\s<>)]+)>?/gi, (_, url: string) => host(url))
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|\|)/gm, "")
    .replace(/(\*\*|__|~~|\*|`)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\s*\|\s*/g, " ")
    .replace(/^[-=*_]{3,}$/gm, " ");

  // Lines become sentences: a heading or list item without its own punctuation gets a period.
  const line = redactCredentials(plain)
    .split("\n")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .reduce((joined, part) => (!joined ? part : `${joined}${/[.!?:;…,]$/.test(joined) ? "" : "."} ${part}`), "");

  if (line.length <= length) return line;
  const cut = line.slice(0, length - 1);
  const word = cut.lastIndexOf(" ");

  return `${(word > length / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}
