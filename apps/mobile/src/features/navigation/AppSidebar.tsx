import { useEffect, useState } from "react";
import { FlatList, Image, Pressable, Text, View } from "react-native";
import { ListSkeleton } from "../../ui/Skeleton";
import { Redirect, router } from "expo-router";
import { ScreenFrame, useContentPadding } from "../../ui/ScreenFrame";
import { SidebarFooter } from "./SidebarFooter";
import { ui, bots as botContract } from "@canopy/contracts";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { compareConversations } from "@canopy/domain/bot-chat";
import { useSession } from "../../state/session";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { Button, EmptyState, IconButton, Notice, Segmented } from "../../ui/components";
import { ConnectionBanner } from "./ConnectionStatus";
import { PickerSheet } from "../../ui/Picker";
import { ProjectMark } from "../../ui/ProjectMark";
import { styles, useColors } from "../../ui/theme";
import { Icon } from "../../ui/Icon";
import { SearchField } from "../../ui/SearchField";
import { SidebarThread } from "./SidebarThread";
import { BotListItem } from "../bots/BotListItem";
import { SettingsThreadList } from "./SettingsThreadList";

function useSidebarState() {
  const { session, client, ready, updateBots } = useSession();
  const { threads, projects, workers, loaded, stream } = useOverview();
  const [section, setSection] = useState<"threads" | "bots">("threads");
  const [queries, setQueries] = useState({ threads: "", bots: "" });
  const [archived, setArchived] = useState<ui.Thread[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [archiveLoaded, setArchiveLoaded] = useState(false);
  const [bots, setBots] = useState<botContract.Bot[]>([]);
  const [botError, setBotError] = useState("");
  const [botsLoaded, setBotsLoaded] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  // Bots load in both sections: the Bots tab shows their unread count while you read threads.
  useEffect(() => {
    if (!client) return;
    let active = true;

    const load = () =>
      void client.api
        .listBots({})
        .then((r) => {
          if (active) {
            setBots(r.bots);
            updateBots(r.bots);
            setBotError("");
            setBotsLoaded(true);
          }
        })
        .catch(() => {
          if (active) setBotError("Could not load bots.");
        });

    load();
    const timer = setInterval(load, 10_000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, updateBots]);
  useEffect(() => {
    if (!client || !archiveOpen) return;
    let active = true;
    void client.api
      .listArchivedThreads({})
      .then((r) => {
        if (active) {
          setArchived(r.threads);
          setArchiveError("");
          setArchiveLoaded(true);
        }
      })
      .catch(() => {
        if (active) setArchiveError("Could not load archived threads.");
      });

    return () => {
      active = false;
    };
  }, [client, archiveOpen]);

  const query = queries[section].trim().toLowerCase();

  const match = (t: ui.Thread) =>
    (!projectId || t.projectId === projectId) &&
    `${t.title} ${projects.find((p) => p.id === t.projectId)?.name ?? ""} ${t.cwd}`.toLowerCase().includes(query);

  const visible = threads
    .filter((t) => !t.archivedAt && !t.deletedAt && t.status !== "archived" && match(t))
    .sort((a, b) =>
      Number(
        (b.lastActivityAt?.seconds ?? b.createdAt?.seconds ?? 0n) -
          (a.lastActivityAt?.seconds ?? a.createdAt?.seconds ?? 0n),
      ),
    );

  return {
    session,
    ready,
    projects,
    workers,
    loaded,
    stream,
    section,
    setSection,
    queries,
    setQueries,
    archived,
    archiveOpen,
    setArchiveOpen,
    archiveError,
    archiveLoaded,
    bots,
    botError,
    botsLoaded,
    filterOpen,
    setFilterOpen,
    projectId,
    setProjectId,
    query,
    match,
    visible,
  };
}

function SidebarHeader({ state }: { state: ReturnType<typeof useSidebarState> }) {
  const c = useColors();
  const { section, setSection, queries, setQueries, setFilterOpen, projectId, projects, bots } = state;
  const unread = bots.reduce((sum, bot) => sum + (bot.archived ? 0 : bot.unreadCount), 0);
  // The project filter is named in words, not only by the tinted funnel.
  const filtered = section === "threads" ? projects.find((p) => p.id === projectId) : undefined;
  const searchLabel = filtered ? `Search ${filtered.name} threads` : `Search ${section}`;

  return (
    <>
      <View
        style={[
          styles.row,
          {
            height: 48,
            paddingLeft: 16,
            paddingRight: 8,
            justifyContent: "space-between",
          },
        ]}
      >
        <View style={styles.row}>
          <Image
            source={require("../../../../web/static/canopy-logo.png")}
            style={{ width: 24, height: 24, borderRadius: 6 }}
          />
          <Text style={[styles.label, { color: c.text }]}>Canopy</Text>
        </View>
        <IconButton icon="pencil-square" label="New thread" onPress={() => router.push("/new-thread")} />
      </View>
      <Segmented
        options={[
          { value: "threads", label: "Threads" },
          {
            value: "bots",
            label: "Bots",
            badge: unread,
          },
        ]}
        value={section}
        onChange={setSection}
        style={{ marginHorizontal: 12, marginBottom: 8 }}
      />
      <View style={[styles.row, { paddingHorizontal: 12, paddingBottom: 8 }]}>
        <SearchField
          bare
          label={searchLabel}
          value={queries[section]}
          onChange={(value) => setQueries({ ...queries, [section]: value })}
          style={{ flex: 1 }}
        />
        {section === "threads" && (
          <IconButton
            icon="funnel"
            label={projectId ? "Filter projects, filtered" : "Filter projects"}
            color={projectId ? c.accent : undefined}
            onPress={() => setFilterOpen(true)}
          />
        )}
      </View>
    </>
  );
}

/** Pinned bots first in pin order, then the latest conversation first, as on the web. */
function orderBots(list: readonly botContract.Bot[], pinned: readonly string[]): botContract.Bot[] {
  const key = (bot: botContract.Bot) => {
    const at = bot.lastMessage?.createdAt ?? bot.createdAt;

    return {
      pinIndex: pinned.indexOf(bot.id),
      activeAt: at ? timestampMs(at) : 0,
      name: bot.configuration?.name ?? "",
    };
  };

  return [...list].sort((a, b) => compareConversations(key(a), key(b)));
}

function SidebarLists({ state }: { state: ReturnType<typeof useSidebarState> }) {
  const c = useColors();
  const padding = useContentPadding(8);
  const pinned = useAppearance().user?.sidebar?.pinnedBotIds ?? [];

  const {
    section,
    visible,
    projects,
    workers,
    loaded,
    query,
    projectId,
    setProjectId,
    stream,
    archiveOpen,
    setArchiveOpen,
    archiveError,
    archiveLoaded,
    archived,
    match,
    bots,
    botError,
    botsLoaded,
  } = state;

  return (
    <>
      {section === "threads" ? (
        <SettingsThreadList
          threads={visible}
          projects={projects}
          workers={workers}
          empty={
            !loaded ? (
              <ListSkeleton lines={3} />
            ) : (
              <View style={{ alignItems: "flex-start", gap: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
                <Text style={[styles.meta, { color: c.muted }]}>
                  {projectId
                    ? "No threads in the selected projects."
                    : query
                      ? `No thread matches “${query}”.`
                      : stream.connection === "unavailable"
                        ? "Threads appear when the gateway connects."
                        : "No threads yet. Select New thread above to start one."}
                </Text>
                {projectId ? (
                  <Button size="sm" variant="ghost" title="Clear filters" onPress={() => setProjectId("")} />
                ) : null}
              </View>
            )
          }
          footer={
            <View style={{ flex: 1, justifyContent: "flex-end", paddingTop: 24 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Archived"
                accessibilityState={{ expanded: archiveOpen }}
                onPress={() => setArchiveOpen(!archiveOpen)}
                style={[styles.row, { padding: 12, minHeight: 44 }]}
              >
                <Icon name={archiveOpen ? "chevron-down" : "chevron-right"} size={14} />
                <Icon name="archive-box" />
                <Text style={[styles.meta, { color: c.muted }]}>Archived</Text>
              </Pressable>
              {archiveOpen && (
                <View>
                  {archiveError && <Notice error>{archiveError}</Notice>}
                  {archived.filter(match).map((t) => (
                    <SidebarThread
                      key={t.id}
                      thread={t}
                      project={projects.find((p) => p.id === t.projectId)}
                      worker={workers.find((w) => w.id === t.workerId)}
                    />
                  ))}
                  {!archiveError && !archiveLoaded && <ListSkeleton rows={2} lines={3} />}
                  {!archiveError && archiveLoaded && archived.length === 0 && (
                    <Text style={[styles.meta, { color: c.muted, padding: 12 }]}>No archived threads.</Text>
                  )}
                </View>
              )}
            </View>
          }
        />
      ) : (
        <FlatList
          data={orderBots(
            bots.filter(
              (b) => !b.archived && `${b.configuration?.name} ${b.lastMessage?.text}`.toLowerCase().includes(query),
            ),
            pinned,
          )}
          keyExtractor={(b) => b.id}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          contentContainerStyle={padding}
          renderItem={({ item }) => <BotListItem bot={item} />}
          ListEmptyComponent={
            !botsLoaded && !botError ? (
              <ListSkeleton avatar />
            ) : (
              <View style={{ padding: 8 }}>
                {botError ? (
                  <Notice error>{botError}</Notice>
                ) : (
                  <EmptyState
                    icon="chat-bubble-left-right"
                    title="No bots yet"
                    description="Create a bot in Canopy on the web."
                  />
                )}
              </View>
            )
          }
        />
      )}
    </>
  );
}

/** The thread and bot list: a full screen on phones, the persistent sidebar on wide windows. */
export function AppSidebar() {
  const c = useColors();
  const state = useSidebarState();
  const { ready, session, workers, stream, filterOpen, setFilterOpen, projects, projectId, setProjectId } = state;

  if (!ready) return <ListSkeleton />;

  if (!session) return <Redirect href="/pair" />;

  return (
    <ScreenFrame
      backgroundColor={c.sidebar}
      header={
        <>
          <SidebarHeader state={state} />
          <ConnectionBanner />
        </>
      }
      footer={<SidebarFooter workers={workers} stream={stream} />}
    >
      <SidebarLists state={state} />
      <PickerSheet
        title="Show threads from"
        visible={filterOpen}
        onClose={() => setFilterOpen(false)}
        search={projects.length > 6 ? "Search projects" : undefined}
        value={projectId}
        onSelect={setProjectId}
        sections={[
          { options: [{ value: "", label: "All projects", icon: "folder-open" as const }] },
          {
            options: projects
              .filter((p) => !p.archivedAt)
              .map((p) => ({ value: p.id, label: p.name, leading: <ProjectMark name={p.name} kind={p.kind} /> })),
          },
        ]}
      />
    </ScreenFrame>
  );
}
