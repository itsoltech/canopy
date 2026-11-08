import type { IconName } from "@canopy/ui/icons";

export type AttachmentKind = "image" | "video" | "file";

const images = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;
const videos = /\.(3gp|avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)$/i;

/** Presentation only: the gateway still decides the stored kind from the uploaded bytes. */
export function attachmentKind(name: string, mimeType = ""): AttachmentKind {
  if (mimeType.startsWith("image/")) return "image";

  if (mimeType.startsWith("video/")) return "video";

  if (images.test(name)) return "image";

  if (videos.test(name)) return "video";

  return "file";
}

interface FileFormat {
  icon: IconName;
  label: string;
}

/** MIME metadata is sometimes missing or generic, so retain the filename fallback. */
export function fileFormat(name: string, mimeType = ""): FileFormat {
  if (mimeType === "application/pdf" || /\.pdf$/i.test(name)) return { icon: "file-pdf", label: "PDF" };

  if (/zip|compressed|archive|tar|gzip/i.test(mimeType) || /\.(7z|bz2|gz|rar|tar|tgz|xz|zip)$/i.test(name))
    return { icon: "archive-box", label: "Archive" };

  if (/spreadsheet|excel|csv|tab-separated/i.test(mimeType) || /\.(csv|ods|tsv|xlsx?)$/i.test(name))
    return { icon: "table-cells", label: "Spreadsheet" };

  if (mimeType.startsWith("audio/") || /\.(aac|aiff?|flac|m4a|mp3|oga|ogg|opus|wav|wma)$/i.test(name))
    return { icon: "musical-note", label: "Audio" };

  if (
    /^(application|text)\/(x-)?(javascript|typescript|json|xml|yaml|sql)(;|$)|\+(json|xml)$/i.test(mimeType) ||
    /\.(c|cc|cpp|cs|css|go|h|html?|java|[cm]?[jt]sx?|json|kt|php|py|rb|rs|sh|sql|svelte|swift|toml|vue|xml|ya?ml)$/i.test(
      name,
    )
  )
    return { icon: "code-bracket", label: "Code" };

  if (mimeType.startsWith("text/") || /\.(log|md|mdx|rtf|txt)$/i.test(name))
    return { icon: "document-text", label: "Text" };

  return { icon: "paper-clip", label: "File" };
}

/** ImagePicker reports milliseconds; keep the marker short, including for clips under a second. */
export function videoDuration(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const seconds = Math.ceil(milliseconds / 1000);

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
