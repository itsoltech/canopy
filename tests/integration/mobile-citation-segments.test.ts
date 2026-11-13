import { describe, expect, test } from "bun:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, ui } from "@canopy/contracts";
import { citationPlaceholder, citationPreview, citationTokenLabel, inlineLegacyQuotes } from "@canopy/domain";
import { splitSentinels, withSentinels } from "@canopy/domain/markdown";
import {
  insertCitation,
  rangesOf,
  segmentsOf,
  trimValue,
  type MessageValue,
} from "../../apps/mobile/src/features/composer/message-value";

describe("mobile inline citation message model", () => {
  test("two sent citations retain ranges and separate notes after protobuf decoding", () => {
    const first = { text: "sprawdzenie zgłoszenia, że w mailu nie ma odpowiedzi", comment: "to chyba coś starego" };
    const second = { text: 'napis „Keeps your streak." na karcie', comment: "a co z nim?" };
    const passages = [first, second];

    const firstMarker = citationPlaceholder(first.text);
    const text = [firstMarker, citationPlaceholder(second.text)].join(" ");

    const turn = fromBinary(
      ui.TurnSchema,
      toBinary(
        ui.TurnSchema,
        create(ui.TurnSchema, {
          messageText: text,
          quotes: passages.map((quote, index) => ({
            ...quote,
            start: index === 0 ? 0 : firstMarker.length + 1,
            end: index === 0 ? firstMarker.length : text.length,
          })),
        }),
      ),
    );

    const value = { text: turn.messageText, mentions: [], quotes: turn.quotes };
    const segments = segmentsOf(value);

    expect(segments.map((segment) => segment.quote?.text ?? segment.text)).toEqual([first.text, " ", second.text]);
    expect(turn.quotes.filter((quote) => quote.start === undefined)).toEqual([]);
    expect(segments.flatMap((segment) => (segment.quote ? [citationPreview(segment.quote).comment] : []))).toEqual(
      passages.map((quote) => quote.comment),
    );
    const marked = withSentinels(text, rangesOf(value));
    expect(splitSentinels(marked.text)).toEqual([0, " ", 1]);
    expect(marked.text).not.toContain("[“");
  });

  test("adjacent citations need no surrounding text or separators", () => {
    const quotes = [
      create(ui.QuoteSchema, { text: "A", start: 0, end: 1 }),
      create(ui.QuoteSchema, { text: "B", start: 1, end: 2 }),
    ];

    const value = { text: "ab", mentions: [], quotes: quotes.toReversed() };

    expect(segmentsOf(value).map((segment) => segment.quote?.text)).toEqual(["A", "B"]);
    expect(splitSentinels(withSentinels(value.text, rangesOf(value)).text)).toEqual([0, 1]);
  });

  test("insertion and trimming preserve UTF-16 offsets around emoji and attachment mentions", () => {
    const value: MessageValue = {
      text: "  🪴 [file.txt] end  ",
      mentions: [create(MentionSchema, { kind: MentionKind.ATTACHMENT, name: "file", start: 5, end: 15 })],
    };

    const placed = insertCitation(
      value,
      { start: 5, end: 5 },
      create(ui.QuoteSchema, { text: "First", comment: "Note" }),
    );

    const trimmed = trimValue(placed.value);
    const segments = segmentsOf(trimmed);

    expect(segments.map((segment) => segment.quote?.text ?? segment.text)).toEqual([
      "🪴 ",
      "First",
      " ",
      "[file.txt]",
      " end",
    ]);
    expect(segments.find((segment) => segment.mention)?.mention?.name).toBe("file");
    expect(rangesOf(trimmed).map((range) => trimmed.text.slice(range.start, range.end))).toEqual([
      citationPlaceholder("First"),
      "[file.txt]",
    ]);
  });

  test("legacy blocks stay outside inline ranges until the queue editor normalizes them", () => {
    const inline = create(ui.QuoteSchema, { text: "Inline", start: 0, end: 1, comment: "Inline note" });
    const legacy = create(ui.QuoteSchema, { text: "Legacy", comment: "Legacy note" });
    const value = { text: "x", mentions: [], quotes: [legacy, inline] };

    expect(segmentsOf(value)).toEqual([{ text: "x", quote: inline, mention: undefined }]);
    expect(rangesOf(value).map((range) => range.quote?.text)).toEqual(["Inline"]);
    const edited = { ...inlineLegacyQuotes(value), mentions: [] };
    expect(segmentsOf(edited).flatMap((segment) => (segment.quote ? [segment.quote.comment] : []))).toEqual([
      "Inline note",
      "Legacy note",
    ]);
  });

  test("long labels are bounded while the viewer keeps the entire passage and multiline note", () => {
    const quote = create(ui.QuoteSchema, {
      text: "Long passage ".repeat(1000),
      comment: "A **literal** note.\n".repeat(200),
    });

    const placed = insertCitation({ text: "", mentions: [] }, { start: 0, end: 0 }, quote);
    const segment = segmentsOf(placed.value)[0];

    if (!segment?.quote) throw new Error("Expected the inserted citation segment");

    expect(citationTokenLabel(segment.quote)).toHaveLength(33);
    expect(citationTokenLabel(segment.quote)).toEndWith("…");
    expect(citationPreview(segment.quote).text).toBe(quote.text.trim());
    expect(citationPreview(segment.quote).comment).toBe(quote.comment.trim());
    expect(segment.text).toBe(citationPlaceholder(quote.text));
  });
});
