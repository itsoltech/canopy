import type { ReactNode } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { Button } from "../../ui/Button";
import { TextInput } from "../../ui/TextInput";
import { styles, useColors, useTypography } from "../../ui/theme";
import { FileLookup } from "./FileLookup";
import { ThreadFileImage } from "./ThreadFileImage";
import type { ThreadFileState } from "./file-state";

export function FilePreview({
  viewer,
  name,
  detail,
  actions,
  preview,
  onDiscard,
}: {
  viewer: ThreadFileState;
  name: string;
  detail: string;
  actions: ReactNode;
  preview?: ReactNode;
  onDiscard: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const file = viewer.file;

  return (
    <>
      <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 8, gap: 8 }}>
        {detail || viewer.editable ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              selectable
              numberOfLines={1}
              ellipsizeMode="middle"
              style={[styles.caption, { color: c.muted, flex: 1 }]}
            >
              {detail}
            </Text>
            {viewer.editable && (
              <Text
                accessibilityElementsHidden={!viewer.dirty}
                importantForAccessibility={viewer.dirty ? "yes" : "no"}
                accessibilityLiveRegion="polite"
                style={[styles.caption, { color: c.muted, opacity: viewer.dirty ? 1 : 0, maxWidth: "50%" }]}
              >
                Unsaved changes
              </Text>
            )}
          </View>
        ) : null}
        {actions}
        {viewer.error ? (
          <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
            {viewer.error}
          </Text>
        ) : null}
        {viewer.editable && viewer.error && <Button title="Discard and reload" onPress={onDiscard} />}
      </View>
      {viewer.loading ? (
        <ActivityIndicator accessibilityLabel="Opening the file" color={c.muted} />
      ) : preview ? (
        preview
      ) : viewer.editable ? (
        <TextInput
          multiline
          value={viewer.draft}
          onChangeText={viewer.setDraft}
          editable={!viewer.busy && !viewer.readOnly}
          accessibilityLabel={`Edit ${name}`}
          autoCapitalize="none"
          autoCorrect={false}
          style={[type.mono, { flex: 1, padding: 16, color: c.text, textAlignVertical: "top" }]}
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
          {file ? (
            file.truncated ? (
              <Text style={[styles.body, { color: c.muted }]}>
                This file exceeds the 2 MB preview limit. Open a smaller file to preview it.
              </Text>
            ) : /^image\/(png|jpeg|gif|webp|avif)$/.test(file.mimeType) ? (
              <ThreadFileImage key={file.sha256} file={file} name={name} />
            ) : (
              <Text style={[styles.body, { color: c.muted }]}>
                Canopy cannot show this file. Open it on the thread’s computer.
              </Text>
            )
          ) : !viewer.error && viewer.lookup ? (
            <FileLookup file={viewer.lookup} name={name} onSelect={viewer.reload} />
          ) : null}
        </ScrollView>
      )}
    </>
  );
}
