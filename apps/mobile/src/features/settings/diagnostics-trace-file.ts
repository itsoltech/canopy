import { Directory, File, Paths } from "expo-file-system";
import { Platform, Share } from "react-native";

/** Existing native modules only; a bounded explicit trace export, no background sharing. */
export async function saveDiagnosticTrace(text: string) {
  const file = new File(Paths.cache, "canopy-trace.json");

  try {
    file.create({ overwrite: true });
    file.write(text);

    if (Platform.OS === "android") {
      const folder = await Directory.pickDirectoryAsync();
      const destination = folder.createFile("canopy-trace.json", "application/json");

      try {
        await file.copy(destination, { overwrite: true });
      } catch (error) {
        if (destination.exists) destination.delete();
        throw error;
      }

      return `Saved canopy-trace.json to ${folder.name || "the selected folder"}.`;
    }

    const result = await Share.share({ url: file.uri });

    return result.action === Share.sharedAction ? "Samples shared." : "";
  } finally {
    if (file.exists) file.delete();
  }
}
