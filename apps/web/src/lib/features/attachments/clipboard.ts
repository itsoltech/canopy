import { filesOf } from "./draft.svelte.ts";

/**
 * What a paste carries for the attachments (docs/ui-api.md, "Wklejanie i upuszczanie plików"). Browsers and the
 * desktop app give files copied in a file manager (Finder, Explorer, Linux file managers) and copied images or
 * screenshots as files; the text that comes with a file manager's copy only names those files.
 */
export interface PastedFiles {
  readonly files: File[];
  /** The text pastes too (text with files, e.g. an office copy); false when it only names the files. */
  readonly text: boolean;
  /** Files were copied, but the browser gives only their addresses: say how else to attach them. */
  readonly unreachable: boolean;
}

/** Images inlined as `data:` URLs (some apps copy an image as HTML only). */
const INLINE_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']?(data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+)/gi;

const lines = (text: string) =>
  text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);

/** The last segment of a path or `file://` URL. */
function baseName(line: string): string {
  const path = line.replace(/^file:\/\/[^/]*/i, "");
  const last = path.split(/[\\/]/).findLast(Boolean) ?? "";

  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const fileUrls = (text: string) => lines(text).filter((line) => !line.startsWith("#"));

function inlineImages(html: string): File[] {
  return [...html.matchAll(INLINE_IMAGE)].flatMap((match, index) => {
    const [, url = "", subtype = "png"] = match;

    try {
      const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1).replace(/\s/g, "")), (c) => c.charCodeAt(0));

      return [
        new File([bytes], `pasted-image-${index + 1}.${subtype === "jpeg" ? "jpg" : subtype}`, {
          type: `image/${subtype}`,
        }),
      ];
    } catch {
      return [];
    }
  });
}

export function pastedFiles(data: DataTransfer | null): PastedFiles {
  if (!data) return { files: [], text: false, unreachable: false };
  const plain = data.getData("text/plain");
  let files = filesOf(data);

  if (files.length === 0 && !plain.trim()) files = inlineImages(data.getData("text/html"));

  if (files.length === 0) {
    const urls = fileUrls(data.getData("text/uri-list") || plain);
    const unreachable = urls.length > 0 && urls.every((url) => /^file:\/\//i.test(url));

    return { files, text: !unreachable, unreachable };
  }

  // A file manager's copy also carries the files' names or paths as text: only the files paste.
  const names = new Set(files.map((file) => file.name));
  const named = lines(plain);
  const text = named.length > 0 && !named.every((line) => names.has(baseName(line)));

  return { files, text, unreachable: false };
}

/** Said when a browser keeps copied files to itself. */
export const UNREACHABLE_FILES = "This browser can't paste copied files. Drag them in or choose Attach files.";
