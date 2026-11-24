import { File } from "expo-file-system";
import { launchImageLibraryAsync } from "expo-image-picker";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const oversized = { error: "The square crop exceeds 10 MiB. Crop a smaller area or choose another image." };

export async function pickProjectImage(): Promise<{ image: Uint8Array } | { error: string } | undefined> {
  try {
    const result = await launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1] });

    if (result.canceled) return undefined;

    const [asset] = result.assets;

    if (!asset) return { error: "No image was selected. Choose an image and crop it to a square." };

    const file = new File(asset.uri);

    try {
      if (asset.width <= 0 || asset.width !== asset.height)
        return { error: "Canopy could not get a square crop. Choose another image and try again." };

      if (file.size > MAX_IMAGE_BYTES) return oversized;

      const image = await file.bytes();

      if (image.byteLength > MAX_IMAGE_BYTES) return oversized;

      return image.byteLength
        ? { image }
        : { error: "Canopy could not read the crop. Choose another image and try again." };
    } finally {
      try {
        file.delete();
      } catch {
        // The cache may already have removed the temporary crop.
      }
    }
  } catch {
    return { error: "Canopy could not open or crop the image. Choose a PNG, JPEG or WebP image and try again." };
  }
}
