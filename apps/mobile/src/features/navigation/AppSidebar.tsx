import { useMemo, useRef, useState } from "react";
import { Keyboard, Platform, Text, View, type TextInputInstance } from "react-native";
import Animated from "react-native-reanimated";
import { useMotion } from "../../ui/motion";
import { useArrivals } from "../../ui/MotionViews";
import { ListSkeleton } from "../../ui/Skeleton";
import { Redirect, router } from "expo-router";
import { ScreenFrame, useContentInsets } from "../../ui/ScreenFrame";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarCopyJobs } from "../copy-jobs/SidebarCopyJobs";
import { bots as botContract } from "@canopy/contracts";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { compareConversations } from "@canopy/domain/bot-chat";
import { needsYou, workingTreeCount } from "@canopy/domain/thread-activity";
import { isThreadSnoozed } from "@canopy/domain/thread-snooze";
import { useLayout } from "../../state/layout";
import { useSession } from "../../state/session";
import { useBotList } from "../../state/bot-list";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { Button, EmptyState, IconButton, Notice, Segmented } from "../../ui/components";
import { useSidebarListHeader, type SidebarListHeader } from "./SidebarListHeader";
import { styles, useColors } from "../../ui/theme";
import { SearchField } from "../../ui/SearchField";
import { BotListItem } from "../bots/BotListItem";
import { SettingsThreadList } from "./SettingsThreadList";
import { useSidebarThreads } from "./useSidebarThreads";
import { SidebarProjectFilter, SidebarSort } from "./SidebarThreadPickers";
import { CreateBot } from "../bots/CreateBot";
import { useOpenSettingsSection } from "../settings/navigation";
import { useDevicePreferences } from "../settings/device-preferences";
import { AddProjectSheet } from "../settings/AddProject";

function useSidebarState() {
  const { session, ready, bots: cachedBots } = useSession();
  const { projects, threads, workers, loaded, stream } = useOverview();
  const { selectedModule: section, selectModule: setSection } = useLayout();
  const { modules } = useAppearance();
  const [queries, setQueries] = useState({ threads: "", bots: "" });
  const [threadPicker, setThreadPicker] = useState<"sort" | "filter" | null>(null);
  const navigation = useSidebarThreads(queries.threads);
  const selectedProjectId = navigation.settings.projectIds[0];

  const projectId =
    navigation.choices.find((p) => p.projectIds.includes(selectedProjectId ?? ""))?.id ?? selectedProjectId ?? "";

  const { setProjectId } = navigation;
  // Bots load in both sections: the Bots tab shows their unread count while you read threads.
  const botList = useBotList();
  const botError = botList.error ? "Could not load bots." : "";
  const botsLoaded = botList.loaded;
  const botActivityLive = stream.connection === "live" && botsLoaded && !botList.stale && !botList.error;
  const query = queries[section].trim().toLowerCase();
  const botSummaries = botList.data?.bots;

  const activity = useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const lookup = (id: string) => byId.get(id);
    const liveBots = (botSummaries ?? []).filter((bot) => !bot.archived);

    return {
      working: {
        threads: workingTreeCount(threads, lookup, (thread) => isThreadSnoozed(thread, lookup)),
        bots: stream.connection === "live" ? liveBots.filter((bot) => bot.executing).length : 0,
      },
      attention: {
        threads: threads.some((thread) => needsYou(thread) && !isThreadSnoozed(thread, lookup)),
        bots: liveBots.some((bot) => {
          const request = bot.pendingApproval;

          if (!request) return false;
          const thread = lookup(request.threadId);

          return !thread || !isThreadSnoozed(thread, lookup);
        }),
      },
    };
  }, [threads, botSummaries, stream.connection]);

  return {
    session,
    modules,
    ready,
    projects,
    workers,
    loaded,
    stream,
    section,
    setSection,
    queries,
    setQueries,
    bots: botSummaries ?? cachedBots,
    botError,
    botsLoaded,
    botActivityLive,
    activity,
    threadPicker,
    setThreadPicker,
    projectId,
    setProjectId,
    query,
    navigation,
  };
}

