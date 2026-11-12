import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { ciLabel, ciEffect, ciReason, ciActions, type CiAction } from "@canopy/domain/github-ci";
import { useState } from "react";
import { PickerSheet, type PickerOption } from "../../ui/Picker";
import { Button, Notice, Sheet } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { IconAction } from "./IconAction";
import { useCiController } from "./useCiController";
import { ConfirmationCountdown } from "./ConfirmationCountdown";
import { invalidations } from "./invalidations";

export function CiActions({
  snapshot,
  runId,
  state,
  jobId = "",
  name = "",
  dialog = false,
  beforeChoose,
}: {
  snapshot: github.PullRequestSnapshot;
  runId: string;
  state: string;
  jobId?: string;
  name?: string;
  dialog?: boolean;
  beforeChoose?: (choose: () => void) => void;
}) {
  const { controller, state: f, online } = useCiController(snapshot, runId);

  const c = useColors(),
    type = useTypography();

  const options = actionOptions(snapshot, runId, state, jobId, controller, online);
  const [menu, setMenu] = useState(false);
  const [pending, setPending] = useState<CiAction>();
  const refresh = () => invalidations.publish(snapshot.summary?.ref?.id ?? "");

  const close = () => {
    if (!f.busy) {
      controller?.patch({ open: false });
    }
  };

  return (
    <View style={{ flexShrink: 0 }}>
      {!dialog && (
        <View style={{ width: 44 }}>
          {!!options.length && (
            <IconAction icon="ellipsis-horizontal" label="Check actions" onPress={() => setMenu(true)} />
          )}
          <PickerSheet<CiAction>
            title="Check actions"
            visible={menu}
            onClose={() => setMenu(false)}
            onSelect={(action) => {
              setPending(action);
              setMenu(false);
            }}
            onDismiss={() => {
              const action = pending;
              setPending(undefined);

              if (!action) return;

              const choose = () => {
                if (controller?.state.receipt) controller.patch({ open: true });
                else void controller?.choose(action, action === "job" ? jobId : "", action === "job" ? name : "");
              };

              if (beforeChoose) beforeChoose(choose);
              else choose();
            }}
            sections={[{ options }]}
          />
        </View>
      )}
      {dialog && (
        <Sheet title={f.receipt ? "CI request" : `${ciLabel(f.action)}?`} visible={f.open} onClose={close}>
          <View style={{ gap: 12 }}>
            <Notice>
              {f.receipt ? "GitHub updates the checks as jobs are queued, running and completed." : ciEffect(f.action)}
            </Notice>
            <Text style={[type.small, { color: c.text }]}>
              {snapshot.summary?.ref?.repositoryName} #{snapshot.summary?.ref?.number}
            </Text>
            <Text style={[type.small, { color: c.text }]}>
              {f.run?.name ?? name} · run {runId} · attempt {f.run?.attempt ?? "…"}
            </Text>
            {f.action === "job" && (
              <Text style={[type.small, { color: c.text }]}>
                {f.jobName} · job {f.jobId}
              </Text>
            )}
            <Text style={[type.mono, { color: c.muted }]}>{snapshot.summary?.headSha.slice(0, 7)}</Text>
            {f.prepared && <ConfirmationCountdown expiresAt={f.expiresAt} />}
            {!!f.detail && <Notice>{f.detail}</Notice>}
            <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
              <Button
                title={f.receipt ? "Close" : f.action === "cancel" ? "Keep run" : "Cancel"}
                variant="ghost"
                disabled={f.busy}
                onPress={close}
              />
              {f.receipt ? (
                <Button
                  title="Check current state"
                  disabled={f.busy || !online}
                  onPress={() => void controller?.check().then(refresh)}
                />
              ) : (
                <Button
                  title={ciLabel(f.action)}
                  variant={f.action === "cancel" ? "danger" : "primary"}
                  busy={f.busy}
                  disabled={!f.prepared || !online || snapshot.stale}
                  onPress={() => void controller?.confirm().then(refresh)}
                />
              )}
            </View>
          </View>
        </Sheet>
      )}
    </View>
  );
}

function actionOptions(
  snapshot: github.PullRequestSnapshot,
  runId: string,
  state: string,
  jobId: string,
  controller: ReturnType<typeof useCiController>["controller"],
  online: boolean,
): PickerOption<CiAction>[] {
  if (!controller) return [];

  if (controller.state.receipt) return [{ value: "all", label: "Check CI request", icon: "clock" }];

  return (runId ? ciActions(state, !!jobId) : []).map((action) => ({
    value: action,
    label: ciLabel(action),
    disabled: controller.blocked || !online || !!ciReason(snapshot, runId, state, action),
    description: !online ? "Connect to change CI." : ciReason(snapshot, runId, state, action) || undefined,
  }));
}
