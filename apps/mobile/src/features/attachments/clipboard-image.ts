import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";

/** Reads only after the user selects Paste image, after the attachment menu dismisses. */
export async function clipboardImage() {
  try {
    const image = await Clipboard.getImageAsync({ format: "png" });

    if (!image) {
      Alert.alert("No image was pasted", "Copy an image and try again.", [{ text: "Close" }]);

      return;
    }

    const base64 = image.data.slice(image.data.indexOf(",") + 1);

    return { data: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)), previewUri: image.data };
  } catch {
    Alert.alert("Could not paste image", "Copy the image again, then allow pasting if asked.", [{ text: "Close" }]);
  }
}