function SidebarControls({
  state,
  beforeSwitch,
  focusSearch,
}: {
  state: ReturnType<typeof useSidebarState>;
  beforeSwitch: (searchFocused: boolean) => void;
  focusSearch: boolean;
}) {
  const c = useColors("sidebar-header");
  const { wide } = useLayout();
  const search = useRef<TextInputInstance>(null);
  const [creating, setCreating] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const { section, setSection, queries, setQueries, setThreadPicker, projectId, navigation, bots, activity } = state;
  const unread = bots.reduce((sum, bot) => sum + (bot.archived ? 0 : bot.unreadCount), 0);
  const filtered = section === "threads" ? navigation.choices.find((p) => p.id === projectId) : undefined;
  const searchLabel = filtered ? `Search ${filtered.name} threads` : `Search ${section}`;
  const actionSize = wide ? "sm" : "md";

  const filterLabel = projectId
    ? `Filter by project, ${filtered ? `${filtered.name} selected` : "active"}`
    : "Filter by project";

  return (
    <>
      {state.modules.length > 1 && (
        <Segmented
          options={state.modules.map((value) => ({
            value,
            label: value === "threads" ? "Threads" : "Bots",
            badge: value === "bots" ? unread : 0,
            working: activity.working[value],
            attention: activity.attention[value],
          }))}
          value={section}
          onChange={(next) => {
            if (next === section) return;
            // Android keeps input focus after Back dismisses the keyboard.
            beforeSwitch(!!search.current?.isFocused() && (Platform.OS !== "android" || Keyboard.isVisible()));
            setSection(next);
          }}
          inactiveColor={c.muted}
          style={{ marginHorizontal: 12, marginBottom: 8 }}
        />
      )}
      {creating && section === "bots" && <CreateBot onClose={() => setCreating(false)} />}
      {addingProject && <AddProjectSheet visible onClose={() => setAddingProject(false)} />}
      <View style={[styles.row, { gap: 0, paddingHorizontal: 8 }]}>
        <SearchField
          bare
          compact={wide}
          ref={search}
          autoFocus={focusSearch}
          label={searchLabel}
          mutedColor={c.muted}
          placeholder={`Search ${section}`}
          value={queries[section]}
          onChange={(value) => setQueries({ ...queries, [section]: value })}
          style={{ flex: 1 }}
        />
        {section === "bots" ? (
          <View style={{ maxWidth: "55%" }}>
            <Button
              title="Create bot"
              icon="plus"
              variant="ghost"
              size={actionSize}
              multiline
              style={{ paddingVertical: 4 }}
              onPress={() => setCreating(true)}
            />
          </View>
        ) : (
          <>
            <IconButton
              icon="sort-descending"
              label="Sort threads"
              size={actionSize}
              onPress={() => setThreadPicker("sort")}
            />
            <IconButton
              icon="funnel"
              label={filterLabel}
              size={actionSize}
              variant={projectId ? "secondary" : "ghost"}
              color={projectId ? c.accent : undefined}
              onPress={() => setThreadPicker("filter")}
            />
            <IconButton
              icon="folder-plus"
              label="Add project"
              size={actionSize}
              onPress={() => setAddingProject(true)}
            />
            <IconButton
              icon="pencil-square"
              label="New thread"
              size={actionSize}
              onPress={() => router.push("/new-thread")}
            />
          </>
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

function SidebarLists({ state, header }: { state: ReturnType<typeof useSidebarState>; header: SidebarListHeader }) {
  const openSettingsSection = useOpenSettingsSection();
  const c = useColors("sidebar-list");

  const { section, navigation, projects, workers, loaded, query, projectId, setProjectId, stream } = state;

  // Both lists include the sticky header, so transition only individual rows as they arrive.
  if (section === "bots") return <BotList state={state} header={header} />;

  return (
    <SettingsThreadList
      header={header}
      navigation={navigation}
      loaded={loaded}
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
            {!projectId && !query && workers.some((worker) => !worker.nodeId && worker.online && worker.cliImport) && (
              <Button
                size="sm"
                title="Import CLI threads"
                onPress={() =>
                  openSettingsSection("import", {
                    worker: workers.find((worker) => !worker.nodeId && worker.online && worker.cliImport)?.id ?? "",
                  })
                }
              />
            )}
          </View>
        )
      }
    />
  );
}

/** Bot chats, pinned first then the latest conversation; one that gets a message moves up and the rest glide. */
function BotList({ state, header }: { state: ReturnType<typeof useSidebarState>; header: SidebarListHeader }) {
  const pinned = useAppearance().user?.sidebar?.pinnedBotIds ?? [];
  const { layout } = useMotion();
  const { query, bots, botError, botsLoaded, botActivityLive } = state;
  const device = useDevicePreferences();
  const archivedOpen = device.view.archivedBotsExpanded;

  const archived = orderBots(
    bots.filter(
      (bot) => bot.archived && `${bot.configuration?.name} ${bot.lastMessage?.text}`.toLowerCase().includes(query),
    ),
    [],
  );

  const shownBots = orderBots(
    bots.filter((b) => !b.archived && `${b.configuration?.name} ${b.lastMessage?.text}`.toLowerCase().includes(query)),
    pinned,
  );

  const botArrival = useArrivals(
    shownBots.map((b) => b.id),
    botsLoaded,
  );

  return (
    <Animated.FlatList
      data={shownBots}
      keyExtractor={(b) => b.id}
      // A chat that gets a message moves up and the rest glide; a new bot rises in.
      itemLayoutAnimation={layout}
      {...header.listProps}
      renderItem={({ item }) => (
        <Animated.View entering={botArrival(item.id)}>
          <BotListItem bot={item} activityLive={botActivityLive} />
        </Animated.View>
      )}
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
                description="Select Create bot above to start a conversation."
              />
            )}
          </View>
        )
      }
      ListFooterComponent={
        archived.length ? (
          <View style={{ gap: 8 }}>
            <Button
              variant="ghost"
              title={`${archivedOpen ? "Hide" : "Show"} archived bots · ${archived.length}`}
              onPress={() => device.setView({ archivedBotsExpanded: !archivedOpen })}
            />
            {archivedOpen &&
              archived.map((bot) => <BotListItem key={bot.id} bot={bot} activityLive={botActivityLive} />)}
          </View>
        ) : undefined
      }
    />
  );
}

