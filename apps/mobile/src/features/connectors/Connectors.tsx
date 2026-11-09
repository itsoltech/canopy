import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { connectors } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useSharedQuery } from "../../state/queries";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";
import { Chevron, Expand } from "../../ui/MotionViews";

/** Status labels as on the web (apps/web features/connectors/api.ts). */
const accountStatus = (status: string) =>
  new Map([
    ["connected", "Connected"],
    ["needs_reconnect", "Needs reconnect"],
    ["error", "Connection error · Tools unavailable"],
    ["disconnected", "Disconnected"],
  ]).get(status) ?? status;

const accountLabel = (account: connectors.ConnectorAccount, types: readonly connectors.ConnectorType[]) =>
  `${types.find((t) => t.id === account.connectorType)?.name ?? account.connectorType} · ${account.name}`;

/**
 * Your connector accounts, or the ones a thread or bot can use; `list` is undefined while loading. Shared by every
 * screen showing the same scope and read again when connectors change on any device.
 */
export function useConnectors(threadId?: string, botId?: string) {
  const { client } = useSession();
  const scope = threadId ? `thread=${threadId}` : botId ? `bot=${botId}` : "";

  const read = useSharedQuery(
    scope ? `ListConnectors:${scope}` : "ListConnectors",
    () => client!.api.listConnectors({ threadId: threadId ?? "", botId: botId ?? "" }),
    Boolean(client),
  );

  return { list: read.data, error: read.error ? "Could not load connectors." : "" };
}

/** Connector accounts with their status; a failed test shows its reason and, on request, the details. */
export function ConnectorList({ list }: { list: connectors.ListConnectorsResponse }) {
  return (
    <View style={{ gap: 12 }}>
      {list.accounts.map((account) => (
        <ConnectorRow key={account.id} account={account} types={list.types} />
      ))}
    </View>
  );
}

function ConnectorRow({
  account,
  types,
}: {
  account: connectors.ConnectorAccount;
  types: readonly connectors.ConnectorType[];
}) {
  const c = useColors();
  const warn = account.status !== "connected";

  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.row, { alignItems: "flex-start" }]}>
        <Icon name="link" color={c.muted} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={[styles.label, { color: c.text }]}>
            {accountLabel(account, types)}
          </Text>
          <Text style={[styles.meta, { color: warn ? c.warning : c.muted }]}>{accountStatus(account.status)}</Text>
        </View>
      </View>
      {account.status === "error" && account.error ? <ConnectionError error={account.error} /> : null}
    </View>
  );
}

/** The redacted test failure: its message, then "Show details" for the technical part. */
function ConnectionError({ error }: { error: connectors.ConnectorError }) {
  const c = useColors();
  const [open, setOpen] = useState(false);

  return (
    <View accessibilityRole="alert" style={{ gap: 8, padding: 12, borderRadius: 12, backgroundColor: c.inset }}>
      <Text selectable style={[styles.meta, { color: c.danger }]}>
        {error.message}
      </Text>
      {error.detail ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(!open)}
            style={[styles.row, { gap: 4, minHeight: 32 }]}
          >
            <Chevron open={open} size={14} color={c.muted} />
            <Text style={[styles.meta, { color: c.muted }]}>Show details</Text>
          </Pressable>
          <Expand open={open}>
            <Text selectable style={[styles.caption, { color: c.body, fontFamily: "monospace" }]}>
              {error.detail}
            </Text>
          </Expand>
        </>
      ) : null}
    </View>
  );
}
