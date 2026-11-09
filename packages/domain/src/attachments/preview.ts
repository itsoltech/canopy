/** Shared preview limits and file classification. File contents never become HTML. */
export const ATTACHMENT_PREVIEW_BYTES = 128 * 1024;

export type AttachmentPreviewKind = "image" | "markdown" | "text" | "file";

export function attachmentPreviewKind(file: { name: string; mimeType: string; kind?: string }): AttachmentPreviewKind {
  if (file.kind === "image" || file.mimeType === "image/svg+xml") return "image";

  if (/^(text\/(markdown|x-markdown))($|;)/i.test(file.mimeType) || /\.(md|markdown|mdown)$/i.test(file.name))
    return "markdown";

  if (
    /^text\//i.test(file.mimeType) ||
    /^application\/(?:[\w.+-]*\+)?(?:json|xml|javascript|x-javascript|typescript|yaml|x-yaml|sql)(?:;|$)/i.test(
      file.mimeType,
    ) ||
    /\.(txt|log|csv|tsv|jsonl?|ndjson|ya?ml|toml|ini|cfg|conf|env|diff|patch|xml|html?|css|scss|less|[cm]?[jt]sx?|svelte|vue|c|cc|cpp|h|hpp|cs|go|rs|py|rb|sh|bash|zsh|fish|sql|java|kt|swift|php|r|tex)$/i.test(
      file.name,
    ) ||
    /^(dockerfile|makefile|gitignore|\.gitignore|\.env)(\.|$)/i.test(file.name)
  )
    return "text";

  return "file";
}

/** UTF-8 replacement decoding, after rejecting NULs and non-whitespace control bytes. */
export function decodeAttachmentText(data: Uint8Array): string | undefined {
  const bytes = data.subarray(0, ATTACHMENT_PREVIEW_BYTES);
  let controls = 0;

  for (const byte of bytes) {
    if (byte === 0) return undefined;

    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) controls++;
  }

  if (controls > bytes.length / 100) return undefined;

  return new TextDecoder("utf-8").decode(bytes);
}

export interface AttachmentTextPreview {
  text: string | undefined;
  truncated: boolean;
}

export function attachmentTextPreview(data: Uint8Array, sizeBytes: bigint): AttachmentTextPreview {
  const decoded = decodeAttachmentText(data);
  const lines = decoded?.split("\n");
  const lineLimit = lines !== undefined && lines.length > 2000;

  return {
    text: lineLimit ? lines.slice(0, 2000).join("\n") : decoded,
    truncated: sizeBytes > BigInt(Math.min(data.length, ATTACHMENT_PREVIEW_BYTES)) || lineLimit,
  };
}

/** A bounded, single-flight session cache. Failed reads are retryable. Scope an instance to one connection. */
export class AttachmentPreviewCache {
  readonly #entries = new Map<string, Promise<AttachmentTextPreview>>();

  read(key: string, load: () => Promise<AttachmentTextPreview>): Promise<AttachmentTextPreview> {
    const cached = this.#entries.get(key);

    if (cached) return cached;

    const pending = load().catch((error: Error) => {
      if (this.#entries.get(key) === pending) this.#entries.delete(key);
      throw error;
    });

    this.#entries.set(key, pending);

    if (this.#entries.size > 64) this.#entries.delete(this.#entries.keys().next().value!);

    return pending;
  }
}
