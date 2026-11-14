import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { formatRelative } from "@canopy/domain/format";
import { hasComposerContent } from "@canopy/domain/composer-drafts";
import { useSession } from "../../state/session";
import { Button, IconButton, Notice, Sheet } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import type { MobileComposerState } from "./store";
import { useVisibility } from "../../ui/viewport";
import { PendingDraft } from "./PendingDraft";

interface Props {
  draft?: MobileComposerState;
  threadId?: string;
  disabled?: boolean;
  overview?: boolean;
  indicatorOnly?: boolean;
  children?: ReactNode;
}

/** One bounded query shared by the composer hint and sidebar sheet. */
function useDraftActions({ draft, threadId = "", disabled = false }: Props) {
  const { client, drafts, active: foreground, epoch } = useSession();
  const active = useVisibility() && foreground;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ui.ComposerDraft[]>([]);
  const [hint, setHint] = useState<ui.ComposerDraft>();
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  useEffect(() => drafts?.subscribeRemote(() => setRevision((n) => n + 1)), [drafts]);

  useEffect(() => {
    if (!client || !drafts || !active || !threadId) return;
    const controller = new AbortController();
    void drafts.remote
      .load(client.api, drafts.deviceId)
      .then(async (page) => {
        const rows =
          page.nextPageToken &&
          page.threadIds.includes(threadId) &&
          !page.drafts.some((d) => d.target?.threadId === threadId)
            ? (
                await client.api.listComposerDrafts(
                  { deviceId: drafts.deviceId, threadId, pageSize: 1 },
                  { signal: controller.signal },
                )
              ).drafts
            : page.drafts;

        if (!controller.signal.aborted)
          setHint(
            rows.find(
              (d) =>
                d.target?.threadId === threadId && d.id !== draft?.id && d.updatedAtMs > (draft?.publishedAtMs ?? 0n),
            ),
          );
      })
      .catch(() => {});

    return () => controller.abort();
  }, [client, drafts, active, epoch, revision, threadId, draft]);

  useEffect(() => {
    if (open && active) void load();

    return () => {
      sequence.current++;
    };
  }, [open, active, revision]);

  async function load(more = false) {
    if (!client || !drafts) return;
    const ticket = ++sequence.current;
    setBusy(true);
    setError("");

    try {
      const page = await drafts.remote.load(client.api, drafts.deviceId, more);

      if (ticket !== sequence.current) return;
      setRows(page.drafts);
      setNext(page.nextPageToken);
    } catch {
      if (ticket === sequence.current) setError("Could not load drafts. Check the connection, then retry.");
    } finally {
      if (ticket === sequence.current) setBusy(false);
    }
  }

  async function take(row: ui.ComposerDraft, replace = false) {
    if (!client || !drafts || !row.target || disabled || draft?.locked) return;
    setBusy(true);
    setError("");

    try {
      const destination = drafts.get(row.target);
      await destination.take(client.api, row, replace);
      setOpen(false);
      setHint(undefined);

      if (row.target.threadId) {
        if (row.target.threadId !== threadId)
          router.push({ pathname: "/thread/[id]", params: { id: row.target.threadId } });
      } else if (row.target.parentThreadId)
        router.push({ pathname: "/thread/[id]", params: { id: row.target.parentThreadId, draftSideThread: "1" } });
      else
        router.push({
          pathname: "/new-thread",
          params: { project: row.target.projectId, workspace: row.target.workspaceId },
        });
    } catch {
      setError("Could not continue this draft. Refresh the list, then retry.");
    } finally {
      setBusy(false);
    }
  }

  return { drafts, open, setOpen, rows, hint, next, busy, error, take, load };
}

