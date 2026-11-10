import { useEffect, useState } from "react";
import { MentionKind, type bots, type connectors } from "@canopy/contracts";
import { fuzzyRank } from "@canopy/domain/mentions";
import { splitId } from "@canopy/domain/computers";
import { useSession } from "../../state/session";
import { MentionOptions } from "../composer/MentionSuggestions";
import type { ActiveTrigger, MentionOption } from "../composer/useMentionSuggestions";

export function BotMentionSuggestions({
  id,
  trigger,
  disabled,
  onPick,
}: {
  id: string;
  trigger: ActiveTrigger | undefined;
  disabled: boolean;
  onPick: (option: MentionOption) => void;
}) {
  const { client, bots } = useSession();
  const [catalog, setCatalog] = useState<{ id: string; list?: connectors.ListConnectorsResponse; error?: string }>();
  const local = !splitId(id).node;

  useEffect(() => {
    if (!client || !local) return;
    let active = true;
    void client.api.listConnectors({ botId: id }).then(
      (list) => active && setCatalog({ id, list }),
      () => active && setCatalog({ id, error: "Could not load connectors. Reopen this chat to retry." }),
    );

    return () => {
      active = false;
    };
  }, [client, id, local]);

  if (disabled || trigger?.char !== "@") return null;
  const list = catalog?.id === id ? catalog.list : undefined;
  const options = botOptions(bots, id, trigger.query);

  const label = (a: connectors.ConnectorAccount) =>
    `${list?.types.find((t) => t.id === a.connectorType)?.name ?? a.connectorType} · ${a.name}`;

  options.push(
    ...fuzzyRank(
      trigger.query,
      list?.accounts.filter((a) => a.status === "connected") ?? [],
      (a) => [label(a)],
      40,
    ).map(({ item }): MentionOption => ({
      key: `connector:${item.id}`,
      mention: {
        kind: MentionKind.CONNECTOR,
        name: item.id,
        label: label(item),
        source: item.connectorType,
        path: "",
        isDir: false,
      },
      title: label(item),
      detail: "Use this connected account",
      group: "Connectors",
    })),
  );

  return (
    <MentionOptions
      queryKey={`@:${trigger.query}`}
      options={options}
      loading={!options.length && local && catalog?.id !== id}
      error={catalog?.id === id ? catalog.error : undefined}
      empty="No bots or connectors match."
      onPick={onPick}
    />
  );
}

function botOptions(bots: readonly bots.Bot[], id: string, query: string): MentionOption[] {
  return fuzzyRank(
    query,
    bots.filter((b) => b.id !== id && !b.archived && splitId(b.id).node === splitId(id).node),
    (b) => [b.configuration?.name ?? ""],
    40,
  ).map(({ item }) => ({
    key: `bot:${item.id}`,
    mention: {
      kind: MentionKind.BOT,
      name: item.id,
      label: item.configuration?.name || "Bot",
      source: "",
      path: "",
      isDir: false,
    },
    title: item.configuration?.name || "Bot",
    detail: item.configuration?.model ?? "",
    group: "Bots",
  }));
}
