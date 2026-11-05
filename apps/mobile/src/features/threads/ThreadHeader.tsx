import { useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Field, IconButton, Notice, Sheet } from "../../ui/components";
import { Overlay } from "../../ui/Overlay";
import { PickerSheet } from "../../ui/Picker";
import { ProjectMark } from "../../ui/ProjectMark";
import { styles, useColors } from "../../ui/theme";

function useThreadActions(thread: ui.Thread | undefined) {
  const { client } = useSession();
  const [sheet, setSheet] = useState<"actions" | "rename" | "search" | null>(null);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function action(kind: "title" | "archive" | "unread") {
    if (!client || !thread) return;
    setBusy(true);
    setError("");

    try {
      if (kind === "title")
        await client.api.updateThread({
          threadId: thread.id,
          title: title.trim(),
        });

      if (kind === "archive") {
        await client.api.setThreadArchived({
          threadId: thread.id,
          archived: !thread.archivedAt,
        });
        router.replace("/");
      }

      if (kind === "unread") await client.api.setThreadRead({ threadId: thread.id, unread: true });
      setSheet(null);
      setError("");
    } catch {
      setError("Could not update the thread. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return { sheet, setSheet, title, setTitle, query, setQuery, error, busy, action };
}

export function ThreadHeader({
  thread,
  project,
  turns,
  onDetails,
}: {
  thread?: ui.Thread;
  project?: ui.Project;
  turns: ui.Turn[];
  onDetails: () => void;
}) {
  const c = useColors();
  const { sheet, setSheet, title, setTitle, query, setQuery, error, busy, action } = useThreadActions(thread);

  return (
    <>
      <View
        style={[
          styles.row,
          {
            height: 48,
            paddingHorizontal: 4,
            gap: 0,
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          },
        ]}
      >
        <IconButton
          icon="bars-3"
          label="Threads"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
        {project && <ProjectMark name={project.name} kind={project.kind} />}
        <Text numberOfLines={1} style={[styles.body, { color: c.muted, maxWidth: 70, paddingLeft: 8 }]}>
          {project?.name || "Thread"}
        </Text>
        <Text style={[styles.body, { color: c.faint, paddingHorizontal: 8 }]}>/</Text>
        <Text numberOfLines={1} style={[styles.body, { color: c.text, flex: 1 }]}>
          {thread?.title || "Thread"}
        </Text>
        <IconButton icon="magnifying-glass" label="Search thread" onPress={() => setSheet("search")} />
        <IconButton
          icon="ellipsis-horizontal"
          label="Thread actions"
          onPress={() => {
            setTitle(thread?.title ?? "");
            setSheet("actions");
          }}
        />
        <IconButton icon="view-columns" label="Thread details" onPress={onDetails} />
      </View>
      <PickerSheet
        title="Thread actions"
        visible={sheet === "actions"}
        onClose={() => setSheet(null)}
        onSelect={(kind) => (kind === "rename" ? setSheet("rename") : void action(kind))}
        sections={[
          {
            options: [
              { value: "rename" as const, label: "Rename", icon: "pencil-square" as const },
              { value: "unread" as const, label: "Mark as unread", icon: "chat-bubble-left" as const },
              {
                value: "archive" as const,
                label: thread?.archivedAt ? "Unarchive" : "Archive",
                icon: "archive-box" as const,
              },
            ],
          },
        ]}
      />
      <Overlay visible={sheet === "rename"} onClose={() => setSheet(null)} label="Rename thread">
        <View style={{ padding: 16, gap: 12 }}>
          <Field label="Title" value={title} onChangeText={setTitle} autoFocus />
          <Button title="Rename" disabled={!title.trim()} busy={busy} onPress={() => void action("title")} />
        </View>
      </Overlay>
      <Sheet visible={sheet === "search"} title="Search thread" onClose={() => setSheet(null)}>
        <Field label="Search messages" value={query} onChangeText={setQuery} placeholder="Search" />
        {query.trim() &&
          turns
            .filter((t) => `${t.messageText} ${t.inputText}`.toLowerCase().includes(query.toLowerCase()))
            .map((t) => (
              <Text key={t.id} style={[styles.body, { color: c.body }]}>
                {t.messageText || t.inputText}
              </Text>
            ))}
      </Sheet>
      {error && sheet === null ? (
        <View style={{ padding: 8 }}>
          <Notice error>{error}</Notice>
        </View>
      ) : null}
    </>
  );
}
