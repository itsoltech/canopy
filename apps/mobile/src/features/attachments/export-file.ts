import { Directory, File, Paths } from "expo-file-system";
import { Platform, Share } from "react-native";

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

/** iOS shares a private temporary file. Android saves to a directory the reader explicitly chooses. */
export async function exportFile(name: string, data: Uint8Array, mimeType: string) {
  const cleaned =
    Array.from(name.split(/[/\\]/).pop() || "attachment")
      .filter((char) => char.charCodeAt(0) >= 32)
      .join("") || "attachment";

  const baseName = /^\.+$/.test(cleaned) ? "attachment" : cleaned;
  const extension = imageExtensions.get(mimeType);
  const safeName = extension ? `${baseName.replace(/\.[^.]*$/, "") || "image"}.${extension}` : baseName;

  if (Platform.OS === "android") {
    const directory = await Directory.pickDirectoryAsync();
    const file = directory.createFile(safeName, mimeType);
    await file.write(data);

    return;
  }

  const directory = new Directory(Paths.cache, `share-${Date.now()}`);
  directory.create();
  const file = new File(directory, safeName);

  try {
    await file.write(data);
    await Share.share({ url: file.uri });
  } finally {
    directory.delete();
  }
}