export function DraftActions({
  draft,
  disabled = false,
  threadId,
  overview = false,
  indicatorOnly = false,
  children,
}: Props) {
  const c = useColors();

  const { drafts, open, setOpen, rows, hint, next, busy, error, take, load } = useDraftActions({
    draft,
    threadId,
    disabled,
  });

  useEffect(() => {
    if (hint) draft?.dismissMove();
  }, [draft, hint?.id, hint?.revision]);

  return (
    <>
      {overview ? (
        <View style={styles.row}>
          <IconButton
            icon="document-text"
            label="Open drafts"
            disabled={disabled || busy}
            onPress={() => setOpen(true)}
          />
        </View>
      ) : null}
      {draft && !indicatorOnly ? <PendingDraft draft={draft} /> : null}
      {hint && indicatorOnly && !draft?.moved ? (
        <View style={[styles.row, { flex: 1, minWidth: 0 }]}>
          <Text numberOfLines={1} style={[styles.meta, { color: c.muted, flex: 1 }]}>
            Draft from {hint.deviceName} · {formatRelative(timestampFromMs(Number(hint.updatedAtMs)))}
          </Text>
          <Button
            title="Take over"
            variant="ghost"
            size="sm"
            disabled={disabled || busy}
            onPress={() => {
              if (draft && hasComposerContent(draft.content())) setOpen(true);
              else void take(hint);
            }}
          />
        </View>
      ) : indicatorOnly && !draft?.moved ? (
        children
      ) : null}
      {draft?.moved && indicatorOnly ? (
        <View style={[styles.row, { flex: 1, minWidth: 0 }]}>
          <Text numberOfLines={1} accessibilityLiveRegion="polite" style={[styles.meta, { color: c.muted, flex: 1 }]}>
            {draft.moved}
          </Text>
          <Button title="Dismiss" variant="ghost" size="sm" onPress={() => draft.dismissMove()} />
        </View>
      ) : null}
      {error && !open ? <Notice error>{error}</Notice> : null}
      <Sheet title="Drafts" visible={open} onClose={() => setOpen(false)}>
        <View style={{ padding: 16, gap: 12 }}>
          <Text style={[styles.body, { color: c.muted }]}>Continue a prompt from another device.</Text>
          {error ? <Notice error>{error}</Notice> : null}
          {!rows.length ? (
            <Text style={[styles.body, { color: c.muted }]}>
              {busy ? "Loading drafts…" : "No drafts from other devices"}
            </Text>
          ) : null}
          {rows.map((row) => (
            <DraftRow
              key={row.id}
              {...{ row, busy, take }}
              local={Boolean(row.target && hasComposerContent(drafts?.local.get(row.target)?.draft?.content))}
            />
          ))}
          <View style={styles.row}>
            <Button
              title="Refresh drafts"
              variant="ghost"
              size="sm"
              disabled={busy}
              onPress={() => {
                drafts?.remote.invalidate();
                void load();
              }}
            />
            {next ? (
              <Button title="Load more" variant="ghost" size="sm" disabled={busy} onPress={() => void load(true)} />
            ) : null}
          </View>
        </View>
      </Sheet>
    </>
  );
}

function DraftRow({
  row,
  busy,
  take,
  local,
}: {
  row: ui.ComposerDraft;
  busy: boolean;
  local: boolean;
  take: (row: ui.ComposerDraft, replace?: boolean) => Promise<void>;
}) {
  const c = useColors();

  return (
    <View style={{ gap: 4, paddingBottom: 12, borderBottomWidth: 1, borderColor: c.line }}>
      <Text numberOfLines={1} style={[styles.label, { color: c.text }]}>
        {row.title}
      </Text>
      <Text numberOfLines={1} style={[styles.meta, { color: c.muted }]}>
        {row.deviceName} · {formatRelative(timestampFromMs(Number(row.updatedAtMs)))}
      </Text>
      <Text numberOfLines={2} style={[styles.body, { color: c.text }]}>
        {row.content?.text}
      </Text>
      {row.content?.attachments.length ? (
        <Text style={[styles.meta, { color: c.muted }]}>
          {row.content.attachments.length} {row.content.attachments.length === 1 ? "attachment" : "attachments"}
        </Text>
      ) : null}
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <Button title={local ? "Append draft" : "Take over"} size="sm" disabled={busy} onPress={() => void take(row)} />
        {local ? (
          <Button
            title="Replace local draft"
            variant="ghost"
            size="sm"
            disabled={busy}
            onPress={() => void take(row, true)}
          />
        ) : null}
      </View>
    </View>
  );
}
