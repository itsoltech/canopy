import { isAbsoluteFilePath } from "./thread-files.ts";

const EXTENSIONS = new Set(
  "md markdown mdx txt log csv tsv pdf html htm xml json yaml yml toml ini env png jpg jpeg gif svg webp avif xlsx docx pptx zip c h cc cpp hpp cs css dart diff patch ex exs go gql graphql hs hcl tf java js jsx mjs cjs kt kts lua php pl ps1 py pyi rb rs sh bash sql svelte swift ts tsx vue zig".split(" "),
);

/** Shared web/mobile recognition. A bare name needs a known extension; URLs and shell expressions stay text. */
export function filePathOf(text: string): string | undefined {
  const path = text.trim().replace(/:\d+(?::\d+)?$/, "");

  if (!path || path.length > 1024 || /[\s<>"|*?]/.test(path.replace(/^[A-Za-z]:/, "")) || /^[a-z]+:\/\//i.test(path))
    return undefined;
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1]?.toLowerCase();

  if (!ext) return undefined;

  if (/[\\/]/.test(path)) return isAbsoluteFilePath(path) || /^\.{0,2}[\w.@-]/.test(path) ? path : undefined;

  return EXTENSIONS.has(ext) ? path : undefined;
}

export function fileHrefOf(href: string): string | undefined {
  const raw = href.trim();

  if (raw.toLowerCase().startsWith("file://")) {
    try {
      const url = new URL(raw);

      if (url.hostname && url.hostname !== "localhost") return undefined;
      const path = decodeURIComponent(url.pathname);

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

export const fileName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
