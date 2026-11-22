import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { noteScopeLabel } from "@canopy/domain/memory-scopes";
import { Code, ConnectError } from "@connectrpc/connect";
import { useSession } from "../../state/session";
import { Button, Notice, Sheet } from "../../ui/components";
import { ScreenScroll } from "../../ui/ScreenScroll";
import { useColors, useTypography } from "../../ui/theme";
import { useDateTime } from "./display";
import { confirmAction, type SettingsApi } from "./resource";
import { MemoryNoteFields, mergeNoteDraft, noteChanged, type NoteDraft } from "./MemoryNoteFields";
import { SettingsValue } from "./SettingsValue";

async function findSavedNote(api: SettingsApi, note: ui.MemoryNote, signal: AbortSignal) {
  let cursor = "";

  do {
    const page = await api.listMemoryNotes({ scope: note.scope, limit: 100, cursor }, { signal });
    const saved = page.notes.find((row) => row.id === note.id);

    if (saved) return saved;
    cursor = page.nextCursor;
  } while (cursor && !signal.aborted);

  throw new ConnectError("Note unavailable", Code.NotFound);
}

interface SheetProps {
  note: ui.MemoryNote;
  onChanged: () => void;
  onClose: () => void;
}

function useNoteEditor({ note, onChanged, onClose }: SheetProps) {
  const { client } = useSession();
  const [saved, setSaved] = useState(note);
  const [draft, setDraft] = useState<NoteDraft>(note);
  const [conflict, setConflict] = useState(false);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"save" | "delete" | "review">();
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  async function run(action: "save" | "delete" | "review") {
    if (!client || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    const { signal } = controller;
    setBusy(action);
    setError("");

    try {
      if (action === "review") {
        const latest = await findSavedNote(client.api, saved, signal);
        setDraft(mergeNoteDraft(saved, draft, latest));
        setSaved(latest);
        setConflict(false);

        return;
      }

      const target = { noteId: saved.id, expectedRevision: saved.revision };

      if (action === "delete") await client.api.deleteMemoryNote(target);
      else
        await client.api.updateMemoryNote({
          ...target,
          title: draft.title,
          body: draft.body,
          aliases: draft.aliases.filter((value) => value.trim()),
          pinned: draft.pinned,
        });
      onChanged();

      if (!signal.aborted) onClose();
    } catch (cause) {
      if (signal.aborted) {
        if (action !== "review") onChanged();

        return;
      }

      const { code } = ConnectError.from(cause);

      if (code === Code.Aborted || code === Code.FailedPrecondition) {
        setConflict(true);
        onChanged();
      } else if (code === Code.NotFound) {
        setGone(true);
        onChanged();
      } else if (code === Code.InvalidArgument && action === "save") {
        setError("Could not save this note. Check the title, body and aliases.");
      } else {
        const verb = action === "review" ? "load" : action;
        setError(`Could not ${verb} this note. Check the connection and retry.`);
      }
    } finally {
      active.current = null;
      setBusy(undefined);
    }
  }

  return { saved, draft, setDraft, conflict, gone, error, busy, run };
}

export function MemoryNoteSheet(props: SheetProps) {
  const [editing, setEditing] = useState(false);
  const { saved, draft, setDraft, conflict, gone, error, busy, run } = useNoteEditor(props);
  const reviewed = !conflict && saved.revision !== props.note.revision;
  const blocked = conflict || gone || Boolean(busy);

  return (
    <Sheet title={editing ? "Edit note" : "Memory note"} visible onClose={props.onClose} scroll={false}>
      <ScreenScroll
        key={`${editing}:${saved.revision}`}
        space={20}
        style={{ flex: 1 }}
        bounces={false}
        overScrollMode="never"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ maxWidth: 600 }}
      >
        {(!editing || reviewed) && <NotePreview note={saved} latest={editing && reviewed} />}
        {editing && <MemoryNoteFields draft={draft} disabled={Boolean(busy)} onChange={setDraft} />}
        {gone ? (
          <Notice error>This note no longer exists. Close it to return to the list.</Notice>
        ) : conflict ? (
          <View style={{ gap: 8 }}>
            <Notice error>This note changed. Review the latest version to continue.</Notice>
            <Button title="Review latest version" busy={busy === "review"} onPress={() => void run("review")} />
          </View>
        ) : null}
        {error ? <Notice error>{error}</Notice> : null}
        {editing ? (
          <Button
            title="Save changes"
            variant="primary"
            busy={busy === "save"}
            disabled={blocked || !draft.title.trim() || !draft.body.trim() || !noteChanged(saved, draft)}
            onPress={() => void run("save")}
          />
        ) : (
          <>
            <Button title="Edit note" variant="primary" disabled={blocked} onPress={() => setEditing(true)} />
            <Button
              title="Delete note"
              variant="danger"
              busy={busy === "delete"}
              disabled={blocked}
              onPress={() =>
                confirmAction(
                  "Delete note",
                  `This permanently deletes “${saved.title}” from memory.`,
                  () => void run("delete"),
                )
              }
            />
          </>
        )}
      </ScreenScroll>
    </Sheet>
  );
}

function NotePreview({ note, latest }: { note: ui.MemoryNote; latest: boolean }) {
  const c = useColors();
  const type = useTypography();
  const dateTime = useDateTime();

  return (
    <>
      {latest && (
        <Text accessibilityRole="header" style={[type.body, { color: c.text }]}>
          Latest saved version
        </Text>
      )}
      <SettingsValue title="Title" value={note.title} />
      <SettingsValue title="Scope" value={noteScopeLabel(note)} />
      {note.pinned && <Text style={[type.meta, { color: c.muted }]}>Pinned</Text>}
      <SettingsValue title="Body" value={note.body} />
      {note.aliases.length > 0 && <SettingsValue title="Aliases" value={note.aliases.join("\n")} />}
      {note.updatedAt && <SettingsValue title="Updated" value={dateTime(note.updatedAt.seconds)} />}
    </>
  );
}
