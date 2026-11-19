import { expect, test } from "bun:test";
import { join } from "node:path";
import sharp from "sharp";
import { forTranscript } from "./normalize.ts";
import { viewImage } from "./view-image.ts";

test("view_image and transcript previews decode and rotate HEVC photos from attachments", async () => {
  const root = join(import.meta.dir, "fixtures");
  // Synthetic red-to-blue gradient, 2048 × 128, with a clockwise HEIF container rotation.
  const path = join(root, "rotated-gradient.heic");
  const model = await viewImage(path, { cwd: root, roots: [root] });
  const preview = await forTranscript(await Bun.file(path).bytes());

  expect(model.mimeType).toBe("image/jpeg");
  expect(preview.mimeType).toBe("image/webp");

  for (const result of [model, preview]) {
    expect(result).toMatchObject({ originalWidth: 128, originalHeight: 2048, width: 125, height: 2000 });
    const image = sharp(result.data);
    const metadata = await image.metadata();

    expect(metadata.width).toBe(125);
    expect(metadata.height).toBe(2000);
    expect(metadata.exif).toBeUndefined();
    const pixels = await image.resize(2, 1, { fit: "fill" }).raw().toBuffer();

    expect(pixels[2]).toBeGreaterThan(150); // blue on the left
    expect(pixels[3]).toBeGreaterThan(150); // red on the right
  }
});
