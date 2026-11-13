/**
 * What a file is, from its bytes (docs/ui-api.md, "Załączniki"). The browser's MIME type and the name's extension
 * are not trusted: the content decides. The extension only refines text (Markdown, JSON, CSV, ...) and names
 * executables whose bytes give them away anyway.
 *
 * - `image`: formats every model and browser takes (PNG, JPEG, GIF, WebP); shown inline in the UI.
 * - `convertible`: an image to re-encode before use (HEIC/HEIF, AVIF, TIFF); a file when it cannot be decoded.
 * - `file`: everything else, including SVG and HTML (text the UI never renders inline).
 * - `executable`: native programs (ELF, PE, Mach-O): rejected.
 */

import { videoType } from "./video.ts";

export type SniffedKind = "image" | "video" | "convertible" | "file" | "executable";

export interface Sniffed {
  readonly kind: SniffedKind;
  readonly mimeType: string;
  /** Valid UTF-8 without NUL bytes. */
  readonly text: boolean;
}

/** Raster images shown inline and handed to models as they are. */
export const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "dll",
  "msi",
  "com",
  "scr",
  "sys",
  "so",
  "dylib",
  "bin",
  "elf",
  "app",
  "msix",
  "appx",
]);

const TEXT_TYPES = new Map([
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["json", "application/json"],
  ["jsonl", "application/jsonl"],
  ["csv", "text/csv"],
  ["tsv", "text/tab-separated-values"],
  ["xml", "application/xml"],
  ["yaml", "application/yaml"],
  ["yml", "application/yaml"],
  ["toml", "application/toml"],
  ["html", "text/html"],
  ["htm", "text/html"],
  ["css", "text/css"],
  ["log", "text/plain"],
]);

const ZIP_TYPES = new Map([
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["odt", "application/vnd.oasis.opendocument.text"],
  ["ods", "application/vnd.oasis.opendocument.spreadsheet"],
  ["epub", "application/epub+zip"],
  ["jar", "application/java-archive"],
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function sniff(bytes: Uint8Array, name = ""): Sniffed {
  const ext = extensionOf(name);
  const binary = (kind: SniffedKind, mimeType: string): Sniffed => ({ kind, mimeType, text: false });
  const at = (offset: number, ...values: number[]) => values.every((v, i) => bytes[offset + i] === v);
  const ascii = (offset: number, value: string) => at(offset, ...[...value].map((c) => c.charCodeAt(0)));

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return binary("image", "image/png");

  if (at(0, 0xff, 0xd8, 0xff)) return binary("image", "image/jpeg");

  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return binary("image", "image/gif");

  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return binary("image", "image/webp");

  const video = videoType(bytes);

  if (video) return binary("video", video);

  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));

    if (brand === "avif" || brand === "avis") return binary("convertible", "image/avif");

    if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand))
      return binary("convertible", "image/heic");

    return binary("file", "application/octet-stream");
  }

  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return binary("convertible", "image/tiff");

  if (ascii(0, "%PDF-")) return binary("file", "application/pdf");

  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06))
    return binary("file", ZIP_TYPES.get(ext) ?? "application/zip");

  if (at(0, 0x1f, 0x8b)) return binary("file", "application/gzip");

  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return binary("file", "application/x-7z-compressed");

  if (ascii(0, "Rar!")) return binary("file", "application/vnd.rar");

  if (at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return binary("file", "application/x-xz");

  if (ascii(0, "BZh")) return binary("file", "application/x-bzip2");

  if (ascii(257, "ustar")) return binary("file", "application/x-tar");

  // Native programs: ELF, Windows PE ("MZ"), Mach-O (both byte orders, 32/64 bit, universal).
  if (at(0, 0x7f, 0x45, 0x4c, 0x46)) return binary("executable", "application/x-executable");

  if (ascii(0, "MZ")) return binary("executable", "application/vnd.microsoft.portable-executable");

  if (
    at(0, 0xfe, 0xed, 0xfa, 0xce) ||
    at(0, 0xfe, 0xed, 0xfa, 0xcf) ||
    at(0, 0xce, 0xfa, 0xed, 0xfe) ||
    at(0, 0xcf, 0xfa, 0xed, 0xfe) ||
    at(0, 0xca, 0xfe, 0xba, 0xbe)
  ) {
    return binary("executable", "application/x-mach-binary");
  }

  if (isText(bytes)) {
    const head = new TextDecoder().decode(bytes.subarray(0, 4096)).trimStart().toLowerCase();

    if (
      /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/.test(head) ||
      (ext === "svg" && head.includes("<svg"))
    ) {
      return { kind: "file", mimeType: "image/svg+xml", text: true };
    }

    if (head.startsWith("<!doctype html") || head.startsWith("<html"))
      return { kind: "file", mimeType: "text/html", text: true };

    return { kind: "file", mimeType: TEXT_TYPES.get(ext) ?? "text/plain", text: true };
  }

  if (EXECUTABLE_EXTENSIONS.has(ext)) return binary("executable", "application/octet-stream");

  return binary("file", "application/octet-stream");
}

/** Valid UTF-8 (a cut multi-byte sequence at the end is fine) without NUL bytes, judged on the first 64 KiB. */
function isText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 65_536);

  if (sample.includes(0)) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: sample.length < bytes.length });

    return true;
  } catch {
    return false;
  }
}
