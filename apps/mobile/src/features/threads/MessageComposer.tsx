import { useState } from "react";
import { ScrollView, View } from "react-native";
import { PermissionMode, ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { ComposerBox, ComposerPill } from "./ComposerBox";
import { Notice } from "../../ui/components";
import { styles } from "../../ui/theme";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { useAppearance } from "../../state/appearance";
import { findChoice, modelSections, useModelCatalog } from "../models/catalog";
import { useEffortLabel } from "../settings/display";
import { EffortPickerSheet, ModelPickerSheet } from "../models/ModelPicker";
import { permissionLabel, permissionLook, PermissionPickerSheet } from "./permissions";
import { AttachButton, AttachmentChips } from "../attachments/Attachments";
import { PasteTarget } from "../attachments/FileIntake";
import type { MessageDraft } from "../composer/useMessageDraft";
import { Skeleton } from "../../ui/Skeleton";
import { ComposerFold, useComposerMotion } from "../composer/ComposerFold";
import { composerGeometry } from "../composer/geometry";

type Picker = "model" | "effort" | "permission";

/** The thread's model, effort and permission mode: each pick is saved at once and applies from the next turn. */
function useComposerSettings(thread: ui.Thread | undefined, worker: ui.Worker | undefined) {
  const { client } = useSession();
  const [picker, setPicker] = useState<Picker | null>(null);
  const [error, setError] = useState("");
  const catalog = useModelCatalog(thread?.workerId);

  const section = thread
    ? modelSections(worker, catalog, { provider: thread.provider, profileId: thread.providerProfileId })[0]
    : undefined;

  const current = findChoice(section, thread?.model ?? "");
  const effort = thread?.effort || current?.defaultEffort || "";

  async function update(patch: { model?: string; effort?: string; permissionMode?: PermissionMode }) {
    if (!client || !thread) return;
    setError("");

    try {
      await client.api.updateThread({ threadId: thread.id, ...patch });
    } catch {
      setError("Could not update the thread. Try again.");
    }
  }

  return { picker, setPicker, error, section, current, effort, update };
}

export function MessageComposer({
  thread,
  worker,
  message,
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
  send: (delivery: ui.MessageDelivery) => void;
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
  const { setPicker, current, effort, error } = state;
  const effortLabel = useEffortLabel();
  const look = permissionLook(thread?.permissionMode);

  return (
    <>
      {error ? <Notice error>{error}</Notice> : null}
      <PasteTarget draft={message.files}>
        <ComposerBox
          compact={compact}
          onExpand={onExpand}
          text={message.value.text}
          onChange={message.setText}
          badges={message.badges}
          triggers
          onSend={() =>
            send(
              thread?.status === "running"
                ? user?.composer?.runningDelivery || ui.MessageDelivery.STEER
                : ui.MessageDelivery.QUEUE,
            )
          }
          onQueue={() => send(ui.MessageDelivery.QUEUE)}
          onStop={stop}
          running={thread?.status === "running"}
          disabled={disabled || Boolean(message.files.blocker)}
          busy={busy}
          files={message.files.ids.length}
          top={<AttachmentChips files={message.files.files} onRemove={message.remove} />}
          controls={
            <>
              <AttachButton draft={message.files} disabled={disabled || busy} />
              <ComposerPill
                icon="cpu-chip"
                leading={thread ? <ProviderIcon provider={thread.provider} /> : undefined}
                title={current?.name || "Model"}
                width={160}
                loading={!thread || (!current && !state.section?.choices.length)}
                onPress={() => {
                  setPicker("model");
                }}
              />
              <View style={{ width: 96 }}>
                {!current || current.efforts.length ? (
                  <ComposerPill
                    icon="light-bulb"
                    title={effortLabel(effort)}
                    width={96}
                    loading={!current}
                    onPress={() => {
                      setPicker("effort");
                    }}
                  />
                ) : null}
              </View>
            </>
          }
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
            title={permissionLabel(thread?.permissionMode)}
            width={128}
            warning={look.tone === "warning"}
            danger={look.tone === "danger"}
            onPress={() => setPicker("permission")}
          />
        </View>
      </ComposerFold>
      <ComposerPickers state={state} thread={thread} />
    </>
  );
}

function ComposerPickers({
  state,
  thread,
}: {
  state: ReturnType<typeof useComposerSettings>;
  thread: ui.Thread | undefined;
}) {
  const { picker, setPicker, section, current, effort, update } = state;
  const close = () => setPicker(null);

  return (
    <>
      <ModelPickerSheet
        visible={picker === "model"}
        onClose={close}
        sections={section ? [section] : []}
        value={current?.key}
        onSelect={(choice) =>
          void update({
            model: choice.model,
            // Keep the effort only when the new model takes it.
            effort: choice.efforts.includes(thread?.effort ?? "") ? thread?.effort : "",
          })
        }
      />
      <EffortPickerSheet
        visible={picker === "effort"}
        onClose={close}
        choice={current}
        value={effort}
        onSelect={(next) => void update({ effort: next })}
      />
      <PermissionPickerSheet
        visible={picker === "permission"}
        onClose={close}
        value={thread?.permissionMode}
        onSelect={(mode) => void update({ permissionMode: mode })}
      />
    </>
  );
}
