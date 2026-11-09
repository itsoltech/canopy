import { Text, View } from "react-native";
import { InteractionKind, type Item, type ui } from "@canopy/contracts";
import { humanizeToolName } from "@canopy/domain/humanize";
import { parseObject, str } from "@canopy/domain/json";
import { Button, Notice } from "../../ui/components";
import { RequestCountdown } from "../../ui/RequestCountdown";
import { styles, useColors, useTypography } from "../../ui/theme";
import { useInteractionAnswer } from "./useInteractionAnswer";
import { ElicitationForm } from "./ElicitationForm";

/** Permission decisions use the same gateway-enforced session grant as the web. */
export function InteractionCard({ interaction, related }: { interaction: ui.Interaction; related?: Item }) {
  const c = useColors();
  const answer = useInteractionAnswer(interaction);
  const permission = interaction.kind === InteractionKind.PERMISSION;

  return (
    <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={[styles.label, { color: c.text }]}>
        {permission ? `Allow ${humanizeToolName(interaction.toolName)}?` : "The agent needs some details"}
      </Text>
      <RequestCountdown expiresAt={interaction.expiresAt} pending={!answer.ended && interaction.status === "pending"} />
      {interaction.routedTo === "parent" && <Notice>The parent agent can answer. You can step in.</Notice>}
      {permission ? (
        <>
          <PermissionDetails interaction={interaction} related={related} />
          <Button
            title="Allow"
            variant="primary"
            disabled={answer.disabled}
            busy={answer.busy}
            onPress={() => void answer.respond({ allow: true })}
          />
          <Button
            title="Deny"
            variant="danger"
            disabled={answer.disabled}
            onPress={() => void answer.respond({ allow: false, message: "Denied by the user" })}
          />
          <Button
            title="Allow for this session"
            disabled={answer.disabled}
            onPress={() => void answer.respond({ allow: true, allowForSession: true })}
          />
        </>
      ) : (
        <ElicitationForm requestJson={interaction.requestJson} answer={answer} />
      )}
      {answer.error ? <Notice error={!answer.ended}>{answer.error}</Notice> : null}
      {!answer.online && <Notice>Reconnect to respond. Your draft stays here.</Notice>}
      {answer.done && <Notice>Response sent. Check the thread for details.</Notice>}
    </View>
  );
}

function PermissionDetails({ interaction, related }: { interaction: ui.Interaction; related?: Item }) {
  const c = useColors();
  const type = useTypography();
  const request = parseObject(interaction.requestJson);

  const command =
    str(request["command"]) || (related?.content.case === "commandExecution" ? related.content.value.command : "");

  const changes = related?.content.case === "fileChange" ? related.content.value.changes : [];

  return (
    <View style={{ gap: 8 }}>
      {str(request["reason"]) ? (
        <Text selectable style={[styles.body, { color: c.text }]}>
          {str(request["reason"])}
        </Text>
      ) : null}
      {command ? (
        <>
          <Text selectable style={[type.mono, { color: c.text }]}>
            {command}
          </Text>
          {str(request["cwd"]) ? (
            <Text selectable style={[styles.meta, { color: c.muted }]}>
              {str(request["cwd"])}
            </Text>
          ) : null}
        </>
      ) : changes.length ? (
        changes.map((change, index) => (
          <View key={index} style={{ gap: 8 }}>
            <Text selectable style={[styles.meta, { color: c.text }]}>
              {change.kind} · {change.path}
            </Text>
            {change.diff ? (
              <Text selectable style={[type.mono, { color: c.body }]}>
                {change.diff}
              </Text>
            ) : null}
          </View>
        ))
      ) : null}
      {!command && !changes.length && (
        <Text selectable style={[type.mono, { color: c.body }]}>
          {JSON.stringify(request, null, 2) || interaction.requestJson}
        </Text>
      )}
    </View>
  );
}
