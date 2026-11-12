import { citationLabel, citationPlaceholder, isQuoteSourceKind } from "@canopy/domain";
import { ui } from "@canopy/contracts";
import { create, toJson } from "@bufbuild/protobuf";
import { CHIP_CLASS, escape, iconSvg } from "#lib/features/mentions/kinds.ts";
import type { QuoteDraft } from "./quote.ts";
import { parseJson, isJsonObject, isString } from "#lib/shared/json.ts";
import { decode } from "#lib/shared/wire.ts";

export function turnQuoteTime(turn: ui.Turn | undefined): string | undefined {
  const at = turn?.completedAt ?? turn?.startedAt;

  return at ? new Date(Number(at.seconds) * 1000).toLocaleString() : undefined;
}

export function citationTitle(quote: {
  text: string;
  sourceAuthor?: string;
  sourceTime?: string;
  sourceKind?: string;
}): string {
  return [
    quote.text,
    [quote.sourceAuthor || "Agent", quote.sourceKind?.replaceAll("_", " "), quote.sourceTime]
      .filter(Boolean)
      .join(" · "),
  ].join("\n\n");
}

export function quoteJson(quote: QuoteDraft): string {
  return JSON.stringify({ id: quote.id, quote: toJson(ui.QuoteSchema, create(ui.QuoteSchema, quote)) });
}

export function quoteFromJson(data: string): QuoteDraft | undefined {
  try {
    const value = parseJson(data);

    if (!isJsonObject(value) || !isString(value["id"]) || !isJsonObject(value["quote"])) return undefined;
    const quote = decode(ui.QuoteSchema, value["quote"]);

    if (!quote.text.trim() || !isQuoteSourceKind(quote.sourceKind)) return undefined;

    return { ...quote, id: value["id"], sourceKind: quote.sourceKind };
  } catch {
    return undefined;
  }
}

export function citationHtml(quote: QuoteDraft): string {
  return `<span contenteditable="false" data-element="citation" data-quote="${escape(quoteJson(quote))}" role="button" tabindex="0" aria-label="Citation: ${escape(citationLabel(quote.text))}" class="${CHIP_CLASS} max-w-64 cursor-pointer focus-ring" title="${escape(citationTitle(quote))}">${iconSvg("chat-bubble-bottom-center-text")}<span class="truncate">${escape(citationLabel(quote.text))}</span></span>`;
}

export function placedQuote(quote: QuoteDraft, start: number): QuoteDraft {
  return { ...quote, start, end: start + citationPlaceholder(quote.text).length };
}
