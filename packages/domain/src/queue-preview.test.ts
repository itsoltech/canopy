import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, ui } from "@canopy/contracts";
import { queuePreview } from "./queue-preview.ts";

describe("queued message previews", () => {
  test("removes only attachment tokens, preserving typed filenames, mention labels and citation labels", () => {
    const messageText = "Compare [scan.png] with scan.png and [quote] in @file";
    const quote = { text: "**Review** the `diff`", sourceKind: "agent_message_markdown", start: 37, end: 44 };

    const turn = create(ui.TurnSchema, {
      messageText,
      inputText: "[canopy] Expanded file paths and quoted bodies must not be displayed",
      attachments: [{ id: "scan", name: "scan.png", kind: "image" }],
      // Unsorted ranges exercise the merge of file/mention and citation tokens.
      mentions: [
        create(MentionSchema, { kind: MentionKind.FILE, name: "src/main.ts", start: 48, end: 53 }),
        create(MentionSchema, { kind: MentionKind.ATTACHMENT, name: "scan", label: "scan.png", start: 8, end: 18 }),
      ],
      quotes: [quote],
    });

    const before = structuredClone(turn);
    const preview = queuePreview(turn);
    expect(preview.text).toBe("Compare with scan.png and Review the diff in main.ts");
    expect(preview.summary).toBe("1 image · 1 citation");
    expect(preview.items.map((item) => item.label)).toEqual(["scan.png", "Review the diff"]);
    expect(turn).toEqual(before);
  });

  test("content-only messages use pluralised counts without leaking the expanded input", () => {
    const turn = create(ui.TurnSchema, {
      inputText: "[canopy] /private/files/scan.png /private/files/notes.txt",
      attachments: [
        { name: "scan.png", kind: "image" },
        { name: "diagram.svg", mimeType: "image/svg+xml" },
        { name: "notes.txt", kind: "file" },
      ],
      quotes: [{ text: "First legacy quote" }, { text: "Second legacy quote" }],
    });

    expect(queuePreview(turn)).toEqual({
      text: "",
      summary: "2 images · 1 file · 2 citations",
      items: [
        { kind: "image", label: "scan.png" },
        { kind: "image", label: "diagram.svg" },
        { kind: "file", label: "notes.txt" },
        { kind: "citation", label: "First legacy quote" },
        { kind: "citation", label: "Second legacy quote" },
      ],
    });
  });

  test("handles adjacent attachment markers and ignores invalid or overlapping ranges", () => {
    const turn = create(ui.TurnSchema, {
      messageText: "A[x][y]B\n  next",
      mentions: [
        { kind: MentionKind.ATTACHMENT, start: 1, end: 4 },
        { kind: MentionKind.ATTACHMENT, start: 4, end: 7 },
        { kind: MentionKind.FILE, name: "overlap", start: 2, end: 5 },
        { kind: MentionKind.FILE, name: "outside", start: 8, end: 99 },
      ],
      quotes: [
        { text: "invalid", start: -1, end: 1 },
        { text: "empty", start: 8, end: 8 },
      ],
    });

    expect(queuePreview(turn).text).toBe("A B next");
    expect(queuePreview(create(ui.TurnSchema, { inputText: "Legacy\n  text" })).text).toBe("Legacy text");
  });
});
