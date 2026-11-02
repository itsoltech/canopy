export { forModel, forTranscript, ImageError, MAX_EDGE, MAX_MODEL_BYTES, type NormalizedImage } from "./normalize.ts";
export { inlineImages, PreviewStore } from "./previews.ts";
export { readLimited, viewImage, within, type ViewedImage, type ViewImageScope } from "./view-image.ts";

/** What view_image hands the harness: the image (base64) and a line about it, or why there is none. */
export type ViewImageResult =
  | { readonly ok: true; readonly base64: string; readonly mimeType: string; readonly summary: string }
  | { readonly ok: false; readonly message: string };
