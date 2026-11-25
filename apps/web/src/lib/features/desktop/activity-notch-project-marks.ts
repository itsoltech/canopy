import { base64Encode } from "@bufbuild/protobuf/wire";
import type { ui } from "@canopy/contracts";
import { palette } from "@canopy/ui";
import { activityNotchLogoSize, type ActivityNotchProjectMark } from "@canopy/ui/desktop";
import { projectMark, projectMarkColors } from "@canopy/ui/thread-row";

function markInitials(name: string, shared: string): string {
  let initials = shared;

  if (/\p{Cs}/u.test(shared)) {
    // The shared UTF-16 slicing can split a supplementary-plane letter or number.
    const [first = "?", second = ""] = name.match(/[\p{L}\p{N}]+/gu) ?? [];
    const [head = "?", next = ""] = first;
    const [tail = next] = second;

    initials = `${head}${tail}`.toUpperCase();
  }

  return initials.length > 4 ? [...initials].slice(0, 4).join("") : initials;
}

function downsamplePng(image: HTMLImageElement): string | undefined {
  const size = activityNotchLogoSize;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");

  if (!context) return undefined;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);

  return base64Encode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
}

type ProjectPixels = { pixels?: string };

/** One cache per watcher, shared by visible rows using the same source PNG. */
export class ActivityNotchProjectMarks {
  #images = new Map<string, ProjectPixels>();

  constructor(private readonly onImageReady: () => void) {}

  mark(project: ui.Project | undefined, visibleImages: Set<string>): ActivityNotchProjectMark | undefined {
    if (!project || project.kind === "scratch") return undefined;

    const identity = projectMark(project.name);
    const colors = projectMarkColors(project.color);
    const tone = palette[identity.tone];

    const alpha = Math.round(identity.opacity * 255)
      .toString(16)
      .padStart(2, "0");

    const fallback = {
      initials: markInitials(project.name, identity.initials),
      foreground: colors?.text ?? tone[identity.dark],
      background: colors?.fill ?? `${tone[identity.fill]}${alpha}`,
    };

    if (!project.imageBase64) return fallback;

    visibleImages.add(project.imageBase64);
    const pixels = this.#pixels(project.imageBase64);

    return pixels ? { ...fallback, pixels } : fallback;
  }

  retain(visibleImages: ReadonlySet<string>) {
    for (const source of this.#images.keys()) if (!visibleImages.has(source)) this.#images.delete(source);
  }

  clear() {
    this.#images.clear();
  }

  #pixels(source: string): string | undefined {
    const existing = this.#images.get(source);

    if (existing) return existing.pixels;

    const pending: ProjectPixels = {};
    this.#images.set(source, pending);
    const image = new Image();
    image.src = `data:image/png;base64,${source}`;

    void image
      .decode()
      .then(() => {
        if (this.#images.get(source) !== pending) return;
        const pixels = downsamplePng(image);

        if (!pixels) return;
        pending.pixels = pixels;
        this.onImageReady();
      })
      .catch(() => {});

    return undefined;
  }
}
