import { isAbsoluteFilePath } from "./thread-files.ts";

const EXTENSIONS = new Set(
  "md markdown mdx txt log csv tsv pdf html htm xml json yaml yml toml ini env png jpg jpeg gif svg webp avif xlsx docx pptx zip c h cc cpp hpp cs css dart diff patch ex exs go gql graphql hs hcl tf java js jsx mjs cjs kt kts lua php pl ps1 py pyi rb rs sh bash sql svelte swift ts tsx vue zig".split(
    " ",
  ),
);

/** Shared web/mobile recognition. A bare name needs a known extension; URLs and shell expressions stay text. */
export function filePathOf(text: string): string | undefined {
  const path = fileLocation(text).path;

  if (
    !path ||
    path.length > 1024 ||
    /[\s<>"|*?:]/.test(path.replace(/^[A-Za-z]:[\\/]/, "")) ||
    /^[a-z]+:\/\//i.test(path)
  )
    return undefined;
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1]?.toLowerCase();

  if (!ext) return undefined;

  if (/[\\/]/.test(path)) return isAbsoluteFilePath(path) || /^\.{0,2}[\w.@-]/.test(path) ? path : undefined;

  return EXTENSIONS.has(ext) ? path : undefined;
}

export interface FilePosition {
  readonly line: number;
  readonly end: number;
  readonly column: number;
}

export interface FileLocation {
  readonly path: string;
  readonly position?: FilePosition;
}

/** Position is view state, never part of the path sent to the gateway. */
export function fileLocation(text: string): FileLocation {
  const raw = text.trim();
  const match = /(?::(\d+)(?::(\d+)|-(\d+))?|#L(\d+)(?:-(?:L)?(\d+))?)$/.exec(raw);

  if (!match) return { path: raw };
  const line = Number(match[1] ?? match[4]);
  const end = Number(match[3] ?? match[5] ?? line);
  const column = Number(match[2] ?? 1);

  const path = raw.slice(0, match.index);

  if (
    Number.isSafeInteger(line) &&
    line > 0 &&
    Number.isSafeInteger(end) &&
    end >= line &&
    Number.isSafeInteger(column) &&
    column > 0
  )
    return { path, position: { line, end, column } };

  return { path };
}

/** Like fileHrefOf, retaining a validated line/range for workspace navigation. */
export function fileLinkHrefOf(href: string): string | undefined {
  const path = fileHrefOf(href);

  if (!path) return undefined;
  const position = fileLocation(href).position;

  return position
    ? `${path}:${position.line}${position.end > position.line ? `-${position.end}` : `:${position.column}`}`
    : path;
}

export function fileHrefOf(href: string): string | undefined {
  const raw = href.trim();

  if (raw.toLowerCase().startsWith("file://")) {
    try {
      const url = new URL(raw);

      if (url.hostname && url.hostname !== "localhost") return undefined;
      const path = decodeURIComponent(url.pathname);

      return fileLocation(/^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path).path;
    } catch {
      return undefined;
    }
  }

  const direct = filePathOf(raw);

  if (direct) return direct;

  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) return undefined;

  if (raw.startsWith("#") || raw.startsWith("//")) return undefined;

  try {
    return filePathOf(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
}

export const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
