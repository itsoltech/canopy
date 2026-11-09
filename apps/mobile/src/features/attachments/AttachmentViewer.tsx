import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { formatBytes } from "@canopy/domain/format";
import { attachmentPreviewKind } from "@canopy/domain/attachment-preview";
import { useSession } from "../../state/session";
import { Button } from "../../ui/Button";
import { FullScreenViewer } from "../../ui/FullScreenViewer";
import { styles, useColors } from "../../ui/theme";
import { TextViewer } from "../viewers/TextViewer";
import { exportFile } from "./export-file";
import { ImageViewer } from "./ImageViewer";
import { readAttachmentPreview } from "./preview";

const FILE_BYTES = 30 * 1024 ** 2;

export function AttachmentViewer({ file, onClose }: { file: ui.Attachment; onClose: () => void }) {
  return file.kind === "image" ? (
    <ImageViewer source={{ kind: "attachment", file }} name={file.name} onClose={onClose} />
  ) : (
    <FileViewer file={file} onClose={onClose} />
  );
}

function FileViewer({ file, onClose }: { file: ui.Attachment; onClose: () => void }) {
  const { client } = useSession();
  const c = useColors();
  const [data, setData] = useState<Uint8Array>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const kind = attachmentPreviewKind(file);
  const previewable = kind === "text" || kind === "markdown";
  const tooLarge = file.sizeBytes > BigInt(FILE_BYTES);
  const { id, mimeType } = file;

  useEffect(() => {
    if (!client || tooLarge) return;
    const controller = new AbortController();
    setError("");
    setText(undefined);
    setLoaded(false);

    if (previewable) {
      void readAttachmentPreview(client.api, file)
        .then((preview) => {
          if (controller.signal.aborted) return;
          setText(preview.text);
          setTruncated(preview.truncated);
          setLoaded(true);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("Could not load the preview. Check the connection, then retry.");
        });

      return () => controller.abort();
    }

    void client.api
      .getAttachment({ attachmentId: id }, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;

        if (response.data.length > FILE_BYTES) throw new Error("File too large");
        setData(response.data);
        setLoaded(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not load the file. Check the connection, then retry.");
      });

    return () => controller.abort();
  }, [client, id, mimeType, tooLarge, retry, previewable, file]);

  async function save() {
    if (!client || busy) return;
    setBusy(true);

    try {
      const bytes = data ?? (await client.api.getAttachment({ attachmentId: id })).data;

      if (bytes.length > FILE_BYTES) throw new Error("File too large");
      await exportFile(file.name, bytes, mimeType);
    } catch {
      setError("Could not export the file. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const action = (
    <Button
      title={Platform.OS === "android" ? "Save file" : "Share file"}
      busy={busy}
      disabled={!loaded || tooLarge}
      onPress={() => void save()}
      size="sm"
    />
  );

  if (text !== undefined && !error)
    return (
      <TextViewer
        text={text}
        threadId=""
        label={file.name}
        onClose={onClose}
        extraActions={action}
        attachment
        markdown={kind === "markdown"}
        notice={`${formatBytes(file.sizeBytes)}${truncated ? " · Showing up to 128 KB and 2,000 lines. Save or share for the full file." : ""}`}
      />
    );

  return (
    <FullScreenViewer title={file.name} onClose={onClose} actions={action}>
      <View style={{ padding: 20, gap: 12 }}>
        <Text style={[styles.body, { color: c.text }]}>
          {formatBytes(file.sizeBytes)} · {mimeType}
        </Text>
        {tooLarge ? (
          <Text accessibilityRole="alert" style={[styles.body, { color: c.muted }]}>
            This file exceeds the 30 MB limit. Attach a smaller file to view it.
          </Text>
        ) : error ? (
          <>
            <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
              {error}
            </Text>
            <Button title="Retry" onPress={() => setRetry((n) => n + 1)} />
          </>
        ) : !loaded ? (
          <ActivityIndicator accessibilityLabel="Loading file" color={c.muted} />
        ) : (
          <Text style={[styles.body, { color: c.muted }]}>
            {previewable
              ? "No text preview. Save or share the file to open it."
              : "Save or share this file to open it in another app."}
          </Text>
        )}
      </View>
    </FullScreenViewer>
  );
}
