import { describe, expect, test } from "bun:test";
import { Result } from "effect";
import { attachmentPath, attachmentsNote, safeFileName, withAttachmentsNote } from "./files.ts";
import { sniff } from "./sniff.ts";
import { decodeViewImage, viewImageSpec } from "./view-image.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("sniff: the content decides, not the name", () => {
  test("raster images by magic bytes, whatever the extension says", () => {
    expect(sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), "notes.txt")).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(sniff(bytes(0xff, 0xd8, 0xff, 0xe0), "a.png").mimeType).toBe("image/jpeg");
    expect(sniff(text("GIF89a...."), "x").mimeType).toBe("image/gif");
    expect(sniff(text("RIFF\0\0\0\0WEBPVP8 "), "x").mimeType).toBe("image/webp");
  });

  test("HEIC, AVIF and TIFF are converted, other ISO media is a file", () => {
    expect(sniff(text("\0\0\0\x18ftypheic\0\0\0\0"), "IMG_1.HEIC")).toMatchObject({ kind: "convertible", mimeType: "image/heic" });
    expect(sniff(text("\0\0\0\x18ftypavif\0\0\0\0")).mimeType).toBe("image/avif");
    expect(sniff(bytes(0x49, 0x49, 0x2a, 0x00)).kind).toBe("convertible");
    expect(sniff(text("\0\0\0\x18ftypisom\0\0\0\0"), "clip.mp4")).toMatchObject({ kind: "file", mimeType: "video/mp4" });
  });

  test("an image name on a text file is a text file; SVG and HTML are files, never inline images", () => {
    expect(sniff(text("hello"), "photo.png")).toMatchObject({ kind: "file", mimeType: "text/plain", text: true });
    expect(sniff(text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.png")).toMatchObject({
      kind: "file",
      mimeType: "image/svg+xml",
    });
    expect(sniff(text("<!DOCTYPE html><html><script></script>"), "page.txt").mimeType).toBe("text/html");
  });

  test("text types by extension, documents and archives by bytes", () => {
    expect(sniff(text("# Title"), "README.md").mimeType).toBe("text/markdown");
    expect(sniff(text("{}"), "a.json").mimeType).toBe("application/json");
    expect(sniff(text("%PDF-1.7\n"), "a.bin").mimeType).toBe("application/pdf");
    expect(sniff(bytes(0x50, 0x4b, 0x03, 0x04), "report.docx").mimeType).toContain("wordprocessingml");
    expect(sniff(bytes(0x50, 0x4b, 0x03, 0x04), "x.zip").mimeType).toBe("application/zip");
    // Bytes that are not UTF-8 are binary even when named .txt.
    expect(sniff(bytes(0xff, 0xfe, 0x00, 0x41), "a.txt")).toMatchObject({ kind: "file", mimeType: "application/octet-stream", text: false });
  });

  test("native programs are executables, scripts are text", () => {
    expect(sniff(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1), "tool").kind).toBe("executable");
    expect(sniff(text("MZ\x90\0"), "setup.pdf").kind).toBe("executable");
    expect(sniff(bytes(0xcf, 0xfa, 0xed, 0xfe), "x").kind).toBe("executable");
    expect(sniff(bytes(0x00, 0x01, 0x02), "evil.dll").kind).toBe("executable");
    expect(sniff(text("#!/bin/sh\necho hi\n"), "run.sh")).toMatchObject({ kind: "file", text: true });
  });
});

describe("file names and paths", () => {
  test("no directories, control characters or reserved names survive", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\me\\..\\shot.png")).toBe("shot.png");
    expect(safeFileName("..")).toBe("attachment");
    expect(safeFileName("  .hidden ")).toBe("hidden");
    expect(safeFileName("a\u0000b\u202e\nc?.txt")).toBe("abc_.txt");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
    expect(safeFileName("")).toBe("attachment");
    const long = safeFileName(`${"x".repeat(300)}.png`);
    expect(long.length).toBe(120);
    expect(long.endsWith(".png")).toBe(true);
  });

  test("the path follows the worker's OS and always ends in the attachment's own directory", () => {
    expect(attachmentPath("/data/attachments/", "linux", "t1", "a1", "../x.png")).toBe("/data/attachments/t1/a1/x.png");
    expect(attachmentPath("C:\\canopy\\attachments", "win32", "t1", "a1", "s.png")).toBe("C:\\canopy\\attachments\\t1\\a1\\s.png");
  });
});

describe("the platform note", () => {
  const note = attachmentsNote([
    { name: "shot.png", path: "/d/t/a/shot.png", mimeType: "image/png", sizeBytes: 250_000, kind: "image", width: 1920, height: 1080 },
    { name: "notes.txt", path: "/d/t/b/notes.txt", mimeType: "text/plain", sizeBytes: 2048, kind: "file" },
  ]);

  test("lists every file with path, type, size and dimensions, without an empty line", () => {
    expect(note.startsWith("[canopy] The user attached 2 files")).toBe(true);
    expect(note).toContain("view_image");
    expect(note).toContain("- /d/t/a/shot.png (image/png, 244.1 KB, 1920×1080 px)");
    expect(note).toContain("- /d/t/b/notes.txt (text/plain, 2.0 KB)");
    expect(note).not.toContain("\n\n");
  });

  test("the message follows after an empty line; without one the note is the whole input", () => {
    expect(withAttachmentsNote(note, "What is this?")).toBe(`${note}\n\nWhat is this?`);
    expect(withAttachmentsNote(note, "  ")).toBe(note);
  });
});

describe("view_image arguments", () => {
  test("a closed object schema with a path", () => {
    const spec = viewImageSpec();
    expect(spec.inputSchema["type"]).toBe("object");
    expect(spec.inputSchema["additionalProperties"]).toBe(false);
    expect(Result.isSuccess(decodeViewImage('{"path":"/a.png"}'))).toBe(true);
    expect(Result.isFailure(decodeViewImage('{"path":"/a.png","x":1}'))).toBe(true);
    expect(Result.isFailure(decodeViewImage("{"))).toBe(true);
  });
});
