import { lazy, Suspense } from "react";
import { ActivityIndicator, Text, TurboModuleRegistry } from "react-native";
import type { WorkspaceFile } from "@canopy/domain/workspace-file";
import { styles, useColors } from "../../ui/theme";

const Preview = lazy(() => import("./WorkspaceMarkdownPreview"));
const available = TurboModuleRegistry.get("RNCWebViewModule") !== null;

export function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

export function MarkdownPreviewState({ failed = false, empty = false }: { failed?: boolean; empty?: boolean }) {
  const c = useColors();

  if (!failed && !empty)
    return <ActivityIndicator accessibilityLabel="Preparing Markdown…" color={c.muted} style={{ padding: 16 }} />;

  return (
    <Text accessibilityRole={failed ? "alert" : undefined} style={[styles.body, { color: c.muted, padding: 16 }]}>
      {failed ? "Could not render Markdown. View the source to read the file." : "No content."}
    </Text>
  );
}

export function WorkspaceMarkdown({ text, document }: { text: string; document: WorkspaceFile }) {
  if (!text.trim()) return <MarkdownPreviewState empty />;

  if (!available) return <MarkdownPreviewState failed />;

  return (
    <Suspense fallback={<MarkdownPreviewState />}>
      <Preview text={text} document={document} />
    </Suspense>
  );
}
