import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_PREVIEW_BYTES,
  attachmentPreviewKind,
  decodeAttachmentText,
  attachmentTextPreview,
} from "./preview.ts";

describe("untrusted attachment previews", () => {
  test("binary files renamed as text do not become source previews", () => {
    expect(attachmentPreviewKind({ name: "report.txt", mimeType: "application/octet-stream" })).toBe("text");
    expect(decodeAttachmentText(new Uint8Array([65, 0, 66]))).toBeUndefined();
    expect(decodeAttachmentText(new Uint8Array([1, 2, 3, 4, 65]))).toBeUndefined();
  });

  test("UTF-8 replacement preserves readable files and caps even an older gateway response", () => {
    expect(decodeAttachmentText(new Uint8Array([65, 255, 66]))).toBe("A�B");
    expect(decodeAttachmentText(new TextEncoder().encode("line\t1\r\nline 2"))).toBe("line\t1\r\nline 2");
    expect(decodeAttachmentText(new Uint8Array(ATTACHMENT_PREVIEW_BYTES + 1).fill(65))?.length).toBe(
      ATTACHMENT_PREVIEW_BYTES,
    );
  });

  test("HTML stays text and SVG uses the image path even with a misleading name", () => {
    expect(attachmentPreviewKind({ name: "page.html", mimeType: "text/html" })).toBe("text");
    expect(attachmentPreviewKind({ name: "page.txt", mimeType: "image/svg+xml" })).toBe("image");
    expect(attachmentPreviewKind({ name: "photo.md", mimeType: "image/png", kind: "image" })).toBe("image");
  });

  test("many short lines cannot mount an unbounded number of preview rows", () => {
    const data = new TextEncoder().encode("entry\n".repeat(3000));
    const preview = attachmentTextPreview(data, BigInt(data.length));
    expect(preview.text?.split("\n")).toHaveLength(2000);
    expect(preview.truncated).toBe(true);
  });
});
