import { useState } from "react";
import { Platform, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { formatSize, formatVideoDuration } from "@canopy/domain";
import { useSession } from "../../state/session";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { exportFile } from "./export-file";
import { attachmentFailure } from "./failure";
import { NativeVideo } from "./NativeVideo";

export function VideoSummary({ file, onClose }: { file: ui.Attachment; onClose: () => void }) {
  const { client } = useSession();
  const c = useColors();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!client || busy) return;
    setBusy(true);
    setError("");

    try {
      const response = await client.api.getAttachment({ attachmentId: file.id });

      if (response.data.length > 30 * 1024 ** 2) throw new Error("Video exceeds the viewing limit");
      await exportFile(file.name, response.data, response.mimeType);
    } catch (cause) {
      setError(attachmentFailure(cause, "Could not export the video. Check the connection, then retry."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FullScreenViewer
      title={file.name}
      onClose={onClose}
      actions={
        <Button
          title={Platform.OS === "android" ? "Save video" : "Share video"}
          busy={busy}
          disabled={!client}
          onPress={() => void save()}
          size="sm"
        />
      }
    >
      <View style={{ padding: 16, gap: 12 }}>
        <NativeVideo file={file} />
        <Text style={[styles.caption, { color: c.muted }]}>
          {[formatSize(file.sizeBytes), formatVideoDuration(file.durationMs)].filter(Boolean).join(" · ")}
        </Text>
        {error ? (
          <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
            {error}
          </Text>
        ) : null}
      </View>
    </FullScreenViewer>
  );
}
