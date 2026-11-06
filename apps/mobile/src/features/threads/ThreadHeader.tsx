import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { useAppearance } from "../../state/appearance";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Field, IconButton, Notice, Sheet } from "../../ui/components";
import { Overlay } from "../../ui/Overlay";
import { PickerSheet } from "../../ui/Picker";
import { useLayout } from "../../state/layout";
import { SidebarToggle } from "../navigation/SidebarToggle";
import { ProjectMark } from "../../ui/ProjectMark";
import { styles, useColors } from "../../ui/theme";
import { Skeleton } from "../../ui/Skeleton";

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
  onSideThread,
  onGoal,
  goalOpen,
  readOnly = false,
}: {
  thread?: ui.Thread;
  project?: ui.Project;
  turns: ui.Turn[];
  onDetails: () => void;
  onSideThread: () => void;
  /** Absent where the thread takes no goals (a gateway thread, Grok). */
  onGoal?: () => void;
  goalOpen: boolean;
  readOnly?: boolean;
}) {
  const c = useColors();
  const { wide } = useLayout();
  const { user } = useAppearance();
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
        {wide ? (
          <SidebarToggle />
        ) : (
          <IconButton
            icon="bars-3"
            label="Threads"
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          />
        )}
        {project && <ProjectMark name={project.name} kind={project.kind} />}
        {project ? (
          <Text numberOfLines={1} style={[styles.body, { color: c.muted, maxWidth: 110, paddingLeft: 8 }]}>
            {project.name}
          </Text>
        ) : (
          <Skeleton style={{ width: 70, height: 16 }} />
        )}
        <Text style={[styles.body, { color: c.faint, paddingHorizontal: 8 }]}>/</Text>
        <View style={{ flex: 1 }}>
          {thread ? (
            <Text numberOfLines={1} style={[styles.body, { color: c.text }]}>
              {thread.title}
            </Text>
          ) : (
            <Skeleton style={{ width: "80%", height: 16 }} />
          )}
        </View>
        <IconButton icon="magnifying-glass" label="Search thread" onPress={() => setSheet("search")} />
        <IconButton
          icon="ellipsis-horizontal"
          label="Thread actions"
          disabled={readOnly}
          onPress={() => {
            setTitle(thread?.title ?? "");
            setSheet("actions");
          }}
        />
        <IconButton icon="view-columns" label="Thread details" onPress={onDetails} />
      </View>
      <ThreadActionsSheet
        thread={thread}
        visible={!readOnly && sheet === "actions"}
        onClose={() => setSheet(null)}
        goalOpen={goalOpen}
        goals={Boolean(onGoal)}
        onSelect={(kind) => {
          if (kind === "rename") setSheet("rename");
          else if (kind === "side") onSideThread();
          else if (kind === "goal") onGoal?.();
          else if (kind === "archive" && !thread?.archivedAt && user?.general?.confirmArchive)
            Alert.alert("Archive thread?", "This also archives its side threads.", [
              { text: "Cancel", style: "cancel" },
              { text: "Archive", onPress: () => void action(kind) },
            ]);
          else void action(kind);
        }}
      />
      <Overlay visible={!readOnly && sheet === "rename"} onClose={() => setSheet(null)} label="Rename thread">
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

type ThreadAction = "side" | "goal" | "rename" | "unread" | "archive";

function ThreadActionsSheet({
  thread,
  visible,
  onClose,
  onSelect,
  goals,
  goalOpen,
}: {
  thread: ui.Thread | undefined;
  visible: boolean;
  onClose: () => void;
  onSelect: (action: ThreadAction) => void;
  goals: boolean;
  goalOpen: boolean;
}) {
  return (
    <PickerSheet
      title="Thread actions"
      visible={visible}
      onClose={onClose}
      onSelect={onSelect}
      sections={[
        {
          options: [
            { value: "side" as const, label: "New side thread", icon: "arrows-right-left" as const },
            ...(goals
              ? [
                  {
                    value: "goal" as const,
                    label: goalOpen ? "Replace the goal…" : "Set a goal…",
                    icon: "flag" as const,
                  },
                ]
              : []),
          ],
        },
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
  );
}
