import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import type { Tone } from "@canopy/domain/status-look";
import { Button } from "../../ui/Button";
import { Badge } from "../../ui/Badge";
import { Icon } from "../../ui/Icon";
import { styles, useColors, useTypography } from "../../ui/theme";
import { useCopyText } from "../viewers/useCopyText";

function connectionLabel(status: string) {
  switch (status) {
    case "needs_reconnect":
      return "Needs reconnect";
    case "error":
      return "Connection error · Tools unavailable";
    case "disconnected":
      return "Disconnected";
    default:
      return status;
  }
}

/** Only a known session state gets a badge, matching the web thread panel. */
function sessionLook(account: ui.ThreadConnector): { label: string; tone: Tone; hint?: string } | undefined {
  if (account.status !== "connected") return { label: connectionLabel(account.status), tone: "amber" };

  switch (account.sessionState) {
    case "available":
      return { label: "Available", tone: "emerald" };
    case "pending":
      return { label: "Available next turn", tone: "sky" };
    case "pending_removal":
      return { label: "Access removed", tone: "amber", hint: "Tools update next turn" };
    case "unavailable":
      return { label: "Unavailable", tone: "neutral", hint: "No tools available" };
    case "failed":
      return { label: "Error", tone: "rose" };
    default:
      return undefined;
  }
}

export function ThreadConnectorRow({ account }: { account: ui.ThreadConnector }) {
  const c = useColors();
  const type = useTypography();
  const [details, setDetails] = useState(false);
  const look = sessionLook(account);
  const name = `${account.connectorName} · ${account.accountLabel}`;
  const detail = account.status === "connected" && account.sessionState === "failed" ? account.sessionDetail : "";
  const { copy } = useCopyText(detail);

  return (
    <View style={{ gap: 2, minWidth: 0, paddingVertical: 4 }}>
      <View style={[styles.row, { minHeight: 36, flexWrap: "wrap", rowGap: 4 }]}>
        <View style={[styles.row, { flexGrow: 1, flexShrink: 1, flexBasis: 144, minWidth: 0 }]}>
          <Icon name="link" />
          <Text numberOfLines={1} style={[type.chrome, { minWidth: 0, flexShrink: 1, color: c.text }]}>
            {name}
          </Text>
        </View>
        {look ? <Badge tone={look.tone}>{look.label}</Badge> : null}
      </View>
      {look?.hint ? <Text style={[type.meta, { color: c.muted, paddingLeft: 24 }]}>{look.hint}</Text> : null}
      {detail ? (
        <View style={{ paddingLeft: 24, gap: 4 }}>
          <Button
            title={details ? "Hide details" : "Show details"}
            variant="text"
            size="sm"
            onPress={() => setDetails(!details)}
          />
          {details && (
            <>
              <Text selectable style={[type.meta, { color: c.muted }]}>
                {detail}
              </Text>
              <Button title="Copy details" variant="text" size="sm" onPress={() => void copy()} />
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}
