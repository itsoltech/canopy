import { useLocalSearchParams } from "expo-router";
import { BotChatScreen } from "../../features/bots/BotChatScreen";

export default function BotRoute() {
  const { id, rule } = useLocalSearchParams<{ id: string; rule?: string }>();

  return <BotChatScreen key={id} id={id} rule={rule} />;
}
