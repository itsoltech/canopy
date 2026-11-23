import { ISSUE_MENTION_LIMITS, parseIssueUrl } from "./issues.ts";

export type ComposerTriggerChar = "/" | "$" | "@" | "#";

export interface ComposerMentionTrigger {
  readonly char: ComposerTriggerChar;
  readonly query: string;
  /** UTF-16 units replaced when an option is picked. */
  readonly length: number;
}

/** Text immediately before the caret. Only # searches accept multiword titles or full tracker URLs. */
export function composerMentionTrigger(
  before: string,
  enabled?: ReadonlySet<ComposerTriggerChar>,
): ComposerMentionTrigger | undefined {
  const text = before.replaceAll("\u00a0", " ");
  const match = /(?:^|\s)([/$@#])(\S*)$/.exec(text) ?? /(?:^|\s)(#)(\S+(?: (?![/$@#])\S+)* ?)$/.exec(text);
  const char = match?.[1];

  if (char !== "/" && char !== "$" && char !== "@" && char !== "#") return undefined;

  if (enabled && !enabled.has(char)) return undefined;
  const query = match?.[2] ?? "";

  if (char === "#") {
    if (query.length > ISSUE_MENTION_LIMITS.key && !parseIssueUrl(query)) return undefined;
  } else if (query.length > 120) return undefined;

  return { char, query, length: query.length + 1 };
}
