import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ui } from "@canopy/contracts";
import { memoryScopes, noteScopeLabel } from "@canopy/domain/memory-scopes";
import { Code, ConnectError } from "@connectrpc/connect";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { useLayout } from "../../state/layout";
import { Button, EmptyState, Notice } from "../../ui/components";
import { SettingsDensity } from "../../ui/density";
import { Icon } from "../../ui/Icon";
import { ScreenScroll } from "../../ui/ScreenScroll";
import { SkeletonScope } from "../../ui/Skeleton";
import { font, useColors, useTypography } from "../../ui/theme";
import { MemoryNoteSheet } from "./MemoryNoteSheet";
import { SettingChoice, SettingsActions, SettingsGroup } from "./SettingsGroup";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

const scopeOptions = memoryScopes.map(({ scope, label }) => ({ value: scope, label }));

export function MemorySettings() {
  const { client, queries } = useSession();
  const { wide } = useLayout();
  const [scope, setScope] = useState(ui.MemoryNoteScope.UNSPECIFIED);
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<ui.MemoryNote>();
  const cursor = cursors.at(-1) ?? "";

  const page = useSharedQuery(
    `ListMemoryNotes:${scope}:${cursor}`,
    async (signal) => {
      if (!client) return null;

      try {
        return await client.api.listMemoryNotes({ scope, cursor, limit: 30 }, { signal });
      } catch (cause) {
        if (ConnectError.from(cause).code === Code.Unimplemented) return null;
        throw cause;
      }
    },
    Boolean(client),
    30_000,
  );

  const loading = !page.loaded && !page.error;
  const nextCursor = page.data?.nextCursor;

  function changeScope(value: ui.MemoryNoteScope) {
    setScope(value);
    setCursors([]);
  }

  function refresh() {
    queries.forget((key) => key.startsWith("ListMemoryNotes:"));
    setCursors([]);
  }

  return (
    <SettingsDensity.Provider value={true}>
      <ScreenScroll
        key={`${scope}:${cursor}`}
        space={20}
        innerLeft={wide}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, minWidth: 0 }}
        contentContainerStyle={{ maxWidth: 1024, gap: 16 }}
      >
        {page.data === null ? (
          <Notice>Update Canopy on your gateway to manage memory notes.</Notice>
        ) : (
          <>
            <SettingChoice title="Scope" value={scope} options={scopeOptions} onChange={changeScope} />
            {page.error ? (
              <View style={{ gap: 8 }}>
                <Notice error>Could not load notes. Check the connection.</Notice>
                <Button title="Retry" busy={page.loading} onPress={() => void page.reload().catch(() => {})} />
              </View>
            ) : null}
            {loading || page.data?.notes.length ? (
              <SkeletonScope loading={loading}>
                <SettingsGroup title="Notes">
                  {loading && <SettingsSkeletonRows />}
                  {page.data?.notes.map((note) => (
                    <NoteRow key={note.id} note={note} onPress={() => setSelected(note)} />
                  ))}
                </SettingsGroup>
              </SkeletonScope>
            ) : page.data ? (
              <EmptyState
                title={cursor ? "No more notes" : scope ? "No notes in this scope" : "No memory notes yet"}
                description={!cursor && !scope ? "Ask an agent or bot to remember a decision." : undefined}
                action={
                  !cursor && scope !== ui.MemoryNoteScope.UNSPECIFIED ? (
                    <Button title="Show all notes" onPress={() => changeScope(ui.MemoryNoteScope.UNSPECIFIED)} />
                  ) : undefined
                }
              />
            ) : null}
            {cursor || nextCursor ? (
              <SettingsActions>
                {!!cursor && <Button title="Show previous notes" onPress={() => setCursors(cursors.slice(0, -1))} />}
                {!!nextCursor && (
                  <Button title="Show next notes" onPress={() => setCursors([...cursors, nextCursor])} />
                )}
              </SettingsActions>
            ) : null}
          </>
        )}
      </ScreenScroll>
      {selected && (
        <MemoryNoteSheet key={selected.id} note={selected} onClose={() => setSelected(undefined)} onChanged={refresh} />
      )}
    </SettingsDensity.Provider>
  );
}

function NoteRow({ note, onPress }: { note: ui.MemoryNote; onPress: () => void }) {
  const c = useColors();
  const type = useTypography();
  const metadata = [note.pinned ? "Pinned" : "", noteScopeLabel(note)].filter(Boolean).join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={note.title}
      accessibilityValue={{ text: metadata }}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        minHeight: 44,
        gap: 8,
        backgroundColor: pressed ? c.pressed : "transparent",
      })}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text numberOfLines={2} style={[type.chrome, { color: c.text, fontFamily: font.medium }]}>
          {note.title}
        </Text>
        <Text numberOfLines={2} style={[type.meta, { color: c.muted }]}>
          {metadata}
        </Text>
      </View>
      <Icon name="chevron-right" color={c.faint} />
    </Pressable>
  );
}
