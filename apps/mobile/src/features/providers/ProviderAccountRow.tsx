import { useState } from "react";
import { Text, View } from "react-native";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Provider, type ProviderAccountStatus } from "@canopy/contracts";
import { formatRelative } from "@canopy/domain/format";
import { accountStateLabel, harnessName, hasAccountStatus } from "@canopy/domain/provider-instances";
import { useSession } from "../../state/session";
import { IconButton } from "../../ui/components";
import { Sensitive } from "../../ui/Sensitive";
import { styles, useColors } from "../../ui/theme";

const WEEK = 7 * 86_400_000;

/**
 * One line about an instance's account on a worker (web: AccountStatusRow): state · method · plan · organization ·
 * masked email · expiry · checked, then Refresh. Proxy instances read "Proxy · <name>". Nothing when the harness
 * reports nothing (Grok, a missing CLI).
 */
export function ProviderAccountRow({
  account,
  workerId,
  harness,
  id,
  online,
  now,
}: {
  account: ProviderAccountStatus | undefined;
  workerId: string;
  harness: Provider;
  id: string;
  online: boolean;
  now: number;
}) {
  const c = useColors();
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  if (!hasAccountStatus(account, harness)) return null;
  const expiry = account.expiresAt ? timestampDate(account.expiresAt) : undefined;

  const status =
    accountStateLabel(account, now) ||
    (harness === Provider.ANTIGRAVITY && !account.authMethod ? "Sign-in status unknown" : "");

  const expired = account.state === "expired" || (!!expiry && expiry.getTime() <= now);
  const soon = !!expiry && !expired && expiry.getTime() - now < WEEK;
  const warn = expired || account.state === "signed_out" || account.state === "error";
  const proxy = account.authMethod === "Proxy";

  const parts: { text: string; color?: string }[] = proxy
    ? [
        { text: "Proxy", color: c.text },
        { text: account.proxyName },
        { text: account.state === "signed_in" ? "" : "Needs setup", color: c.warning },
      ]
    : [
        { text: status, color: warn ? c.warning : c.text },
        { text: account.authMethod },
        { text: account.plan ? account.plan.charAt(0).toUpperCase() + account.plan.slice(1) : "" },
        { text: account.organization },
      ];

  const tail = [
    !proxy && expiry && !expired
      ? {
          text: `expires ${soon ? formatRelative(account.expiresAt, now) : expiry.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`,
          color: soon ? c.warning : undefined,
        }
      : undefined,
    account.checkedAt ? { text: `checked ${formatRelative(account.checkedAt, now)}`, color: c.muted } : undefined,
  ].filter((part) => part !== undefined);

  const shown = parts.filter((part) => part.text);
  const email = !proxy && account.email ? account.email : "";

  async function refresh() {
    if (!client) return;
    setBusy(true);
    setFailure("");

    try {
      const result = await client.api.refreshProviders({ workerId, harness, id, accountOnly: true });
      setFailure(result.skipped.length ? "The worker could not refresh this account. Try again." : "");
    } catch {
      setFailure("Could not refresh account status. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 2, minWidth: 0 }}>
      <View style={[styles.row, { alignItems: "center", gap: 4 }]}>
        <Text style={[styles.chrome, { flex: 1, minWidth: 0, color: c.soft }]}>
          {shown.map((part, index) => (
            <Text key={`${index}:${part.text}`} style={part.color ? { color: part.color } : undefined}>
              {index ? " · " : ""}
              {part.text}
            </Text>
          ))}
          {email ? (
            <Text>
              {shown.length ? " · " : ""}
              <Sensitive value={email} label="Account email" />
            </Text>
          ) : null}
          {tail.map((part) => (
            <Text key={part.text} style={part.color ? { color: part.color } : undefined}>
              {" · "}
              {part.text}
            </Text>
          ))}
        </Text>
        {harness !== Provider.GROK ? (
          <IconButton
            icon="arrow-path"
            size="sm"
            busy={busy}
            disabled={!online}
            label={online ? `Refresh ${harnessName(harness)} account status` : "Worker is offline"}
            onPress={() => void refresh()}
          />
        ) : null}
      </View>
      {account.configDir ? (
        <Text style={[styles.workMeta, { color: c.muted }]}>
          Config directory <Sensitive value={account.configDir} label="Configuration directory" />
        </Text>
      ) : null}
      {account.detail ? <Text style={[styles.workMeta, { color: c.muted }]}>{account.detail}</Text> : null}
      {failure ? (
        <Text accessibilityRole="alert" style={[styles.workMeta, { color: c.warning }]}>
          {failure}
        </Text>
      ) : null}
    </View>
  );
}
