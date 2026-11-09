import { useState } from "react";
import { Text, View } from "react-native";
import { ConnectError } from "@connectrpc/connect";
import { router } from "expo-router";
import { bots } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { useSession } from "../../state/session";
import { Button, Field, Notice } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { RequestCountdown } from "../../ui/RequestCountdown";
import { PickerSheet } from "../../ui/Picker";
import { styles, useColors } from "../../ui/theme";
import Animated from "react-native-reanimated";
import { useMotion } from "../../ui/motion";
import { Swap } from "../../ui/MotionViews";
import { BotApprovalPolicy } from "./BotApprovalPolicy";

type ApprovalCardProps = {
  approval: bots.BotApproval;
  readOnly?: boolean;
  onAnswer?: ((request: bots.AnswerBotApprovalRequest) => Promise<bots.AnswerBotApprovalResponse>) | undefined;
};

function useApprovalResponse({ approval, readOnly = false, onAnswer }: ApprovalCardProps) {
  const { client } = useSession();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The gateway refused a late answer: the request expired before its update arrived.
  const [late, setLate] = useState(false);

  async function respond(approve: boolean, text = answer, ruleOptionId = "") {
    if (readOnly || approval.status !== "pending") return;
    setBusy(true);
    setError("");

    try {
      const request = create(bots.AnswerBotApprovalRequestSchema, {
        approvalId: approval.id,
        approve,
        answer: text,
        ruleOptionId,
      });

      await (onAnswer ? onAnswer(request) : client!.api.answerBotApproval(request));
    } catch (cause: unknown) {
      if (ConnectError.from(cause).rawMessage.includes("This request expired.")) setLate(true);
      else setError("Could not send your response. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return { answer, setAnswer, busy, error, late, respond };
}

export function ApprovalCard({ approval, readOnly = false, onAnswer }: ApprovalCardProps) {
  const c = useColors();
  const { answer, setAnswer, busy, error, late, respond } = useApprovalResponse({ approval, readOnly, onAnswer });
  const [rules, setRules] = useState(false);
  const question = approval.kind === "question";
  const expired = late || approval.status === "expired";
  const { rise } = useMotion();

  if (approval.allowedByRule)
    return (
      <Text style={[styles.meta, { color: c.muted, paddingVertical: 8 }]}>
        {approval.prompt.split("\n")[0]?.replace(/^Needs approval · /, "")} ·{" "}
        <Text
          accessibilityRole="link"
          style={{ color: c.accent }}
          onPress={() =>
            router.push({ pathname: "/bot/[id]", params: { id: approval.botId, rule: approval.allowedByRule!.id } })
          }
        >
          Allowed by rule: {approval.allowedByRule.label}
        </Text>
      </Text>
    );

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c.line,
        borderRadius: 16,
        padding: 16,
        gap: 12,
        backgroundColor: c.surface,
      }}
    >
      <View style={styles.row}>
        <Icon name={question ? "hand-raised" : "shield-exclamation"} color={c.warning} />
        <Text numberOfLines={1} style={[styles.label, { flex: 1, color: c.text }]}>
          {question ? "Question" : "Approval required"}
        </Text>
        <RequestCountdown expiresAt={approval.expiresAt} pending={!expired} style={{ textAlign: "right" }} />
      </View>
      {!question && (
        <BotApprovalPolicy
          botId={approval.botId}
          disabled={readOnly || busy || approval.status !== "pending" || expired}
        />
      )}
      <Text selectable style={[styles.body, { color: c.text }]}>
        {approval.prompt}
      </Text>
      {question && !expired && (
        <Animated.View exiting={rise.exiting} style={{ gap: 12 }}>
          {approval.options.map((o) => (
            <Button key={o} title={o} busy={busy} disabled={readOnly} onPress={() => void respond(true, o)} />
          ))}
          <Field label="Your answer" value={answer} onChangeText={setAnswer} editable={!readOnly} multiline />
        </Animated.View>
      )}
      {error ? <Notice error>{error}</Notice> : null}
      {late && <Notice>This request expired. No answer was sent.</Notice>}
      {approval.threadId && (
        <Button
          title="Open thread"
          onPress={() => router.push({ pathname: "/thread/[id]", params: { id: approval.threadId } })}
        />
      )}
      {!expired && approval.ruleOptions.length > 0 && (
        <Button title="Always allow…" disabled={readOnly || busy} onPress={() => setRules(true)} />
      )}
      <ApprovalRulePicker
        approval={approval}
        visible={rules}
        onClose={() => setRules(false)}
        onSelect={(id) => void respond(true, "", id)}
      />
      <ApprovalActions
        expired={expired}
        question={question}
        busy={busy}
        readOnly={readOnly}
        canSend={!question || Boolean(answer.trim())}
        respond={(approve) => void respond(approve)}
      />
    </View>
  );
}

/** The card's answer buttons; expiry swaps them for its note (web `swap`). */
function ApprovalActions({
  expired,
  question,
  busy,
  readOnly,
  canSend,
  respond,
}: {
  expired: boolean;
  question: boolean;
  busy: boolean;
  readOnly: boolean;
  canSend: boolean;
  respond: (approve: boolean) => void;
}) {
  const c = useColors();

  return (
    <Swap value={expired ? "expired" : "open"}>
      {expired ? (
        <Text accessibilityRole="text" style={[styles.meta, { minHeight: 44, paddingVertical: 12, color: c.muted }]}>
          Expired. The bot no longer needs an answer.
        </Text>
      ) : (
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Button
              title={question ? "Skip" : "Discard"}
              busy={busy}
              disabled={readOnly}
              onPress={() => respond(false)}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              variant="primary"
              title={question ? "Send answer" : "Approve"}
              disabled={readOnly || !canSend}
              busy={busy}
              onPress={() => respond(true)}
            />
          </View>
        </View>
      )}
    </Swap>
  );
}

function ApprovalRulePicker({
  approval,
  visible,
  onClose,
  onSelect,
}: {
  approval: bots.BotApproval;
  visible: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <PickerSheet
      title="Always allow an action"
      visible={visible}
      onClose={onClose}
      sections={[
        {
          options: approval.ruleOptions.map((rule) => ({
            value: rule.id,
            label: `Always allow ${rule.label}`,
            wrapLabel: true,
          })),
        },
      ]}
      onSelect={onSelect}
    />
  );
}
