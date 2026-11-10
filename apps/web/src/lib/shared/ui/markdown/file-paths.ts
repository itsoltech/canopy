import { isAbsoluteFilePath } from "@canopy/domain/thread-files";
import { languageOfPath } from "../code/languages.ts";

/** Documents and data an agent writes besides code: these open even as a bare name (`report.pdf`). */
const DOCUMENTS = new Set([
  "md",
  "markdown",
  "txt",
  "log",
  "csv",
  "tsv",
  "pdf",
  "html",
  "htm",
  "xml",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "xlsx",
  "docx",
  "pptx",
  "zip",
]);

const extension = (path: string) => /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1]?.toLowerCase();

/** `src/app.ts:12:4` → `src/app.ts`: an agent's line reference opens the file. */
const withoutLine = (text: string) => text.replace(/:\d+(?::\d+)?$/, "");

/**
 * A file path in an agent's inline code (`out/report.md`, `C:\work\a.sql`, `~/notes.txt`), or undefined for
 * code that only looks similar (commands, identifiers, URLs, versions). A path with a folder needs an
 * extension; a bare name needs one Canopy can show or a document type.
 */
export function filePathOf(text: string): string | undefined {
  const path = withoutLine(text.trim());

  if (!path || path.length > 1024 || /[\s<>"|*?]/.test(path.replace(/^[A-Za-z]:/, "")) || /^[a-z]+:\/\//i.test(path))
    return undefined;
  const ext = extension(path);

  if (!ext) return undefined;
  const folder = /[\\/]/.test(path);

  if (folder) return isAbsoluteFilePath(path) || /^\.{0,2}[\w.@-]/.test(path) ? path : undefined;

  return DOCUMENTS.has(ext) || languageOfPath(path) ? path : undefined;
}

/** The file a Markdown link points at (`[report](out/report.md)`, `file:///…`), or undefined for web links. */
export function fileHrefOf(href: string): string | undefined {
  const raw = href.trim();

  if (raw.toLowerCase().startsWith("file://")) {
    try {
      const path = decodeURIComponent(new URL(raw).pathname);

      // file:///C:/work/a.md → C:/work/a.md
      return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
    } catch {
      return undefined;
    }
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) return undefined;

  if (raw.startsWith("#") || raw.startsWith("//")) return undefined;

  try {
    return filePathOf(decodeURIComponent(raw.split("#")[0] ?? ""));
  } catch {
    return undefined;
  }
}

/** The name shown in the viewer's title. */
export const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
