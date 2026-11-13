import { citationLabel } from "./inline.ts";
import { citationPlainText } from "./label.ts";
import type { NotedQuote } from "./quotes.ts";

/** Existing agent_message/reasoning quotes contain rendered text. Only explicit source markdown is rich. */
export function citationHasMarkdown(quote: NotedQuote): boolean {
  return (
    quote.sourceKind === "agent_message_markdown" ||
    (quote.sourceKind === "pull_request" &&
      ["comment", "review", "review_comment"].includes(quote.pullRequest?.kind ?? ""))
  );
}

export function citationTokenLabel(quote: NotedQuote): string {
  const label = citationLabel(quote.text, 32, citationHasMarkdown(quote));

  return quote.pullRequest ? `@${quote.sourceAuthor || "GitHub"} · ${label}` : label;
}

/** Body, provenance, external destination and the user's literal note stay separate. */
export function citationPreview(quote: NotedQuote) {
  const pr = quote.pullRequest;
  const location = pr?.path ? `${pr.path}${pr.line ? `:${pr.line}` : ""}` : pr?.firstLine ? `Line ${pr.firstLine}` : "";

  return {
    text: quote.text,
    markdown: citationHasMarkdown(quote),
    caption: [quote.sourceAuthor || "Agent", pr && `${pr.repository}#${pr.number}`, location, quote.sourceTime]
      .filter(Boolean)
      .join(" · "),
    url: pr?.url ?? "",
    comment: quote.comment ?? "",
  };
}

/** Native title fallback uses the same plain form as chips, without truncating the passage. */
export function citationTitle(quote: NotedQuote): string {
  const preview = citationPreview(quote);

  return [preview.markdown ? citationPlainText(preview.text) : preview.text, preview.caption, preview.comment]
    .filter(Boolean)
    .join("\n\n");
}
