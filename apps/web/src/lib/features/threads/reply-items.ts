import type { Item } from "@canopy/contracts";

/**
 * Published results the reply shows under the turn, also when its work is folded: image galleries and visuals
 * (docs/agent-visuals.md).
 */
export const isReplyResult = (content: Item["content"]): boolean =>
  content.case === "imageGallery" || content.case === "visual";
