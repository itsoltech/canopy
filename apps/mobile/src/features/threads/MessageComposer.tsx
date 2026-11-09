import { ScrollView, View } from "react-native";
import { ui } from "@canopy/contracts";
import type { ComposerPick } from "@canopy/domain/composer-choices";
import { ComposerBox, ComposerPill } from "./ComposerBox";
import { styles } from "../../ui/theme";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { useAppearance } from "../../state/appearance";
import { useEffortLabel } from "../settings/display";
import { EffortPickerSheet, ModelPickerSheet } from "../models/ModelPicker";
import { permissionLabel, permissionLook, PermissionPickerSheet } from "./permissions";
import { AttachButton, AttachmentChips } from "../attachments/Attachments";
import { PasteTarget } from "../attachments/FileIntake";
import type { MessageDraft } from "../composer/useMessageDraft";
import { Skeleton } from "../../ui/Skeleton";
import { ComposerFold, useComposerMotion } from "../composer/ComposerFold";
import { composerGeometry } from "../composer/geometry";
import { QuoteTray } from "../quotes/QuoteTray";
import type { useQuoteDraft } from "../quotes/useQuoteDraft";
import { useComposerSettings } from "./useComposerSettings";

export function MessageComposer({
  thread,
  worker,
  message,
  quotes,
  send,
  stop,
  disabled,
  busy,
  onDetails,
  onGoal,
  compact = false,
  onExpand,
}: {
  thread?: ui.Thread;
  worker?: ui.Worker;
  message: MessageDraft;
  quotes: ReturnType<typeof useQuoteDraft>;
  send: (delivery: ui.MessageDelivery, choices: ComposerPick) => void;
  stop: () => void;
  disabled: boolean;
  busy: boolean;
  onDetails: () => void;
  onGoal: () => void;
  compact?: boolean;
  onExpand?: () => void;
}) {
  const { user } = useAppearance();
  const { focused } = useComposerMotion();
  const state = useComposerSettings(thread, worker);
  const { setPicker } = state;
  const look = permissionLook(state.permissionMode);

  const primary =
    user?.composer?.runningDelivery === ui.MessageDelivery.QUEUE ? ui.MessageDelivery.QUEUE : ui.MessageDelivery.STEER;

  return (
    <>
      <PasteTarget draft={message.files}>
        <ComposerBox
          compact={compact}
          onExpand={onExpand}
          text={message.value.text}
          onChange={message.setText}
          badges={message.badges}
          triggers
          onSend={() => send(thread?.status === "running" ? primary : ui.MessageDelivery.QUEUE, state.override)}
          onAlternate={() =>
            send(
              primary === ui.MessageDelivery.QUEUE ? ui.MessageDelivery.STEER : ui.MessageDelivery.QUEUE,
              state.override,
            )
          }
          primary={primary === ui.MessageDelivery.QUEUE ? "queue" : "steer"}
          onStop={stop}
          running={thread?.status === "running"}
          disabled={disabled || Boolean(message.files.blocker)}
          busy={busy}
          files={message.files.ids.length + quotes.quotes.length}
          top={<ComposerAttachments message={message} quotes={quotes} />}
          controls={<ComposerControls state={state} thread={thread} message={message} disabled={disabled || busy} />}
        />
      </PasteTarget>
      {/* Only this secondary row gives its height to the field while writing. */}
      <ComposerFold open={!compact && !focused} expandedHeight={composerGeometry.secondary}>
        <View style={[styles.row, { justifyContent: "space-between", paddingHorizontal: 6 }]}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.row}
            style={{ flex: 1 }}
          >
            {worker ? (
              <ComposerPill icon="computer-desktop" title={worker.name} onPress={onDetails} />
            ) : (
              <Skeleton style={{ width: 100, height: composerGeometry.secondary }} />
            )}
            {thread?.goalStatus ? <ComposerPill icon="flag" title="Goal" onPress={onGoal} /> : null}
          </ScrollView>
          <ComposerPill
            icon={look.icon}
            title={permissionLabel(state.permissionMode)}
            warning={look.tone === "warning"}
            danger={look.tone === "danger"}
            onPress={() => setPicker("permission")}
          />
        </View>
      </ComposerFold>
      <ComposerPickers state={state} />
    </>
  );
}

function ComposerControls({
  state,
  thread,
  message,
  disabled,
}: {
  state: ReturnType<typeof useComposerSettings>;
  thread: ui.Thread | undefined;
  message: MessageDraft;
  disabled: boolean;
}) {
  const { setPicker, current, effort } = state;
  const effortLabel = useEffortLabel();

  return (
    <>
      <AttachButton draft={message.files} disabled={disabled} />
      <ComposerPill
        icon="cpu-chip"
        leading={thread ? <ProviderIcon provider={thread.provider} /> : undefined}
        title={current?.name || "Model"}
        loadingWidth={128}
        loading={!thread || (!current && !state.section?.choices.length)}
        onPress={() => setPicker("model")}
      />
      {!current || current.efforts.length ? (
        <ComposerPill
          icon="light-bulb"
          title={effortLabel(effort)}
          loadingWidth={72}
          loading={!current}
          onPress={() => setPicker("effort")}
        />
      ) : null}
    </>
  );
}

function ComposerAttachments({ message, quotes }: { message: MessageDraft; quotes: ReturnType<typeof useQuoteDraft> }) {
  return (
    <>
      <QuoteTray draft={quotes} />
      <AttachmentChips files={message.files.files} onRemove={message.remove} />
    </>
  );
}

function ComposerPickers({ state }: { state: ReturnType<typeof useComposerSettings> }) {
  const { picker, setPicker, section, current, effort, permissionMode, update } = state;
  const close = () => setPicker(null);

  return (
    <>
      <ModelPickerSheet
        visible={picker === "model"}
        onClose={close}
        sections={section ? [section] : []}
        value={current?.key}
        onSelect={(choice) =>
          update({
            model: choice.model,
            // Keep the effort only when the new model takes it.
            effort: choice.efforts.includes(effort) ? effort : choice.defaultEffort,
          })
        }
      />
      <EffortPickerSheet
        visible={picker === "effort"}
        onClose={close}
        choice={current}
        value={effort}
        onSelect={(next) => update({ effort: next })}
      />
      <PermissionPickerSheet
        visible={picker === "permission"}
        onClose={close}
        value={permissionMode}
        onSelect={(mode) => update({ permissionMode: mode })}
      />
    </>
  );
}
