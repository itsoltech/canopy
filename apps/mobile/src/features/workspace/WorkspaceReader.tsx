import { useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import type { WorkspaceTab } from "@canopy/domain/workspace";
import { Button } from "../../ui/Button";
import { Markdown } from "../../ui/markdown/Markdown";
import { styles, useColors } from "../../ui/theme";
import { useDevicePreferences } from "../settings/device-preferences";
import { CopyAction } from "../viewers/copy-action";
import { WorkspaceText } from "./WorkspaceText";

export function WorkspaceReader({
  tab,
  name,
  actions,
  onKeep,
  onLocate,
}: {
  tab: WorkspaceTab;
  name: string;
  actions: ReactNode;
  onKeep: () => void;
  onLocate: () => void;
}) {
  const document = tab.document;
  const c = useColors();
  const preferences = useDevicePreferences();
  const [source, setSource] = useState(Boolean(document.position));
  const markdown = /\.(md|markdown|mdx)$/i.test(name);
  const rendered = markdown && !source && preferences.values.attachmentMarkdown === "rendered";

  return (
    <>
      <View style={{ padding: 12, gap: 8 }}>
        {actions}
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {tab.preview && <Button size="sm" title="Keep tab" onPress={onKeep} />}
          <Button
            size="sm"
            title="Go to line"
            onPress={() => {
              setSource(true);
              onLocate();
            }}
          />
          {markdown && (
            <Button
              size="sm"
              title={rendered ? "View source" : "Render Markdown"}
              onPress={() => {
                setSource(rendered);
                preferences.set("attachmentMarkdown", rendered ? "source" : "rendered");
              }}
            />
          )}
          <CopyAction text={document.text} label="Copy text" />
          <CopyAction text={document.path} label="Copy path" />
        </View>
        <Text numberOfLines={1} style={[styles.caption, { color: c.muted }]}>
          {document.file?.relativePath || document.path}
        </Text>
        {document.file?.truncated && (
          <Text style={[styles.caption, { color: c.muted }]}>Showing the first 2 MB. This file is read only.</Text>
        )}
        {document.error ? (
          <Text accessibilityRole="alert" style={[styles.body, { color: c.danger }]}>
            {document.error}
          </Text>
        ) : null}
      </View>
      {rendered ? (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          <Markdown text={document.text} />
        </ScrollView>
      ) : (
        <WorkspaceText document={document} />
      )}
    </>
  );
}
