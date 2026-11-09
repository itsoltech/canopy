import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ArchivedThreadsPager } from "@canopy/domain/archived-threads";
import { collapsedArchivedThread, isArchivedSidebarThread } from "@canopy/domain/sidebar-threads";
import { useSession } from "../../state/session";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { styles, useColors } from "../../ui/theme";
import { Chevron } from "../../ui/MotionViews";
import { Button, Notice } from "../../ui/components";
import { ListSkeleton } from "../../ui/Skeleton";
import type { useSidebarThreads } from "./useSidebarThreads";

export function useArchivedThreads(navigation: ReturnType<typeof useSidebarThreads>) {
  const { client, archivedCache, online, epoch } = useSession();
  const { update } = useAppearance();
  const { threads, projects, workers, stream, linkedReads } = useOverview();
  const { current, settings, projectName, query } = navigation;
  const [localOpen, setLocalOpen] = useState<boolean>();
  const expanded = localOpen ?? settings.archivedExpanded;
  const projectsKey = settings.projectIds.join(",");

  const filter = useMemo(
    () => ({ projectIds: projectsKey ? projectsKey.split(",") : [], query }),
    [projectsKey, query],
  );

  const [, render] = useState(0);

  const pager = useMemo(
    () =>
      new ArchivedThreadsPager(
        async (request) => {
          if (!client || !online) throw new Error("Gateway is not connected.");

          const page = await client.api.listArchivedThreads(request);

          return archivedCache?.withSavedPeers(request, page) ?? page;
        },
        () => render((revision) => revision + 1),
        (filter) => archivedCache?.peek(filter),
        (filter, state) => {
          void archivedCache?.remember(filter, state)?.catch(() => {});
        },
        () => archivedCache?.revision ?? 0,
      ),
    [client, archivedCache, online, filter],
  );

  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setRevision((value) => value + 1), 100);

    return () => clearTimeout(timer);
  }, [threads, epoch, linkedReads, stream.connection]);
  useEffect(() => {
    void pager.refresh(filter, expanded, String(revision));
  }, [pager, filter, expanded, revision]);
  useEffect(() => () => pager.dispose(), [pager]);
  const page = pager.state;

  useEffect(() => {
    if (expanded || !online || !page.totalCount) return;
    const timer = setTimeout(() => pager.prefetch(), 500);

    return () => clearTimeout(timer);
  }, [pager, expanded, online, page.totalCount, revision]);

  const saved = archivedCache?.peek(filter);
  const live = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const rows = saved ?? page;

  const roots = useMemo(() => rows.threads.filter(isArchivedSidebarThread), [rows.threads]);

  const sideThreads = useMemo(() => {
    const grouped = new Map<string, typeof threads>();

    for (const thread of rows.sideThreads) {
      const group = grouped.get(thread.parentThreadId) ?? [];
      group.push(thread);
      grouped.set(thread.parentThreadId, group);
    }

    return grouped;
  }, [rows.sideThreads]);

  const sticky = collapsedArchivedThread(current, expanded, live, settings.projectIds, query, projectName);
  const metadata = archivedCache?.metadata;

  const rowProjects = useMemo(
    () => [...new Map([...(metadata?.projects ?? []), ...projects].map((row) => [row.id, row])).values()],
    [metadata, projects],
  );

  const rowWorkers = useMemo(
    () => [...new Map([...(metadata?.workers ?? []), ...workers].map((row) => [row.id, row])).values()],
    [metadata, workers],
  );

  return {
    page,
    expanded,
    roots,
    sideThreads,
    sticky,
    current,
    query,
    projects: rowProjects,
    workers: rowWorkers,
    visible: page.totalCount !== 0 || !!sticky || !!page.error || roots.length > 0,
    stale: !!saved && (!online || stream.connection !== "live" || !!page.error || page.loading),
    toggle() {
      setLocalOpen(!expanded);
      void update({ sidebar: { ...settings, archivedExpanded: !expanded } });
    },
    retry: () => void pager.refresh(filter, expanded, String(Date.now())),
    more: () => {
      if (expanded && online && !page.error) void pager.more();
    },
  };
}

export type ArchivedThreads = ReturnType<typeof useArchivedThreads>;

export function SidebarArchivedHeader({ archive }: { archive: ArchivedThreads }) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Archived, ${archive.page.totalCount ?? "loading"}`}
      accessibilityState={{ expanded: archive.expanded }}
      onPress={archive.toggle}
      style={[styles.row, { padding: 12, minHeight: 48, marginTop: 24 }]}
    >
      <Chevron open={archive.expanded} size={14} />
      <Text style={[styles.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
        Archived · {archive.page.totalCount ?? "–"}
      </Text>
    </Pressable>
  );
}

export function SidebarArchivedStatus({ archive }: { archive: ArchivedThreads }) {
  const c = useColors();
  const { page, roots, stale, query } = archive;

  return (
    <View>
      {!page.error && !page.loaded && !roots.length && <ListSkeleton rows={2} lines={3} />}
      {!page.error && page.loaded && !roots.length && (
        <Text style={[styles.meta, { color: c.muted, padding: 12 }]}>
          No archived threads{query ? ` matching “${query}”` : ""}.
        </Text>
      )}
      {!!page.nextPageToken && !!roots.length && (
        <Button
          variant="ghost"
          size="sm"
          title={page.loading ? "Loading…" : "Load more"}
          disabled={page.loading}
          onPress={archive.more}
        />
      )}
      {(stale || page.error) && (
        <View style={{ padding: 12 }}>
          {stale ? (
            <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: c.muted }]}>
              Showing saved threads
            </Text>
          ) : (
            <Notice error>Could not load archived threads.</Notice>
          )}
          {page.error && <Button variant="ghost" size="sm" title="Retry" onPress={archive.retry} />}
        </View>
      )}
    </View>
  );
}
