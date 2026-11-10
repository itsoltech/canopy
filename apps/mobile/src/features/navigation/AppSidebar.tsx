import { useState } from "react";
import { Image, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { useMotion } from "../../ui/motion";
import { useArrivals } from "../../ui/MotionViews";
import { ListSkeleton } from "../../ui/Skeleton";
import { Redirect, router } from "expo-router";
import { ScreenFrame, useContentPadding } from "../../ui/ScreenFrame";
import { SidebarFooter } from "./SidebarFooter";
import { bots as botContract } from "@canopy/contracts";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { compareConversations } from "@canopy/domain/bot-chat";
import { useSession } from "../../state/session";
import { useBotList } from "../../state/bot-list";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { Button, EmptyState, IconButton, Notice, Segmented } from "../../ui/components";
import { ConnectionBanner } from "./ConnectionStatus";
import { PickerSheet } from "../../ui/Picker";
import { ProjectMark } from "../../ui/ProjectMark";
import { styles, useColors } from "../../ui/theme";
import { SearchField } from "../../ui/SearchField";
import { BotListItem } from "../bots/BotListItem";
import { SettingsThreadList } from "./SettingsThreadList";
import { useSidebarThreads } from "./useSidebarThreads";
import { useProjectDetails } from "../computers/project-details";
import { CreateBot } from "../bots/CreateBot";
import { useDevicePreferences } from "../settings/device-preferences";

function useSidebarState() {
  const { session, ready, bots } = useSession();
  const { projects, workers, loaded, stream } = useOverview();
  const [section, setSection] = useState<"threads" | "bots">("threads");
  const [queries, setQueries] = useState({ threads: "", bots: "" });
  const [filterOpen, setFilterOpen] = useState(false);
  const navigation = useSidebarThreads(queries.threads);
  const selectedProjectId = navigation.settings.projectIds[0];

  const projectId =
    navigation.choices.find((p) => p.projectIds.includes(selectedProjectId ?? ""))?.id ?? selectedProjectId ?? "";

  const { setProjectId } = navigation;
  // Bots load in both sections: the Bots tab shows their unread count while you read threads.
  const botList = useBotList();
  const botError = botList.error ? "Could not load bots." : "";
  const botsLoaded = botList.loaded;
  const query = queries[section].trim().toLowerCase();

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
    bots,
    botError,
    botsLoaded,
    filterOpen,
    setFilterOpen,
    projectId,
    setProjectId,
    query,
    navigation,
  };
}

function SidebarHeader({ state }: { state: ReturnType<typeof useSidebarState> }) {
  const c = useColors();
  const [creating, setCreating] = useState(false);
  const { section, setSection, queries, setQueries, setFilterOpen, projectId, navigation, bots } = state;
  const unread = bots.reduce((sum, bot) => sum + (bot.archived ? 0 : bot.unreadCount), 0);
  // The project filter is named in words, not only by the tinted funnel.
  const filtered = section === "threads" ? navigation.choices.find((p) => p.id === projectId) : undefined;
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
        <IconButton
          icon="pencil-square"
          label={section === "bots" ? "Create bot" : "New thread"}
          onPress={() => (section === "bots" ? setCreating(true) : router.push("/new-thread"))}
        />
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
      {creating && <CreateBot onClose={() => setCreating(false)} />}
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

  const { section, navigation, projects, workers, loaded, query, projectId, setProjectId, stream } = state;

  const { rise } = useMotion();

  // Threads and Bots cross-fade as the segmented pill slides.
  return (
    <Animated.View key={section} entering={rise.entering} style={styles.fill}>
      {section === "threads" ? (
        <SettingsThreadList
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
                {!projectId &&
                  !query &&
                  workers.some((worker) => !worker.nodeId && worker.online && worker.cliImport) && (
                    <Button
                      size="sm"
                      title="Import CLI threads"
                      onPress={() =>
                        router.push({
                          pathname: "/settings/[section]",
                          params: {
                            section: "import",
                            worker:
                              workers.find((worker) => !worker.nodeId && worker.online && worker.cliImport)?.id ?? "",
                          },
                        })
                      }
                    />
                  )}
              </View>
            )
          }
        />
      ) : (
        <BotList state={state} />
      )}
    </Animated.View>
  );
}

/** Bot chats, pinned first then the latest conversation; one that gets a message moves up and the rest glide. */
function BotList({ state }: { state: ReturnType<typeof useSidebarState> }) {
  const padding = useContentPadding(8);
  const pinned = useAppearance().user?.sidebar?.pinnedBotIds ?? [];
  const { layout } = useMotion();
  const { query, bots, botError, botsLoaded } = state;
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
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      contentContainerStyle={padding}
      renderItem={({ item }) => (
        <Animated.View entering={botArrival(item.id)}>
          <BotListItem bot={item} />
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
            {archivedOpen && archived.map((bot) => <BotListItem key={bot.id} bot={bot} />)}
          </View>
        ) : undefined
      }
    />
  );
}

/** The thread and bot list: a full screen on phones, the persistent sidebar on wide windows. */
export function AppSidebar() {
  const c = useColors();
  const state = useSidebarState();
  const { ready, session, workers, stream, filterOpen, setFilterOpen, navigation, projectId, setProjectId } = state;
  const projects = navigation.choices;
  const details = useProjectDetails();

  if (!ready) return <ListSkeleton />;

  if (!session) return <Redirect href="/pair" />;

  return (
    <ScreenFrame
      backgroundColor={c.sidebar}
      header={
        <>
          <SidebarHeader state={state} />
          <ConnectionBanner overlay />
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
              .map((p) => ({
                value: p.id,
                label: p.name,
                leading: <ProjectMark name={p.name} kind={p.kind} />,
                badge: navigation.projectAway(p) ? "Offline" : undefined,
                description: [navigation.projectAway(p), details.detail(p)].filter(Boolean).join(" · "),
                keywords: p.aliases.join(" "),
                muted: Boolean(navigation.projectAway(p)),
              })),
          },
        ]}
      />
    </ScreenFrame>
  );
}
