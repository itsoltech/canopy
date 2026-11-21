export { INLINE_IMAGE_TYPES, extensionOf, sniff, type Sniffed, type SniffedKind } from "./sniff.ts";

export { videoDurationMs, formatVideoDuration } from "./video.ts";

export { attachmentRange } from "./range.ts";

export {
  DEFAULT_ATTACHMENT_LIMITS,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_FILE_MIB,
  MAX_ATTACHMENT_RPC_BYTES,
  attachmentPath,
  attachmentsNote,
  formatSize,
  safeFileName,
  withAttachmentsNote,
  withExtension,
  type AttachmentKind,
  type AttachmentLimits,
  type NotedAttachment,
} from "./files.ts";

export {
  VIEW_IMAGE_DESCRIPTION,
  VIEW_IMAGE_TOOL,
  ViewImage,
  decodeViewImage,
  viewImageSpec,
  type ViewImageArgs,
} from "./view-image.ts";
