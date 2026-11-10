import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { ciLabel, ciEffect, ciReason, type CiAction } from "@canopy/domain/github-ci";
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

  const actions: CiAction[] = jobId ? ["job", "cancel"] : ["all", "failed", "cancel"];
  const refresh = () => invalidations.publish(snapshot.summary?.ref?.id ?? "");

  const close = () => {
    if (!f.busy) {
      controller?.patch({ open: false });
    }
  };

  return (
    <View style={{ flexShrink: 0 }}>
      {!dialog && (
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          {actions.map((action, i) => {
            const reason = !online
              ? "Connect and refresh before changing CI."
              : ciReason(snapshot, runId, state, action);

            const inspect = !!f.receipt && i === 0;

            return (
              <IconAction
                key={action}
                icon={
                  inspect
                    ? "clock"
                    : action === "cancel"
                      ? "stop"
                      : action === "failed"
                        ? "arrow-path-rounded-square"
                        : "arrow-path"
                }
                label={inspect ? "Check CI request" : ciLabel(action)}
                disabled={!controller || f.busy || (!inspect && (controller.blocked || !!reason))}
                hint={
                  inspect
                    ? "Check CI request"
                    : reason || (controller?.blocked ? "Check current state before another CI action." : "")
                }
                onPress={() => {
                  const choose = () => {
                    if (controller?.state.receipt) controller.patch({ open: true });
                    else void controller?.choose(action, action === "job" ? jobId : "", action === "job" ? name : "");
                  };

                  if (beforeChoose) beforeChoose(choose);
                  else choose();
                }}
              />
            );
          })}
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
