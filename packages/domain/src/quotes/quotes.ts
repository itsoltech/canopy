import { Match } from "effect";

/**
 * Quotes (docs/ui-api.md, "Cytaty"): passages of what an agent produced in a thread — its answer, reasoning,
 * command output, a tool call, a code block, a diff — that the user selected and sends back with a message,
 * each with an optional comment. Inline ranges expand where the user placed them (`composeQuotes`);
 * older clients keep the platform note before the user's text, in the stable format of `quotesNote`.
 */

export const QUOTE_SOURCE_KINDS = [
  "agent_message",
  "agent_message_markdown",
  "text_selection",
  "reasoning",
  "command_output",
  "tool_call",
  "code",
  "diff",
  "pull_request",
] as const;

export type QuoteSourceKind = (typeof QUOTE_SOURCE_KINDS)[number];

/** Limits per message: the gateway refuses more (the UI keeps a draft within them). */
export const QUOTE_LIMITS = { maxQuotes: 20, maxTextChars: 20_000, maxCommentChars: 4_000 } as const;

export interface NotedQuote {
  readonly text: string;
  readonly comment?: string | undefined;
  /** "" or unknown = plain text. */
  readonly sourceKind?: string | undefined;
  /** Language of a code block (code, diff). */
  readonly language?: string | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly pullRequest?: PullRequestCitation | undefined;
  readonly sourceAuthor?: string | undefined;
  readonly sourceTime?: string | undefined;
}

/** A closed JSON value shared by stored quotes and the web request body. */
export type PullRequestCitation = {
  readonly pullRequestId: string;
  readonly kind: string;
  readonly resourceId: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly path: string;
  readonly line: number;
  readonly diffHunk: string;
  readonly firstLine: number;
};

export function isQuoteSourceKind(kind: string): kind is QuoteSourceKind {
  return QUOTE_SOURCE_KINDS.some((known) => known === kind);
}

/** Output, calls, code and diffs reach the agent as a fenced block, so their whitespace stays exact. */
export function isCodeQuote(kind: string | undefined): boolean {
  return kind === "command_output" || kind === "tool_call" || kind === "code" || kind === "diff";
}

const origins: Record<QuoteSourceKind, string> = {
  agent_message: "your message",
  agent_message_markdown: "your message",
  text_selection: "this conversation",
  reasoning: "your reasoning",
  command_output: "command output",
  tool_call: "a tool call",
  code: "a code block",
  diff: "a diff",
  pull_request: "a pull request",
};

/** A fence longer than any run of backticks in the text (CommonMark), at least three. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));

  return "`".repeat(Math.max(3, longest + 1));
}

/** The quoted text as markdown: a fenced block for code-like sources, else a blockquote (every line marked). */
export function quoteBlock(quote: NotedQuote): string {
  const text = quote.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");

  if (isCodeQuote(quote.sourceKind)) {
    const fence = fenceFor(text);
    const language = (quote.language || (quote.sourceKind === "diff" ? "diff" : "text")).replace(/[^\w+#.-]/g, "");

    return `${fence}${language}\n${text}\n${fence}`;
  }

  const block = text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

  if (!quote.pullRequest) return block;
  const pr = quote.pullRequest;

  const kind = Match.value(pr.kind).pipe(
    Match.when("review_comment", () => "review comment"),
    Match.when("log", () => "log excerpt"),
    Match.orElse((value) => value),
  );

  const location = pr.path ? ` (${pr.path}${pr.line ? `:${pr.line}` : ""})` : "";

  const context = pr.diffHunk
    ? `\n\nDiff context:\n${fenceFor(pr.diffHunk)}diff\n${pr.diffHunk}\n${fenceFor(pr.diffHunk)}`
    : "";

  return `Pull request ${kind} by @${quote.sourceAuthor || "GitHub"} on ${pr.repository}#${pr.number}${location}:\n${pr.url}${quote.sourceTime ? ` · ${quote.sourceTime}` : ""}\n${block}${context}`;
}

/**
 * The platform note for a message's quotes, before the user's text:
 *
 *   [canopy] The user quoted 2 passages of this conversation. Each quote is the exact text they
 *   selected, followed by their comment on it when they wrote one; their message comes after the quotes.
 *
 *   Quote 1, from your message:
 *   > the selected text
 *
 *   Comment: the user's comment
 *
 *   Quote 2, from command output:
 *   ```text
 *   the selected lines
 *   ```
 *
 * Empty for no quotes.
 */
export function quotesNote(quotes: readonly NotedQuote[]): string {
  if (quotes.length === 0) return "";
  const count = quotes.length === 1 ? "a passage" : `${quotes.length} passages`;

  const parts = [
    `[canopy] The user quoted ${count} of this conversation. Each quote is the exact text they selected, followed by their comment on it when they wrote one; their message comes after the quotes.`,
  ];

  quotes.forEach((quote, index) => {
    const kind = quote.sourceKind ?? "";
    const origin = isQuoteSourceKind(kind) ? origins[kind] : "this conversation";
    const comment = quote.comment?.trim();
    parts.push(`Quote ${index + 1}, from ${origin}:\n${quoteBlock(quote)}${comment ? `\n\nComment: ${comment}` : ""}`);
  });

  return parts.join("\n\n");
}

/** Platform notes of one message (attachments, quotes) as one note: blocks apart by an empty line. */
export function joinNotes(...notes: readonly string[]): string {
  return notes.filter((note) => note.trim()).join("\n\n");
}
