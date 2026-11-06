import { useState } from "react";
import { Text, View } from "react-native";
import { ConnectError } from "@connectrpc/connect";
import { Provider, type ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Field } from "../../ui/components";
import { Overlay } from "../../ui/Overlay";
import { styles, useColors } from "../../ui/theme";

/** The gateway's limit on an objective. */
const OBJECTIVE_LIMIT = 4000;

/** Status labels as on the web (apps/web features/goals/goals.ts). */
const goalLabels = new Map([
  ["active", "Active"],
  ["paused", "Paused"],
  ["blocked", "Blocked"],
  ["budget_limited", "Budget reached"],
  ["usage_limited", "Usage limit"],
  ["achieved", "Achieved"],
  ["cancelled", "Cleared"],
]);

export const isFinishedGoal = (status: string) => status === "achieved" || status === "cancelled";

/** Goals belong to the harness: a gateway thread and Grok have none (docs/goals.md). */
export const takesGoals = (thread: ui.Thread) => thread.runtime !== "gateway" && thread.provider !== Provider.GROK;

const failure = (cause: unknown) => ConnectError.from(cause).rawMessage;

/**
 * The thread's goal, as the web's goal bar and dialog offer it: the open goal with pause, resume and clear, and a
 * form that sets a goal or replaces the open one (Codex also takes a token budget).
 */
export function GoalSheet({
  thread,
  goal,
  visible,
  onClose,
}: {
  thread: ui.Thread | undefined;
  goal: ui.Goal | undefined;
  visible: boolean;
  onClose: () => void;
}) {
  const open = goal && !isFinishedGoal(goal.status) ? goal : undefined;

  return (
    <Overlay visible={visible} onClose={onClose} label="Goal">
      {thread && visible ? <GoalBody thread={thread} open={open} onClose={onClose} /> : null}
    </Overlay>
  );
}

function GoalBody({ thread, open, onClose }: { thread: ui.Thread; open: ui.Goal | undefined; onClose: () => void }) {
  const [replacing, setReplacing] = useState(false);

  if (open && !replacing) return <OpenGoal thread={thread} goal={open} onReplace={() => setReplacing(true)} />;

  return <GoalForm thread={thread} replacing={open} onDone={onClose} />;
}

function OpenGoal({ thread, goal, onReplace }: { thread: ui.Thread; goal: ui.Goal; onReplace: () => void }) {
  const c = useColors();
  const { client } = useSession();
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  async function act(action: "pause" | "resume" | "clear") {
    if (!client) return;
    setBusy(action);
    setError("");

    try {
      await client.api.setGoal({ threadId: thread.id, action });
      setConfirming(false);
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <View style={{ padding: 16, gap: 12 }}>
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Text accessibilityRole="header" style={[styles.overlayHeading, { color: c.muted }]}>
          Goal
        </Text>
        <Text style={[styles.overlayMeta, { color: goal.status === "active" ? c.sky : c.muted }]}>
          {goalLabels.get(goal.status) ?? goal.status}
        </Text>
      </View>
      <Text selectable style={[styles.overlay, { color: c.text }]}>
        {goal.objective}
      </Text>
      {goal.lastReason ? (
        <Text selectable style={[styles.overlayMeta, { color: c.muted }]}>
          Latest check: {goal.lastReason}
        </Text>
      ) : null}
      {error || goal.error ? (
        <Text accessibilityRole="alert" style={[styles.overlayMeta, { color: c.danger }]}>
          {error || goal.error}
        </Text>
      ) : null}
      {confirming ? (
        <View style={[styles.row, { justifyContent: "flex-end" }]}>
          <Button title="Keep" secondary disabled={Boolean(busy)} onPress={() => setConfirming(false)} />
          <Button title="Clear goal" danger busy={busy === "clear"} onPress={() => void act("clear")} />
        </View>
      ) : (
        <View style={[styles.row, { justifyContent: "flex-end", flexWrap: "wrap" }]}>
          <Button title="Clear the goal…" secondary disabled={Boolean(busy)} onPress={() => setConfirming(true)} />
          {goal.status === "active" ? (
            <Button title="Pause" secondary busy={busy === "pause"} onPress={() => void act("pause")} />
          ) : (
            <Button title="Resume" secondary busy={busy === "resume"} onPress={() => void act("resume")} />
          )}
          <Button title="Replace the goal…" disabled={Boolean(busy)} onPress={onReplace} />
        </View>
      )}
    </View>
  );
}

function GoalForm({
  thread,
  replacing,
  onDone,
}: {
  thread: ui.Thread;
  replacing: ui.Goal | undefined;
  onDone: () => void;
}) {
  const c = useColors();
  const { client } = useSession();
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Only Codex takes a token budget; Claude Code's /goal has none.
  const budgeted = thread.provider === Provider.CODEX;
  const tokens = budget.trim() ? Number(budget.trim()) : 0;
  const budgetError = budgeted && (!Number.isSafeInteger(tokens) || tokens < 0);

  const how =
    thread.provider === Provider.CLAUDE
      ? "Claude checks the goal after each turn and keeps working until it is met. Pausing interrupts the running turn."
      : "Codex keeps starting turns on its own until the goal is met, blocked or out of budget.";

  async function submit() {
    if (!client || !objective.trim() || budgetError) return;
    setBusy(true);
    setError("");

    try {
      await client.api.setGoal({
        threadId: thread.id,
        action: "set",
        objective: objective.trim(),
        ...(budgeted && tokens > 0 && { tokenBudget: BigInt(tokens) }),
      });
      onDone();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={[styles.heading, { color: c.text }]}>
          {replacing ? "Replace the goal" : "Set a goal"}
        </Text>
        <Text style={[styles.meta, { color: c.muted }]}>{how}</Text>
      </View>
      {replacing ? (
        <Text style={[styles.meta, { color: c.muted }]}>
          This replaces the current goal: “
          {replacing.objective.length > 160 ? `${replacing.objective.slice(0, 160)}…` : replacing.objective}”
        </Text>
      ) : null}
      <Field
        label="Goal"
        multiline
        autoFocus
        maxLength={OBJECTIVE_LIMIT}
        value={objective}
        onChangeText={setObjective}
        placeholder="All tests in packages/api pass and the build is green"
        style={{ minHeight: 96, maxHeight: 160, textAlignVertical: "top" }}
      />
      {budgeted ? (
        <View style={{ gap: 4 }}>
          <Field
            label="Token budget (optional)"
            keyboardType="number-pad"
            value={budget}
            onChangeText={setBudget}
            placeholder="No limit"
          />
          <Text style={[styles.meta, { color: budgetError ? c.danger : c.muted }]}>
            {budgetError
              ? "Enter a whole number of tokens, or leave it empty for no limit."
              : "Codex stops working on the goal once it has used this many tokens."}
          </Text>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={[styles.meta, { color: c.danger }]}>
          {error}
        </Text>
      ) : null}
      <View style={[styles.row, { justifyContent: "flex-end" }]}>
        <Button title="Cancel" secondary onPress={onDone} />
        <Button
          title={replacing ? "Replace goal" : "Set goal"}
          busy={busy}
          disabled={!objective.trim() || budgetError}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}
