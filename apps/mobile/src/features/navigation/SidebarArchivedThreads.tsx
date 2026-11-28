import { useEffect, useMemo, useRef, useState } from "react";
import type { ui } from "@canopy/contracts";
import { Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { ArchivedThreadsPager, indexChangesArchived } from "@canopy/domain/archived-threads";
import { collapsedArchivedThread, isArchivedSidebarThread } from "@canopy/domain/sidebar-threads";
import { useSession } from "../../state/session";
import { useDevicePreferences } from "../settings/device-preferences";
import { useOverview } from "../../state/overview";
import { styles, useColors } from "../../ui/theme";
import { Chevron } from "../../ui/MotionViews";
import { sidebarRowPadding, useSidebarTypography } from "./sidebar-scale";
import { SidebarThreadTreeRow } from "./SidebarThreadTree";
import type { SidebarListHeader } from "./SidebarListHeader";
import type { SidebarListEntry } from "./sidebar-drag";
import { Button, Notice } from "../../ui/components";
import { ListSkeleton } from "../../ui/Skeleton";
import type { useSidebarThreads } from "./useSidebarThreads";

export function useArchivedThreads(navigation: ReturnType<typeof useSidebarThreads>) {
  const { client, archivedCache, online, epoch } = useSession();
  const device = useDevicePreferences();
  const { threads, projects, workers, stream, linkedReads } = useOverview();
  const { current, settings, projectName, query } = navigation;
  const expanded = device.view.archivedThreadsExpanded;
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

  // Status and activity of active threads leave the archive as it is: only changes that reach it fetch pages again.
  const [archivedChanges, setArchivedChanges] = useState(0);
  const indexed = useRef<ReadonlyMap<string, ui.Thread>>(new Map());
  useEffect(() => {
    const before = indexed.current;
    indexed.current = new Map(threads.map((thread) => [thread.id, thread]));

    if (indexChangesArchived(before, threads)) setArchivedChanges((value) => value + 1);
  }, [threads]);

  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setRevision((value) => value + 1), 100);

    return () => clearTimeout(timer);
  }, [archivedChanges, epoch, linkedReads, stream.connection]);
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
  // Live updates reach the saved rows at once and the pager only after a refetch: the count follows the rows it
  // describes, so a row and its "Archived · N" change in the same frame.
  const total = saved?.totalCount ?? page.totalCount;

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
    total,
    expanded,
    roots,
    sideThreads,
    sticky,
    current,
    query,
    projects: rowProjects,
    workers: rowWorkers,
    visible: total !== 0 || !!sticky || !!page.error || roots.length > 0,
    stale: !!saved && (!online || stream.connection !== "live" || !!page.error || page.loading),
    toggle() {
      device.setView({ archivedThreadsExpanded: !expanded });
    },
    retry: () => void pager.refresh(filter, expanded, String(Date.now())),
    more: () => {
      if (expanded && online && !page.error) void pager.more();
    },
  };
}

type ArchivedThreads = ReturnType<typeof useArchivedThreads>;

export function archivedEntries(archive: ArchivedThreads): SidebarListEntry[] {
  if (!archive.expanded || !archive.visible) return [];

  return [
    { key: "archived-heading", section: "archived-heading" },
    ...archive.roots.map((thread) => ({ key: `archived-${thread.id}`, section: "archived" as const, thread })),
  ];
}

export function SidebarArchivedRow({ thread, archive }: { thread: ui.Thread; archive: ArchivedThreads }) {
  return (
    <SidebarThreadTreeRow
      thread={thread}
      archived
      current={archive.current}
      projects={archive.projects}
      workers={archive.workers}
      sideThreads={archive.sideThreads.get(thread.id) ?? []}
    />
  );
}

export function SidebarArchiveFooter({ archive, header }: { archive: ArchivedThreads; header: SidebarListHeader }) {
  if (!archive.visible) return null;

  if (archive.expanded) return <SidebarArchivedStatus archive={archive} />;

  return <SidebarCollapsedArchive archive={archive} header={header} />;
}

function SidebarCollapsedArchive({ archive, header }: { archive: ArchivedThreads; header: SidebarListHeader }) {
  const space = useSharedValue(0);
  const { brandHeight, offset } = header;

  // Short lists include an extra brand height so the toolbar can dock. Keep the archive above the footer
  // through that scroll, using only the spare space between it and the preceding threads.
  const position = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.min(space.get(), Math.max(0, brandHeight - offset.get())) }],
  }));

  return (
    <>
      <View style={styles.fill} onLayout={(event) => space.set(event.nativeEvent.layout.height)} />
      <Animated.View style={position}>
        <SidebarArchivedHeader archive={archive} />
        {archive.sticky && <SidebarArchivedRow thread={archive.sticky} archive={archive} />}
      </Animated.View>
    </>
  );
}

export function SidebarArchivedHeader({ archive }: { archive: ArchivedThreads }) {
  const c = useColors("sidebar-list");
  const type = useSidebarTypography();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Archived, ${archive.total ?? "loading"}`}
      accessibilityState={{ expanded: archive.expanded }}
      onPress={archive.toggle}
      style={({ pressed }) => [
        styles.row,
        {
          paddingHorizontal: sidebarRowPadding,
          minHeight: 44,
          marginTop: 8,
          borderRadius: 8,
          backgroundColor: pressed ? c.pressed : "transparent",
        },
      ]}
    >
      <Text style={[type.meta, { color: c.muted, flex: 1, fontWeight: "500", fontVariant: ["tabular-nums"] }]}>
        Archived · {archive.total ?? "–"}
      </Text>
      <Chevron open={archive.expanded} size={16} color={c.faint} />
    </Pressable>
  );
}

function SidebarArchivedStatus({ archive }: { archive: ArchivedThreads }) {
  const c = useColors("sidebar-list");
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
