import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ArchivedThreadsPager, type ArchivedPageState } from "@canopy/domain/archived-threads";
import { collapsedArchivedThread, isArchivedSidebarThread } from "@canopy/domain/sidebar-threads";
import { useSession } from "../../state/session";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { styles, useColors } from "../../ui/theme";
import { Chevron, Expand } from "../../ui/MotionViews";
import { Button, Notice } from "../../ui/components";
import { ListSkeleton } from "../../ui/Skeleton";
import { SidebarThreadTree } from "./SidebarThreadTree";
import { SidebarThread } from "./SidebarThread";
import type { useSidebarThreads } from "./useSidebarThreads";

export function SidebarArchivedThreads({
  navigation,
  query,
}: {
  navigation: ReturnType<typeof useSidebarThreads>;
  query: string;
}) {
  const { client } = useSession();
  const { update } = useAppearance();
  const { threads, projects, workers } = useOverview();
  const { current, settings, projectName } = navigation;
  const c = useColors();

  const [page, setPage] = useState<ArchivedPageState>({
    threads: [],
    sideThreads: [],
    totalCount: undefined,
    nextPageToken: "",
    loaded: false,
    loading: false,
    error: "",
  });

  const pager = useMemo(
    () =>
      new ArchivedThreadsPager(async (request) => {
        if (!client) throw new Error("Gateway is not connected.");

        return client.api.listArchivedThreads(request);
      }, setPage),
    [client],
  );

  const projectsKey = settings.projectIds.join(",");

  const filter = useMemo(
    () => ({ projectIds: projectsKey ? projectsKey.split(",") : [], query }),
    [projectsKey, query],
  );

  const expanded = settings.archivedExpanded;
  const revision = useRef(0);

  useEffect(() => {
    void pager.refresh(filter, expanded, String(++revision.current));
  }, [pager, filter, expanded, threads]);
  useEffect(() => () => pager.dispose(), [pager]);

  const live = new Map(threads.map((t) => [t.id, t]));
  const roots = page.threads.map((t) => live.get(t.id) ?? t).filter(isArchivedSidebarThread);
  const sticky = collapsedArchivedThread(current, expanded, live, settings.projectIds, query, projectName);
  const toggle = () => void update({ sidebar: { ...settings, archivedExpanded: !expanded } });
  const retry = () => void pager.refresh(filter, expanded, `${Date.now()}`);

  if (page.totalCount === 0 && !sticky && !page.error) return null;

  return (
    <View style={{ flex: 1, justifyContent: "flex-end", paddingTop: 24 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Archived, ${page.totalCount ?? "loading"}`}
        accessibilityState={{ expanded }}
        onPress={toggle}
        style={[styles.row, { padding: 12, minHeight: 48 }]}
      >
        <Chevron open={expanded} size={14} />
        <Text style={[styles.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
          Archived · {page.totalCount ?? "–"}
        </Text>
      </Pressable>
      <Expand open={expanded}>
        {roots.map((thread) => (
          <SidebarThreadTree
            key={thread.id}
            thread={thread}
            archived
            current={current}
            projects={projects}
            workers={workers}
            sideThreads={page.sideThreads.map((t) => live.get(t.id) ?? t).filter((t) => t.parentThreadId === thread.id)}
          />
        ))}
        {!page.error && !page.loaded && <ListSkeleton rows={2} lines={3} />}
        {!page.error && page.loaded && !roots.length && (
          <Text style={[styles.meta, { color: c.muted, padding: 12 }]}>
            No archived threads{query ? ` matching “${query}”` : ""}.
          </Text>
        )}
        {page.nextPageToken && roots.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            title={page.loading ? "Loading…" : "Load more"}
            disabled={page.loading}
            onPress={() => void pager.more()}
          />
        )}
        {page.error && (
          <View style={{ padding: 12 }}>
            <Notice error>Could not load archived threads.</Notice>
            <Button variant="ghost" size="sm" title="Retry" onPress={retry} />
          </View>
        )}
      </Expand>
      {!expanded && sticky && (
        <SidebarThread
          thread={sticky}
          project={projects.find((p) => p.id === sticky.projectId)}
          worker={workers.find((w) => w.id === sticky.workerId)}
        />
      )}
    </View>
  );
}
