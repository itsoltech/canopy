import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useTween } from "../../ui/motion";
import type { ui } from "@canopy/contracts";
import { hasComposerContent, matchesComposerTarget } from "@canopy/domain/composer-drafts";
import { useSession } from "../../state/session";
import { AnchoredOverlay } from "../../ui/AnchoredOverlay";
import { Icon } from "../../ui/Icon";
import { Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { useVisibility } from "../../ui/viewport";
import type { MobileComposerState } from "./store";
import { DraftRow } from "./DraftRow";

export function DraftActions({ draft, disabled = false }: { draft: MobileComposerState; disabled?: boolean }) {
  const c = useColors();
  const { client, drafts, active: foreground, epoch } = useSession();
  const active = useVisibility() && foreground;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ui.ComposerDraft[]>([]);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = useCallback(() => {
    setOpen(false);
    setSelected("");
  }, []);

  useEffect(() => drafts?.subscribeRemote(() => setRevision((n) => n + 1)), [drafts]);
  useEffect(() => {
    if (!client || !drafts || !active) return;
    let cancelled = false;
    void drafts.remote
      .load(client.api, drafts.deviceId)
      .then((page) => {
        if (cancelled) return;

        const matching = page.drafts.filter(
          (row) => matchesComposerTarget(row.target, draft.targetKey) && row.id !== draft.id,
        );

        setRows(matching);

        if (matching.some((row) => row.updatedAtMs > draft.publishedAtMs)) draft.dismissMove();

        if (!matching.length) close();
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [client, drafts, active, epoch, revision, draft, draft.id, close]);
  useEffect(() => {
    if (!active) close();
  }, [active, close]);

  async function act(row: ui.ComposerDraft, action: "take" | "replace" | "discard") {
    if (!client || !drafts || disabled || draft.locked || !matchesComposerTarget(row.target, draft.targetKey)) return;
    setBusy(true);
    setError("");

    try {
      if (action === "discard")
        await client.api.deleteComposerDraft({
          id: row.id,
          expectedRevision: row.revision,
          deviceId: row.takenByDeviceId || row.deviceId,
        });
      else {
        await draft.take(client.api, row, action === "replace");
        close();
      }

      drafts.remote.invalidate();
      const page = await drafts.remote.load(client.api, drafts.deviceId);

      const matching = page.drafts.filter(
        (item) => matchesComposerTarget(item.target, draft.targetKey) && item.id !== draft.id,
      );

      setRows(matching);

      if (!matching.length) close();
    } catch {
      setError(
        action === "discard"
          ? "Could not discard this draft. Try again."
          : "Could not take over this draft. Select it to retry.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!rows.length) return null;

  return (
    <AnchoredOverlay
      visible={open}
      onClose={close}
      label="Drafts"
      modal={false}
      disclosure
      attached
      maxHeight={280}
      anchor={
        <View style={{ height: 32, alignItems: "flex-end", paddingRight: 12, opacity: open ? 0 : 1 }}>
          <View
            style={{
              height: 33,
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: c.line,
              backgroundColor: c.surface,
              borderTopLeftRadius: 12,
              borderTopRightRadius: 12,
            }}
          >
            <DraftHeader count={rows.length} expanded={false} onToggle={() => setOpen(true)} />
          </View>
        </View>
      }
    >
      <DraftHeader count={rows.length} expanded onToggle={close} />
      {rows.map((row) => (
        <DraftRow
          key={row.id}
          row={row}
          selected={selected === row.id}
          disabled={disabled || busy || draft.locked}
          onSelect={() => {
            if (hasComposerContent(draft.content())) setSelected(selected === row.id ? "" : row.id);
            else void act(row, "take");
          }}
          onTake={(replace) => void act(row, replace ? "replace" : "take")}
          onDiscard={() => void act(row, "discard")}
        />
      ))}
      {error ? <Notice error>{error}</Notice> : null}
    </AnchoredOverlay>
  );
}

function DraftHeader({ count, expanded, onToggle }: { count: number; expanded: boolean; onToggle: () => void }) {
  const c = useColors();
  const flip = useTween(expanded ? 1 : -1);
  const chevron = useAnimatedStyle(() => ({ transform: [{ scaleY: flip.get() }] }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Drafts, ${count}`}
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={[styles.row, { minHeight: 32, paddingHorizontal: 12, gap: 8 }]}
    >
      <Icon name="document-text" size={14} />
      <Text style={[styles.meta, { color: c.muted, flex: expanded ? 1 : undefined }]}>Drafts</Text>
      <Text style={[styles.meta, { color: c.accent }]}>{count}</Text>
      <Animated.View style={chevron}>
        <Icon name="chevron-down" size={14} />
      </Animated.View>
    </Pressable>
  );
}
