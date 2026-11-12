import { useState, type ReactNode } from "react";
import { SectionList, Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { fileRows } from "@canopy/domain/github-read";
import { useContentPadding } from "../../ui/ScreenFrame";
import { useColors, useTypography } from "../../ui/theme";
import { useCodeRead } from "./useCodeRead";
import { PageControls } from "./PageControls";
import { CodeToolbar, CommitFilter } from "./CodeToolbar";
import { CodeFileHeader, CodeFileDiff, CodeFolder } from "./CodeFile";
import { ViewedCheckbox } from "./ViewedCheckbox";
import { useViewedCount } from "./useViewedCount";
import { useReviewDraft } from "./useReviewDraft";
import { ReviewBar } from "./ReviewBar";
import { ListSkeleton } from "../../ui/Skeleton";

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
  const viewed = useViewedCount(pages.current);
  const draft = useReviewDraft(snapshot);

  return (
    <>
      <ReviewBar snapshot={snapshot} draft={draft} />
      <SectionList
        sections={rows.map((row) => ({
          ...row,
          data: row.kind === "file" && selected?.path === row.file.path ? [row.file] : [],
        }))}
        keyExtractor={(file) => file.path}
        stickySectionHeadersEnabled
        contentContainerStyle={padding}
        ListEmptyComponent={!pages.current && !pages.error ? <ListSkeleton rows={4} inset={false} /> : undefined}
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
              viewed={viewed.label}
            />
            {!!commitSha && (
              <Text style={[type.meta, { color: c.muted }]}>Changes against this commit’s first parent</Text>
            )}
          </View>
        }
        renderSectionHeader={({ section }) =>
          section.kind === "folder" ? (
            <CodeFolder
              depth={section.depth}
              name={section.name}
              open={!collapsed.has(section.key)}
              onPress={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);

                  if (!next.delete(section.key)) next.add(section.key);

                  return next;
                })
              }
            />
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.background }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <CodeFileHeader
                  file={section.file}
                  depth={section.depth}
                  active={selected?.path === section.file.path}
                  onPress={() => toggle(section.file)}
                />
              </View>
              <ViewedCheckbox
                file={section.file}
                snapshot={snapshot}
                stale={!!pages.current?.page?.stale}
                onState={viewed.change}
                onSettled={() => pages.read(false, true)}
              />
            </View>
          )
        }
        renderItem={({ item }) => (
          <CodeFileDiff
            file={item}
            patch={patch}
            busy={busy}
            error={error}
            onRetry={() => void open(item)}
            snapshot={snapshot}
            draft={draft}
            historical={!!commitSha}
          />
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
