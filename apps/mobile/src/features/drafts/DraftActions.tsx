import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { Code, ConnectError } from "@connectrpc/connect";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { formatRelative } from "@canopy/domain/format";
import { hasComposerContent } from "@canopy/domain/composer-drafts";
import { useSession } from "../../state/session";
import { Button, Notice, Sheet } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import type { MobileComposerState } from "./store";
import { useVisibility } from "../../ui/viewport";
import { PendingDraft } from "./PendingDraft";

interface Props {
  draft: MobileComposerState;
  threadId?: string;
  disabled?: boolean;
}

/** A bounded query on open/invalidation; typing never writes to the gateway. */
function useDraftActions({ draft, threadId = "", disabled = false }: Props) {
  const { client, drafts, active: foreground, epoch } = useSession();
  const active = useVisibility() && foreground;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ui.ComposerDraft[]>([]);
  const [hint, setHint] = useState<ui.ComposerDraft>();
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  useEffect(() => drafts?.subscribeRemote(() => setRevision((n) => n + 1)), [drafts]);

  useEffect(() => {
    if (!client || !drafts || !active || !threadId) return;
    const controller = new AbortController();
    void drafts.remote
      .load(client.api, drafts.deviceId)
      .then((page) =>
        setHint(
          page.drafts.find(
            (d) =>
              !controller.signal.aborted &&
              d.target?.threadId === threadId &&
              d.id !== draft.id &&
              d.updatedAtMs > draft.publishedAtMs,
          ),
        ),
      )
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
    if (!client || !drafts || !row.target || disabled || draft.locked) return;
    setBusy(true);
    setError("");

    try {
      const destination = drafts.get(row.target);
      await destination.take(client.api, row, replace);
      setOpen(false);
      setHint(undefined);

      if (row.target.threadId) router.push({ pathname: "/thread/[id]", params: { id: row.target.threadId } });
      else if (row.target.parentThreadId)
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

  async function publish() {
    if (!client) return;
    setBusy(true);
    setError("");
    setNotice("");

    try {
      await draft.publish(client.api);
      await drafts?.flush();
      setNotice("Draft ready on your other devices");
    } catch (cause) {
      setError(
        ConnectError.from(cause).code === Code.Unimplemented
          ? "Update Canopy on your gateway to hand off drafts."
          : "Could not hand off this draft. Check the connection, then retry.",
      );
    } finally {
      setBusy(false);
    }
  }

  return { drafts, open, setOpen, rows, hint, next, busy, error, notice, take, publish, load };
}

export function DraftActions({ draft, disabled = false, threadId }: Props) {
  const c = useColors();

  const { drafts, open, setOpen, rows, hint, next, busy, error, notice, take, publish, load } = useDraftActions({
    draft,
    threadId,
    disabled,
  });

  return (
    <>
      <View style={[styles.row, { flexWrap: "wrap", gap: 0 }]}>
        <Button
          title="Open drafts"
          variant="ghost"
          size="sm"
          disabled={disabled || busy}
          onPress={() => setOpen(true)}
        />
        <Button
          title="Continue on another device"
          variant="ghost"
          size="sm"
          disabled={
            disabled ||
            busy ||
            draft.files.current.some((file) => !file.attachment) ||
            Boolean(draft.pendingSend || draft.pendingCreate) ||
            !hasComposerContent(draft.content())
          }
          onPress={() => void publish()}
        />
      </View>
      <PendingDraft draft={draft} />
      {hint ? (
        <View style={[styles.row, { paddingHorizontal: 6 }]}>
          <Text numberOfLines={1} style={[styles.meta, { color: c.muted, flex: 1 }]}>
            Draft from {hint.deviceName} · {formatRelative(timestampFromMs(Number(hint.updatedAtMs)))}
          </Text>
          <Button
            title="Continue"
            variant="ghost"
            size="sm"
            disabled={disabled || busy}
            onPress={() => void take(hint)}
          />
        </View>
      ) : null}
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={[styles.meta, { color: c.muted }]}>
          {notice}
        </Text>
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
            <View key={row.id} style={{ gap: 4, paddingBottom: 12, borderBottomWidth: 1, borderColor: c.line }}>
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
                <Button title="Continue here" size="sm" disabled={busy} onPress={() => void take(row)} />
                {row.target && hasComposerContent(drafts?.local.get(row.target)?.draft?.content) ? (
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
