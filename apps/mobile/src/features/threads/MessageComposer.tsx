import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { View } from "react-native";
import { PermissionMode, ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { ComposerBox, ComposerPill } from "./ComposerBox";
import { Notice } from "../../ui/components";
import { styles } from "../../ui/theme";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { useAppearance } from "../../state/appearance";
import { effortLabel, findChoice, modelSections, useModelCatalog } from "../models/catalog";
import { EffortPickerSheet, ModelPickerSheet } from "../models/ModelPicker";
import { permissionLabel, permissionLook, PermissionPickerSheet } from "./permissions";
import { AttachButton, AttachmentChips } from "../attachments/Attachments";
import type { MessageDraft } from "../composer/useMessageDraft";
import { MentionSuggestions } from "../composer/MentionSuggestions";

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
}) {
  const { user } = useAppearance();
  const state = useComposerSettings(thread, worker);
  const { setPicker, current, effort, error } = state;
  const look = permissionLook(thread?.permissionMode);
  const scope = thread ? create(ui.MentionScopeSchema, { threadId: thread.id }) : undefined;

  return (
    <>
      {error ? <Notice error>{error}</Notice> : null}
      <MentionSuggestions
        scope={scope}
        trigger={message.trigger}
        onPick={(option) => message.pickMention(option.mention)}
      />
      <ComposerBox
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
            <AttachButton draft={message.files} disabled={busy} />
            {thread?.goalStatus ? <ComposerPill icon="flag" title="Goal" onPress={onGoal} /> : null}
            <ComposerPill
              icon="cpu-chip"
              leading={thread ? <ProviderIcon provider={thread.provider} /> : undefined}
              title={current?.name || thread?.model || "Default model"}
              onPress={() => setPicker("model")}
            />
            {current?.efforts.length ? (
              <ComposerPill icon="light-bulb" title={effortLabel(effort)} onPress={() => setPicker("effort")} />
            ) : null}
          </>
        }
      />
      <View style={[styles.row, { justifyContent: "space-between", paddingHorizontal: 6 }]}>
        <ComposerPill icon="computer-desktop" title={worker?.name ?? "Worker"} onPress={onDetails} />
        <ComposerPill
          icon={look.icon}
          title={permissionLabel(thread?.permissionMode)}
          warning={look.tone === "warning"}
          danger={look.tone === "danger"}
          onPress={() => setPicker("permission")}
        />
      </View>
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
