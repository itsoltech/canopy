import { useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, ScrollView, Text, View } from "react-native";
import { base64Decode } from "@bufbuild/protobuf/wire";
import { File } from "expo-file-system";
import { Button, IconButton } from "../../ui/Button";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { styles, useColors, useTypography } from "../../ui/theme";
import { ImageCanvas } from "./ImageCanvas";
import type { ImageSource } from "./image-source";
import { useImage } from "./useImage";
import { exportFile } from "./export-file";

export function ImageViewer({
  source,
  name,
  alt,
  caption,
  controls,
  onClose,
}: {
  source: ImageSource;
  name: string;
  alt?: string;
  caption?: string;
  controls?: ReactNode;
  onClose: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const image = useImage(source);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [decodeError, setDecodeError] = useState(false);

  async function save() {
    if (busy || !image.uri) return;
    setBusy(true);
    setError("");

    try {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(image.uri);
      const encoded = match?.[2];
      const bytes = encoded !== undefined ? base64Decode(encoded) : await new File(image.uri).bytes();
      await exportFile(name, bytes, match?.[1] || "application/octet-stream");
    } catch {
      setError("Could not export the image. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <FullScreenViewer
      title={name}
      onClose={onClose}
      actions={
        <IconButton
          icon="arrow-down"
          label={Platform.OS === "android" ? "Save image" : "Share image"}
          busy={busy}
          disabled={!image.uri}
          onPress={() => void save()}
        />
      }
    >
      {image.uri && !decodeError ? (
        <ImageCanvas uri={image.uri} name={alt || name} onClose={onClose} onError={() => setDecodeError(true)} />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 20, gap: 12 }}>
          {image.error || decodeError ? (
            <>
              <Text accessibilityRole="alert" style={[styles.body, { color: c.muted }]}>
                {decodeError ? "Could not display the image. Retry, or export it to open in another app." : image.error}
              </Text>
              <Button
                title="Retry"
                onPress={() => {
                  setDecodeError(false);
                  image.retry();
                }}
              />
            </>
          ) : (
            <ActivityIndicator accessibilityLabel="Loading image" color={c.muted} />
          )}
        </View>
      )}
      {caption || controls ? (
        <View style={{ padding: 12, gap: 12, borderTopWidth: 1, borderColor: c.rule }}>
          {controls}
          {caption ? (
            <ScrollView style={{ maxHeight: 100 }}>
              <Text style={[type.small, { color: c.soft }]}>{caption}</Text>
            </ScrollView>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={[styles.meta, { padding: 12, color: c.danger }]}>
          {error}
        </Text>
      ) : null}
    </FullScreenViewer>
  );
}
