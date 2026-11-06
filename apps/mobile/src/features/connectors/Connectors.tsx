import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { connectors } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

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

/** Your connector accounts, or the ones a thread can use (`threadId`); `list` is undefined while loading. */
export function useConnectors(threadId?: string) {
  const { client } = useSession();
  const [list, setList] = useState<connectors.ListConnectorsResponse>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    if (client)
      void client.api
        .listConnectors({ threadId: threadId ?? "" })
        .then((r) => {
          if (active) setList(r);
        })
        .catch(() => {
          if (active) setError("Could not load connectors.");
        });

    return () => {
      active = false;
    };
  }, [client, threadId]);

  return { list, error };
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
            <Icon name={open ? "chevron-down" : "chevron-right"} size={14} color={c.muted} />
            <Text style={[styles.meta, { color: c.muted }]}>Show details</Text>
          </Pressable>
          {open && (
            <Text selectable style={[styles.caption, { color: c.body, fontFamily: "monospace" }]}>
              {error.detail}
            </Text>
          )}
        </>
      ) : null}
    </View>
  );
}
