import { useState } from "react";
import { Text, View } from "react-native";
import { ConnectError } from "@connectrpc/connect";
import type { bots } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Field, Notice } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { RequestCountdown } from "../../ui/RequestCountdown";
import { styles, useColors } from "../../ui/theme";

export function ApprovalCard({ approval }: { approval: bots.BotApproval }) {
  const c = useColors();
  const { client } = useSession();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The gateway refused a late answer: the request expired before its update arrived.
  const [late, setLate] = useState(false);
  const question = approval.kind === "question";
  const expired = late || approval.status === "expired";

  async function respond(approve: boolean, text = answer) {
    setBusy(true);
    setError("");

    try {
      await client!.api.answerBotApproval({
        approvalId: approval.id,
        approve,
        answer: text,
      });
    } catch (cause: unknown) {
      if (ConnectError.from(cause).rawMessage.includes("This request expired.")) setLate(true);
      else setError("Could not send your response. Try again.");
    } finally {
      setBusy(false);
    }
  }

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
      <Text selectable style={[styles.body, { color: c.text }]}>
        {approval.prompt}
      </Text>
      {question && !expired && (
        <>
          {approval.options.map((o) => (
            <Button key={o} secondary title={o} busy={busy} onPress={() => void respond(true, o)} />
          ))}
          <Field label="Your answer" value={answer} onChangeText={setAnswer} multiline />
        </>
      )}
      {error ? <Notice error>{error}</Notice> : null}
      {late && <Notice>This request expired. No answer was sent.</Notice>}
      {expired ? (
        <Text accessibilityRole="text" style={[styles.meta, { minHeight: 44, paddingVertical: 12, color: c.muted }]}>
          Expired. The bot no longer needs an answer.
        </Text>
      ) : (
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Button
              title={question ? "Dismiss" : "Decline"}
              secondary
              busy={busy}
              onPress={() => void respond(false)}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title={question ? "Send answer" : "Approve"}
              disabled={question && !answer.trim()}
              busy={busy}
              onPress={() => void respond(true)}
            />
          </View>
        </View>
      )}
    </View>
  );
}
