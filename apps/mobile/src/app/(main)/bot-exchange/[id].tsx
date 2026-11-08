import { useLocalSearchParams } from "expo-router";
import { BotExchangeScreen } from "../../../features/bots/BotExchangeScreen";

export default function BotExchangeRoute() {
  const { id, botId } = useLocalSearchParams<{ id: string; botId?: string }>();

  return <BotExchangeScreen key={id} id={id} botId={botId} />;
}
