import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { safeHref } from "@canopy/domain/markdown";
import { useSession } from "../../state/session";
import { useContentPadding } from "../../ui/ScreenFrame";
import { useColors, useTypography } from "../../ui/theme";
import { useDevicePreferences } from "../settings/device-preferences";
import { PickerSheet } from "../../ui/Picker";
import { Button, Notice } from "../../ui/components";
import { Diff } from "../../ui/Diff";
import { usePages } from "./usePages";
import { PageControls } from "./PageControls";

export function PullRequestCode({ snapshot, header }: { snapshot: github.PullRequestSnapshot; header: ReactNode }) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const padding = useContentPadding();
  const id = snapshot.summary?.ref?.id ?? "";
  const headSha = snapshot.summary?.headSha ?? "";
  const baseSha = snapshot.baseSha;
  const [commitSha, setCommit] = useState("");
  const [picker, setPicker] = useState(false);
  const [selected, setSelected] = useState<github.PullRequestFile>();
  const [patch, setPatch] = useState<github.PullRequestDiff>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setSelected(undefined);
    setPatch(undefined);
    setBusy(false);
    setError("");
  }, [id, headSha, baseSha, commitSha]);

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestFiles({ pullRequestId: id, cursor, refresh, headSha, baseSha, commitSha }),
      [client, id, headSha, baseSha, commitSha],
    ),
    id,
  );

  const commits = usePages(
    useCallback(
      (cursor: string, refresh: boolean) => client!.api.listPullRequestCommits({ pullRequestId: id, cursor, refresh }),
      [client, id],
    ),
    id,
  );

  async function open(file: github.PullRequestFile) {
    const version = ++generation.current;
    setSelected(file);
    setPatch(undefined);
    setError("");
    setBusy(true);

    try {
      const result = await client!.api.getPullRequestDiff({
        pullRequestId: id,
        headSha,
        baseSha,
        commitSha,
        path: file.path,
        resourceId: String(file.sourcePage),
      });

      if (version === generation.current) setPatch(result);
    } catch {
      if (version === generation.current) setError("Changes updated or unavailable. Refresh the files, then retry.");
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }

  return (
    <>
      <FlatList
        data={pages.current?.files ?? []}
        keyExtractor={(f) => f.path}
        contentContainerStyle={{ ...padding, gap: 8 }}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            {header}
            <Button
              title={commitSha ? `Commit ${commitSha.slice(0, 7)}` : "All commits"}
              variant="ghost"
              onPress={() => setPicker(true)}
            />
            {!!commitSha && (
              <Text style={[type.meta, { color: c.muted }]}>Changes against this commit’s first parent</Text>
            )}
          </View>
        }
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
        renderItem={({ item: file }) => (
          <CodeFile
            file={file}
            active={selected?.path === file.path}
            patch={patch}
            busy={busy}
            error={error}
            onOpen={() => void open(file)}
          />
        )}
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

function CommitFilter({
  open,
  value,
  pages,
  onClose,
  onSelect,
}: {
  open: boolean;
  value: string;
  pages: ReturnType<typeof usePages<github.PullRequestCommitsPage>>;
  onClose: () => void;
  onSelect: (sha: string) => void;
}) {
  return (
    <PickerSheet
      title="Commit filter"
      visible={open}
      value={value}
      search="Search commits"
      onClose={onClose}
      onSelect={onSelect}
      sections={[
        {
          options: [
            { value: "", label: "All commits" },
            ...pages.pages.flatMap((p) =>
              p.commits.map((item) => ({
                value: item.sha,
                label: `${item.sha.slice(0, 7)} ${item.subject}`,
              })),
            ),
          ],
        },
      ]}
      footer={
        <PageControls
          page={pages.current?.page}
          busy={pages.busy}
          error={pages.error}
          next={() => void pages.read(true)}
          retry={() => void pages.read(false, true)}
        />
      }
    />
  );
}

function CodeFile({
  file,
  active,
  patch,
  busy,
  error,
  onOpen,
}: {
  file: github.PullRequestFile;
  active: boolean;
  patch: github.PullRequestDiff | undefined;
  busy: boolean;
  error: string;
  onOpen: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const { values, set } = useDevicePreferences();

  return (
    <View style={{ gap: 8, borderBottomWidth: 1, borderColor: c.line, paddingBottom: 8 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: active }}
        onPress={onOpen}
        style={{ flexDirection: "row", minHeight: 48, alignItems: "center", gap: 8 }}
      >
        <Text numberOfLines={2} style={[type.mono, { flex: 1, color: c.text }]}>
          {file.previousPath ? `${file.previousPath} → ` : ""}
          {file.path}
        </Text>
        <Text style={[type.meta, { color: c.success }]}>+{file.additions}</Text>
        <Text style={[type.meta, { color: c.danger }]}>−{file.deletions}</Text>
      </Pressable>
      {active && (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              title={`Wrap: ${values.wrapDiffs}`}
              variant="ghost"
              onPress={() => set("wrapDiffs", values.wrapDiffs === "on" ? "off" : "on")}
            />
            <Button
              title={`Hide whitespace: ${values.hideWhitespace}`}
              variant="ghost"
              onPress={() => set("hideWhitespace", values.hideWhitespace === "on" ? "off" : "on")}
            />
          </View>
          {busy && <Text style={[type.small, { color: c.muted }]}>Loading patch…</Text>}
          {!!error && <Notice error>{error}</Notice>}
          {patch?.patch ? (
            <Diff diff={patch.patch} label={file.path} bare />
          ) : (
            patch && (
              <Notice>
                {patch.page?.detail || "Binary file or patch unavailable. Open on GitHub to read this file."}
              </Notice>
            )
          )}
          <Button
            title="Open on GitHub"
            variant="ghost"
            onPress={() => {
              const href = safeHref(file.url);

              if (href) void Linking.openURL(href);
            }}
          />
        </View>
      )}
    </View>
  );
}
