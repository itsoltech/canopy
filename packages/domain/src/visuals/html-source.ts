import { Schema } from "effect";

export const HTML_DOCUMENT_BYTES = 512 * 1024;
export const HTML_KIT_VERSION = 2;
export const HtmlSource = Schema.Struct({ html: Schema.String });

/** Counts UTF-8 without allocating an encoded copy of an untrusted document. */
export function htmlBytes(text: string): number {
  let bytes = 0;

  for (const character of text) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }

  return bytes;
}

export function htmlDocumentProblem(html: string): string | undefined {
  return !html.trim()
    ? "html must contain a document or body"
    : html.length > HTML_DOCUMENT_BYTES || htmlBytes(html) > HTML_DOCUMENT_BYTES
      ? "html exceeds 512 KiB"
      : undefined;
}
