import type { Item } from "@canopy/contracts";
import { formatVideoDuration } from "@canopy/domain";

export function artifactTitle({ content }: Item): string {
  switch (content.case) {
    case "visual":
      return content.value.title || "Visual";
    case "publishedVideo":
      return content.value.caption || content.value.attachment?.name || "Video";
    case "imageGallery": {
      const first = content.value.images[0];

      return content.value.caption || first?.caption || first?.alt || first?.name || "Images";
    }

    default:
      return "Artifact";
  }
}

export function artifactDetail({ content }: Item): string {
  switch (content.case) {
    case "visual":
      return `${content.value.htmlDocument ? "HTML visual" : "Visual"} · Version ${content.value.version}`;
    case "publishedVideo": {
      const duration = formatVideoDuration(content.value.attachment?.durationMs);

      return duration ? `Video · ${duration}` : "Video";
    }

    case "imageGallery":
      return content.value.images.length === 1
        ? "Image"
        : `Gallery · ${content.value.images.length.toLocaleString()} images`;
    default:
      return "";
  }
}
