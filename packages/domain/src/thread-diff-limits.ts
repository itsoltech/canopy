/** Shared worker and gateway bounds for disk-spooled Git reviews. */
export const DIFF_BYTES = 1024 * 1024 * 1024;
export const DIFF_FILES = 10_000;
export const DIFF_METADATA_BYTES = 2 * 1024 * 1024;
export const DIFF_LINE_BYTES = 256 * 1024;
export const DIFF_PAGE_BYTES = 512 * 1024;

// Leave room for the page envelope, path and per-line protobuf framing.
export const DIFF_PAGE_CONTENT_BYTES = DIFF_PAGE_BYTES - 8 * 1024;
