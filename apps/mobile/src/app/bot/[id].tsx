import { useLocalSearchParams } from "expo-router";
import { BotChatScreen } from "../../features/bots/BotChatScreen";

export default function BotRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return <BotChatScreen key={id} id={id} />;
}
