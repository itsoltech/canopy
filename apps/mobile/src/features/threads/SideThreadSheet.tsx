import { availablePermission } from "./permissions";
import { supportsSessionFork } from "@canopy/domain/harnesses";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ConnectError } from "@connectrpc/connect";
import { PermissionMode, ui } from "@canopy/contracts";
import { useComposerSettings } from "./useComposerSettings";
import { ComposerControls, ComposerPickers } from "./ComposerModelControls";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { useLayout } from "../../state/layout";
import { Button } from "../../ui/components";
import { usePersistentMessage } from "../drafts/usePersistentMessage";
import { DraftActions } from "../drafts/DraftActions";
import { DraftMoveNotice } from "../drafts/DraftMoveNotice";
import { PendingDraft } from "../drafts/PendingDraft";
import { createFromDraft } from "../drafts/create";
import { ReferenceSuggestions } from "../composer/ReferenceSuggestions";
import { ComposerBox } from "./ComposerBox";
import { AttachButton, AttachmentChips } from "../attachments/Attachments";
import { Overlay } from "../../ui/Overlay";
import { SheetDragArea } from "../../ui/SheetDragArea";
import { Checkbox } from "../../ui/Checkbox";
import { styles, useColors } from "../../ui/theme";

const hint = "The side thread starts from the main thread's last completed turn.";

/**
 * A side thread of this thread, as on the web: same project, worker, directory and provider instance; it can start from the
 * main thread's history. Full access is never taken over: the side thread gets full auto instead.
 */
export function SideThreadSheet({
  main,
  visible,
  onClose,
}: {
  main: ui.Thread | undefined;
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Overlay visible={visible} onClose={onClose} label="New side thread">
      {main && visible ? <SideThreadForm main={main} onClose={onClose} /> : null}
    </Overlay>
  );
}

function SideThreadForm({ main, onClose }: { main: ui.Thread; onClose: () => void }) {
  const c = useColors();
  const { client } = useSession();
  const layout = useLayout();

  const message = usePersistentMessage(
    create(ui.ComposerDraftTargetSchema, {
      projectId: main.projectId,
      workspaceId: main.workspaceId,
      parentThreadId: main.id,
    }),
  );

  const worker = useOverview().workers.find((worker) => worker.id === main.workerId);
  const settings = useComposerSettings(main, worker, message.persistent);

  const canFork = supportsSessionFork(main.provider);
  const [fork, setFork] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closed = main.status === "archived" || Boolean(main.archivedAt || main.deletedAt || main.worktree?.removedAt);

  const locked = closed || busy || Boolean(message.persistent?.pendingCreate);

  async function start() {
    if (!client || closed || (!message.value.text.trim() && !message.files.ids.length) || message.files.blocker || busy)
      return;
    setBusy(true);
    setError("");

    try {
      const outgoing = message.outgoing();
      const draft = message.persistent;

      const result = await createFromDraft(
        client.api,
        draft,
        create(ui.CreateThreadRequestSchema, {
          projectId: main.projectId,
          workspaceId: main.workspaceId,
          provider: main.provider,
          providerProfileId: main.providerProfileId,
          model: settings.override.model ?? main.model,
          effort: settings.effort,
          serviceTier: settings.serviceTier,
          permissionMode: availablePermission(
            main.provider,
            draft?.choices.permissionMode ??
              (main.permissionMode === PermissionMode.FULL_ACCESS ? PermissionMode.FULL_AUTO : main.permissionMode),
          ),
          initialMessage: outgoing.text,
          initialAttachmentIds: outgoing.attachmentIds,
          initialMentions: outgoing.mentions,
          initialQuotes: outgoing.quotes,
          parentThreadId: main.id,
          fork: canFork && fork,
          clientRequestId: draft?.requestId,
        }),
      );

      message.clear();
      onClose();

      if (result.thread) layout.open({ pathname: "/thread/[id]", params: { id: result.thread.id } });
    } catch (cause) {
      setError(ConnectError.from(cause).rawMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 16 }}>
      <SheetDragArea>
        <Text accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
          New side thread
        </Text>
      </SheetDragArea>
      <ComposerBox
        drafts={message.persistent && <DraftActions draft={message.persistent} disabled={busy || closed} />}
        label="Task for the side thread"
        text={message.value.text}
        onChange={message.setText}
        badges={message.badges}
        onSend={() => void start()}
        disabled={closed || Boolean(message.files.blocker)}
        busy={busy}
        readonly={Boolean(message.persistent?.pendingCreate)}
        files={message.files.ids.length}
        controls={<ComposerControls state={settings} thread={main} />}
        top={<AttachmentChips files={message.files.files} onRemove={message.remove} />}
        attachment={<AttachButton draft={message.files} onFindReference={message.findReference} disabled={locked} />}
      />
      {!locked && (
        <ReferenceSuggestions
          scope={create(ui.MentionScopeSchema, { threadId: main.id })}
          trigger={message.trigger}
          onPick={(option) => message.pickMention(option.mention)}
          inline
        />
      )}
      {message.persistent && (
        <>
          <PendingDraft draft={message.persistent} />
          <DraftMoveNotice draft={message.persistent} />
        </>
      )}
      <ComposerPickers state={settings} />
      {canFork && <Checkbox label="Use main thread history" description={hint} checked={fork} onChange={setFork} />}
      {closed || error ? (
        <Text accessibilityRole="alert" style={[styles.meta, { color: closed ? c.muted : c.danger }]}>
          {closed ? "Reopen the main thread to start a side thread." : error}
        </Text>
      ) : null}
      <View style={[styles.row, { justifyContent: "flex-end" }]}>
        <Button title="Cancel" onPress={onClose} />
        <Button
          variant="primary"
          title="Start side thread"
          busy={busy}
          disabled={
            closed || (!message.value.text.trim() && !message.files.ids.length) || Boolean(message.files.blocker)
          }
          onPress={() => void start()}
        />
      </View>
    </ScrollView>
  );
}
