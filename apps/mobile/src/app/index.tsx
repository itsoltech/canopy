import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, Text, TextInput, View } from "react-native";
import { Redirect, router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { ui, bots as botContract } from "@canopy/contracts";
import { useSession } from "../state/session";
import { useOverview } from "../state/overview";
import { Button, ConnectionNotice, IconButton, Notice, Segmented, Sheet } from "../ui/components";
import { styles, useColors } from "../ui/theme";
import { Icon } from "../ui/Icon";
import { SidebarThread } from "../features/navigation/SidebarThread";
import { BotListItem } from "../features/bots/BotListItem";

export default function AppSidebar() {
  const c = useColors();
  const { session, client, ready } = useSession();
  const { threads, projects, workers, loaded, stream } = useOverview();
  const [section, setSection] = useState<"threads" | "bots">("threads");
  const [queries, setQueries] = useState({ threads: "", bots: "" });
  const [archived, setArchived] = useState<ui.Thread[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [bots, setBots] = useState<botContract.Bot[]>([]);
  const [botError, setBotError] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  useEffect(() => {
    if (!client || section !== "bots") return;
    let active = true;

    const load = () =>
      void client.api
        .listBots({})
        .then((r) => {
          if (active) {
            setBots(r.bots);
            setBotError("");
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
  }, [client, section]);
  useEffect(() => {
    if (!client || !archiveOpen) return;
    let active = true;
    void client.api
      .listArchivedThreads({})
      .then((r) => {
        if (active) setArchived(r.threads);
      })
      .catch(() => {
        if (active) setArchiveError("Could not load archived threads.");
      });

    return () => {
      active = false;
    };
  }, [client, archiveOpen]);

  if (!ready) return <ActivityIndicator accessibilityLabel="Opening Canopy" />;

  if (!session) return <Redirect href="/pair" />;
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

  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: c.sidebar }]}>
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
            source={require("../../../web/static/canopy-logo.png")}
            style={{ width: 24, height: 24, borderRadius: 6 }}
          />
          <Text style={[styles.label, { color: c.text }]}>Canopy</Text>
        </View>
        <IconButton icon="pencil-square" label="New thread" onPress={() => router.push("/new-thread")} />
      </View>
      <Segmented
        options={[
          { value: "threads", label: "Threads" },
          { value: "bots", label: "Bots" },
        ]}
        value={section}
        onChange={setSection}
        style={{ marginHorizontal: 12, marginBottom: 8 }}
      />
      <View style={[styles.row, { paddingHorizontal: 12, paddingBottom: 8 }]}>
        <View style={[styles.row, { flex: 1, paddingHorizontal: 10, minHeight: 44 }]}>
          <Icon name="magnifying-glass" color={c.faint} />
          <TextInput
            accessibilityLabel={`Search ${section}`}
            placeholder={`Search ${section}`}
            placeholderTextColor={c.muted}
            value={queries[section]}
            onChangeText={(value) => setQueries({ ...queries, [section]: value })}
            style={[styles.body, { color: c.text, flex: 1, paddingVertical: 8 }]}
            returnKeyType="search"
          />
          {query && (
            <IconButton icon="x-mark" label="Clear search" onPress={() => setQueries({ ...queries, [section]: "" })} />
          )}
        </View>
        {section === "threads" && (
          <IconButton icon="funnel" label="Filter projects" onPress={() => setFilterOpen(true)} />
        )}
      </View>
      {stream.connection !== "live" && (
        <View style={{ padding: 12 }}>
          <ConnectionNotice {...stream} />
        </View>
      )}
      {section === "threads" ? (
        <FlatList
          data={visible}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{
            paddingHorizontal: 8,
            paddingBottom: 12,
            flexGrow: 1,
          }}
          ItemSeparatorComponent={() => <View style={{ height: 2 }} />}
          renderItem={({ item }) => (
            <SidebarThread
              thread={item}
              project={projects.find((p) => p.id === item.projectId)}
              worker={workers.find((w) => w.id === item.workerId)}
            />
          )}
          ListEmptyComponent={
            !loaded ? (
              <ActivityIndicator accessibilityLabel="Loading threads" />
            ) : (
              <Text style={[styles.meta, { color: c.muted, padding: 12 }]}>
                {query
                  ? `No thread matches “${query}”.`
                  : projectId
                    ? "No threads in the selected projects"
                    : "No threads yet. Start one with the pencil above."}
              </Text>
            )
          }
          ListFooterComponent={
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
                  {archiveError ? (
                    <Notice error>{archiveError}</Notice>
                  ) : (
                    archived
                      .filter(match)
                      .map((t) => (
                        <SidebarThread
                          key={t.id}
                          thread={t}
                          project={projects.find((p) => p.id === t.projectId)}
                          worker={workers.find((w) => w.id === t.workerId)}
                        />
                      ))
                  )}
                  {!archiveError && archived.length === 0 && (
                    <Text style={[styles.meta, { color: c.muted, padding: 12 }]}>No archived threads.</Text>
                  )}
                </View>
              )}
            </View>
          }
          ListFooterComponentStyle={{ flexGrow: 1 }}
        />
      ) : (
        <FlatList
          data={bots.filter(
            (b) => !b.archived && `${b.configuration?.name} ${b.lastMessage?.text}`.toLowerCase().includes(query),
          )}
          keyExtractor={(b) => b.id}
          contentContainerStyle={{ paddingHorizontal: 8 }}
          renderItem={({ item }) => <BotListItem bot={item} />}
          ListEmptyComponent={
            <Notice error={Boolean(botError)}>{botError || "No bots yet. Create a bot in Canopy on the web."}</Notice>
          }
        />
      )}
      <View style={[styles.row, { borderTopWidth: 1, borderTopColor: c.line, padding: 8 }]}>
        <IconButton icon="cog-6-tooth" label="Settings" onPress={() => router.push("/settings")} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Workers online"
          onPress={() =>
            router.push({
              pathname: "/settings",
              params: { section: "workers" },
            })
          }
          style={styles.row}
        >
          <Icon name="server" size={14} />
          <Text style={[styles.meta, { color: c.muted }]}>
            {workers.filter((w) => w.online).length}/{workers.length}
          </Text>
        </Pressable>
        <View style={[styles.row, { flex: 1, justifyContent: "flex-end", paddingRight: 8 }]}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: stream.connection === "live" ? c.success : c.warning,
            }}
          />
          <Text style={[styles.meta, { color: c.muted }]}>
            {stream.connection === "live" ? "Connected" : "Reconnecting"}
          </Text>
        </View>
      </View>
      <Sheet title="Projects" visible={filterOpen} onClose={() => setFilterOpen(false)}>
        {[{ id: "", name: "All projects" }, ...projects].map((p) => (
          <Button
            key={p.id}
            title={`${p.id === projectId ? "✓ " : ""}${p.name}`}
            secondary
            onPress={() => {
              setProjectId(p.id);
              setFilterOpen(false);
            }}
          />
        ))}
      </Sheet>
    </SafeAreaView>
  );
}
