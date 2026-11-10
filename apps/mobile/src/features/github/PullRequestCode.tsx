import { useState, type ReactNode } from "react";
import { Pressable, SectionList, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { fileRows } from "@canopy/domain/github-read";
import { useContentPadding } from "../../ui/ScreenFrame";
import { useColors, useTypography } from "../../ui/theme";
import { Icon } from "../../ui/Icon";
import { useCodeRead } from "./useCodeRead";
import { PageControls } from "./PageControls";
import { CodeToolbar, CommitFilter } from "./CodeToolbar";
import { CodeFileHeader, CodeFileDiff } from "./CodeFile";

export function PullRequestCode({ snapshot, header }: { snapshot: github.PullRequestSnapshot; header: ReactNode }) {
  const c = useColors();
  const type = useTypography();
  const padding = useContentPadding();
  const { pages, commits, commitSha, setCommit, selected, patch, busy, error, open, toggle } = useCodeRead(snapshot);
  const [picker, setPicker] = useState(false);
  const [tree, setTree] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const files = pages.current?.files ?? [];
  const rows = fileRows(files, tree, collapsed);

  return (
    <>
      <SectionList
        sections={rows.map((row) => ({
          ...row,
          data: row.kind === "file" && selected?.path === row.file.path ? [row.file] : [],
        }))}
        keyExtractor={(file) => file.path}
        stickySectionHeadersEnabled
        contentContainerStyle={padding}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            {header}
            <CodeToolbar
              commit={commitSha}
              count={
                commitSha ? `${files.length}${pages.current?.page?.nextCursor ? "+" : ""}` : String(snapshot.files)
              }
              tree={tree}
              onTree={() => setTree(!tree)}
              onCommit={() => setPicker(true)}
            />
            {!!commitSha && (
              <Text style={[type.meta, { color: c.muted }]}>Changes against this commit’s first parent</Text>
            )}
          </View>
        }
        renderSectionHeader={({ section }) =>
          section.kind === "folder" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: !collapsed.has(section.key) }}
              onPress={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);

                  if (!next.delete(section.key)) next.add(section.key);

                  return next;
                })
              }
              style={{
                flexDirection: "row",
                minHeight: 44,
                alignItems: "center",
                gap: 8,
                backgroundColor: c.background,
                paddingLeft: Math.min(section.depth, 6) * 12,
              }}
            >
              <Icon name={collapsed.has(section.key) ? "chevron-right" : "chevron-down"} />
              <Icon name="folder" />
              <Text style={[type.meta, { color: c.text }]}>{section.name}</Text>
            </Pressable>
          ) : (
            <CodeFileHeader
              file={section.file}
              depth={section.depth}
              active={selected?.path === section.file.path}
              onPress={() => toggle(section.file)}
            />
          )
        }
        renderItem={({ item }) => (
          <CodeFileDiff file={item} patch={patch} busy={busy} error={error} onRetry={() => void open(item)} />
        )}
        ListFooterComponent={
          <PageControls
            page={pages.current?.page}
            busy={pages.busy}
            error={pages.error}
            previous={pages.previous}
            next={() => void pages.read(true)}
            retry={() => void pages.read(false, true)}
          />
        }
      />
      <CommitFilter
        open={picker}
        value={commitSha}
        pages={commits}
        onClose={() => setPicker(false)}
        onSelect={(sha) => {
          setCommit(sha);
          setPicker(false);
        }}
      />
    </>
  );
}
