import { Alert } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { clipboardImage } from "./clipboard-image";
import { attachmentKind, type AttachmentKind } from "./attachment-display";

export interface Picked {
  /** Missing when native intake refused to copy an oversized file. */
  uri?: string;
  data?: Uint8Array;
  name: string;
  size: number;
  kind: AttachmentKind;
  mimeType?: string;
  previewUri?: string;
  duration?: number;
  /** Native intake copy: images last through the draft, other files through the read. */
  temporary?: boolean;
}

type Upload = (picked: Picked) => Promise<void>;

export async function pasteImage(upload: Upload) {
  const image = await clipboardImage();

  if (image) void upload({ ...image, name: `pasted-image-${Date.now()}.png`, size: image.data.length, kind: "image" });
}

export async function pickPhotos(upload: Upload, slots: number) {
  try {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      allowsMultipleSelection: true,
      selectionLimit: Math.max(1, slots),
      quality: 1,
    });

    if (result.canceled) return;

    for (const asset of result.assets) {
      const video = asset.type === "video" || attachmentKind(asset.fileName ?? "", asset.mimeType) === "video";

      void upload({
        uri: asset.uri,
        name: asset.fileName || (video ? `video-${Date.now()}.mp4` : `photo-${Date.now()}.jpg`),
        size: asset.fileSize ?? 0,
        kind: video ? "video" : "image",
        mimeType: asset.mimeType,
        duration: asset.duration ?? undefined,
      });
    }
  } catch {
    Alert.alert("Could not open photos or videos", "Try again or attach a file.", [{ text: "Close" }]);
  }
}

export async function pickFiles(upload: Upload) {
  try {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });

    if (result.canceled) return;

    for (const asset of result.assets)
      void upload({
        uri: asset.uri,
        name: asset.name,
        size: asset.size ?? 0,
        kind: attachmentKind(asset.name, asset.mimeType),
        mimeType: asset.mimeType,
      });
  } catch {
    Alert.alert("Could not open files", "Try again or attach a photo.", [{ text: "Close" }]);
  }
}
