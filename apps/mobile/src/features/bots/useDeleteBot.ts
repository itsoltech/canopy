import { router, useNavigationContainerRef } from "expo-router";
import { BOT_LIST, removeBotFromList } from "../../state/bot-list";
import { useSession } from "../../state/session";

export function useDeleteBot() {
  const { client, queries } = useSession();

  const getCurrentRoute: () => { name: string; params?: { id?: string } } | undefined =
    useNavigationContainerRef().getCurrentRoute;

  return async (id: string) => {
    if (!client) return;
    await client.api.deleteBot({ botId: id });

    if (queries.disposed) return;
    removeBotFromList(queries, id);
    queries.invalidate(BOT_LIST);

    // A sidebar action can finish while a different conversation is open.
    const route = getCurrentRoute();

    if (route?.name === "bot/[id]" && route.params?.id === id) router.dismissTo("/");
  };
}