function SidebarContent({ state }: { state: ReturnType<typeof useSidebarState> }) {
  const insets = useContentInsets();

  const header = useSidebarListHeader((beforeSwitch, focusSearch) => (
    <SidebarControls state={state} beforeSwitch={beforeSwitch} focusSearch={focusSearch} />
  ));

  return (
    <>
      {header.backdrop}
      <View
        style={{
          flex: 1,
          marginTop: insets.top,
          paddingLeft: insets.left,
          paddingRight: insets.right,
          overflow: "hidden",
        }}
      >
        {/* Only the docking space is clipped. The brand stays inside its native cell for hit testing and accessibility. */}
        <View style={{ flex: 1, marginTop: -header.brandHeight }}>
          <SidebarLists state={state} header={header} />
        </View>
      </View>
    </>
  );
}

/** The thread and bot list: a full screen on phones, the persistent sidebar on wide windows. */
export function AppSidebar() {
  const c = useColors();
  const state = useSidebarState();
  const { ready, session, workers, stream, threadPicker, setThreadPicker, navigation, projectId } = state;

  if (!ready) return <ListSkeleton />;

  if (!session) return <Redirect href="/pair" />;

  return (
    <ScreenFrame
      backgroundColor={c.sidebar}
      footer={
        <>
          {state.modules.includes("threads") && <SidebarCopyJobs />}
          <SidebarFooter workers={workers} stream={stream} />
        </>
      }
    >
      <SidebarContent state={state} />
      {state.section === "threads" && (
        <>
          <SidebarSort visible={threadPicker === "sort"} onClose={() => setThreadPicker(null)} />
          <SidebarProjectFilter
            navigation={navigation}
            projectId={projectId}
            visible={threadPicker === "filter"}
            onClose={() => setThreadPicker(null)}
          />
        </>
      )}
    </ScreenFrame>
  );
}
