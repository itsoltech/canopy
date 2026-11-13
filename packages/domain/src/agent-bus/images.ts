import { Schema } from "effect";

export const IMAGE_REPLY_LIMITS = {
  fileBytes: 20 * 1024 ** 2,
  batchBytes: 50 * 1024 ** 2,
  batchCount: 10,
  turnBytes: 200 * 1024 ** 2,
  turnCount: 100,
  chunkBytes: 256 * 1024,
  transferMs: 60_000,
  idleMs: 10_000,
} as const;

const ImageArguments = Schema.Struct({
  images: Schema.Array(
    Schema.Struct({
      path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
      alt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
      caption: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
      pair: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
      side: Schema.optionalKey(Schema.Literals(["before", "after"])),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(IMAGE_REPLY_LIMITS.batchCount)),
  caption: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
});

export const ShowImages = ImageArguments.check(Schema.makeFilter((args) => imagePairsProblem(args.images) ?? true));

export const IMAGE_TOOLS = {
  show_images: {
    name: "show_images",
    description:
      "Show images to the user in this thread as durable attachments. Use view_image to inspect images yourself; " +
      "use show_images when asked to show screenshots or how changes look. Choose representative images, not every screenshot. " +
      "Paths must be regular files inside this thread's workspace, worktree or scratch; no traversal, symlinks or remote URLs. " +
      "Send 1–10 images, up to 20 MiB each and 50 MiB total (lower owner limits apply), with descriptive alt text. " +
      "For comparisons, give two images the same pair and sides before/after. Returns delivered only after copies are saved. " +
      "Never claim images were shown if this tool fails.",
    args: ShowImages,
    mutates: true,
  },
} as const;

function imagePairsProblem(images: Schema.Schema.Type<typeof ImageArguments>["images"]): string | undefined {
  const pairs = new Map<string, Set<string>>();

  for (const image of images) {
    if ((image.pair === undefined) !== (image.side === undefined)) return "pair and side must be provided together";

    if (!image.pair || !image.side) continue;
    const sides = pairs.get(image.pair) ?? new Set<string>();

    if (sides.has(image.side)) return "a pair must contain exactly one before and one after image";
    sides.add(image.side);
    pairs.set(image.pair, sides);
  }

  return [...pairs.values()].some((sides) => sides.size !== 2)
    ? "a pair must contain exactly one before and one after image"
    : undefined;
}
