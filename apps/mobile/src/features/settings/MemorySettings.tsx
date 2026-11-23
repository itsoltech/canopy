import { useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import { Pressable, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { noteScopeLabel } from "@canopy/domain/memory-scopes";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { MemoryNoteFilters } from "./MemoryNoteFilters";
import { Button, EmptyState, Notice } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { useClock, useDateTime } from "./display";
import { useMemoryNotes } from "./use-memory-notes";
import { useRevealSettingsView } from "./SettingsScroll";
import { SkeletonScope } from "../../ui/Skeleton";
import { font, useColors, useTypography } from "../../ui/theme";
import { MemoryHabits } from "./MemoryHabits";
import { MemoryNoteSheet } from "./MemoryNoteSheet";
import { SettingsActions, SettingsGroup, SettingsGroupHeader } from "./SettingsGroup";
import { SettingsSkeletonRows } from "./SettingsSkeleton";

export function MemorySettings() {
  const notes = useMemoryNotes();
  const [selected, setSelected] = useState<ui.MemoryNote>();
  const [wide, setWide] = useState(false);
  const { data, page, options, filters, filtered } = notes;
  const reveal = useRevealSettingsView();
  const results = useRef<ComponentRef<typeof View>>(null);
  const requestedPage = useRef<typeof filters | undefined>(undefined);
  useLayoutEffect(() => {
    if (requestedPage.current !== filters || !page.data?.notes.length) return;
    requestedPage.current = undefined;
    reveal(results.current);
  }, [page.data, reveal, filters]);

  function paginate(forward: boolean) {
    requestedPage.current = filters;
    notes.go(forward);
  }

  const loading = !data && !page.loaded && !page.error;
  const clock = useClock();
  const groups = new Map<string, ui.MemoryNote[]>();

  for (const note of data?.notes ?? []) {
    const day = note.updatedAt ? clock.day(timestampDate(note.updatedAt)) : "Unknown date";
    const list = groups.get(day);

    if (list) list.push(note);
    else groups.set(day, [note]);
  }

  return (
    <>
      <MemoryHabits onApproved={notes.refresh} />
      {data === null ? (
        <Notice>Update Canopy on your gateway to manage memory notes.</Notice>
      ) : (
        <>
          <MemoryNoteFilters notes={notes} />
          {page.error ? (
            <View style={{ gap: 8 }}>
              <Notice error>Could not load notes. Check the connection.</Notice>
              <SettingsActions>
                {!data && notes.number > 1 && <Button title="Previous" onPress={() => paginate(false)} />}
                <Button title="Retry" busy={page.loading} onPress={() => void page.reload().catch(() => {})} />
              </SettingsActions>
            </View>
          ) : null}
          {loading && (
            <SkeletonScope loading>
              <SettingsGroup title="Notes">
                <SettingsSkeletonRows />
              </SettingsGroup>
            </SkeletonScope>
          )}
          {!!groups.size && (
            <View
              ref={results}
              collapsable={false}
              onLayout={(event) => setWide(event.nativeEvent.layout.width >= 608)}
              style={{ gap: 12 }}
            >
              <SettingsGroupHeader title="Notes by last update" />
              {Array.from(groups, ([day, items]) => (
                <SettingsGroup key={day} title={day}>
                  {items.map((note) => (
                    <NoteRow
                      key={note.id}
                      note={note}
                      query={filters.query}
                      wide={wide}
                      onPress={() => setSelected(note)}
                    />
                  ))}
                </SettingsGroup>
              ))}
            </View>
          )}
          {data && !data.notes.length && notes.number === 1 && (
            <EmptyState
              title={filtered ? (options ? "No matching notes" : "No notes in this scope") : "No memory notes yet"}
              description={
                filtered
                  ? options
                    ? "Try a different search or clear the filters."
                    : undefined
                  : "Ask an agent or bot to remember a decision."
              }
              action={filtered && !options ? <Button title="Show all notes" onPress={notes.clear} /> : undefined}
            />
          )}
          {data && (notes.number > 1 || !!data.nextCursor) && (
            <SettingsActions>
              <PageNumber number={notes.number} />
              <Button title="Previous" disabled={page.loading || notes.number === 1} onPress={() => paginate(false)} />
              <Button title="Next" disabled={!data.nextCursor || page.loading} onPress={() => paginate(true)} />
            </SettingsActions>
          )}
        </>
      )}
      {selected && (
        <MemoryNoteSheet
          key={selected.id}
          note={selected}
          onClose={() => setSelected(undefined)}
          onChanged={notes.refresh}
        />
      )}
    </>
  );
}

function PageNumber({ number }: { number: number }) {
  const c = useColors();
  const type = useTypography();

  return (
    <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted }]}>
      Page {number}
    </Text>
  );
}

function NoteRow({
  note,
  query,
  wide,
  onPress,
}: {
  note: ui.MemoryNote;
  query: string;
  wide: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const date = useDateTime();

  const metadata = [
    note.pinned ? "Pinned" : "",
    noteScopeLabel(note),
    note.createdAt && `Created ${date(note.createdAt.seconds)}`,
  ]
    .filter(Boolean)
    .join(" · ");

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
      <View
        style={{
          flex: 1,
          minWidth: 0,
          flexDirection: wide ? "row" : "column",
          alignItems: wide ? "center" : "stretch",
          gap: wide ? 12 : 3,
        }}
      >
        <View style={{ gap: 3, minWidth: 0, flex: wide ? 1 : undefined }}>
          <Text numberOfLines={2} style={[type.chrome, { color: c.text, fontFamily: font.medium }]}>
            {note.title}
          </Text>
          {(!!query || wide) && (
            <Text numberOfLines={2} style={[type.meta, { color: c.muted }]}>
              {matchingPreview(note, query)}
            </Text>
          )}
        </View>
        <Text
          numberOfLines={2}
          style={[
            type.meta,
            { color: c.muted, maxWidth: wide ? "33%" : undefined, textAlign: wide ? "right" : "left" },
          ]}
        >
          {metadata}
        </Text>
      </View>
      <Icon name="chevron-right" color={c.faint} />
    </Pressable>
  );
}

function matchingPreview(note: ui.MemoryNote, query: string) {
  const term = query.toLowerCase().replace(/\s+/g, " ");
  const body = note.body.replace(/\s+/g, " ");

  if (note.title.toLowerCase().includes(term)) return body;
  const at = body.toLowerCase().indexOf(term);

  if (at >= 0) return at > 24 ? `…${body.slice(at - 24)}` : body;
  const alias = note.aliases.find((value) => value.toLowerCase().includes(term));

  return alias ? `Alias · ${alias}` : body;
}
