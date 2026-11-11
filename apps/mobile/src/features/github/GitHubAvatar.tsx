import { useState } from "react";
import { Image, Text, View } from "react-native";
import { useColors, useTypography } from "../../ui/theme";

export function GitHubAvatar({ userId, login }: { userId: string; login: string }) {
  const c = useColors();
  const type = useTypography();
  const [failed, setFailed] = useState(false);

  return (
    <View
      accessible={false}
      style={{
        width: 32,
        height: 32,
        borderRadius: 16,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.inset,
      }}
    >
      <Text style={[type.meta, { color: c.muted }]}>{login.slice(0, 2).toUpperCase()}</Text>
      {!failed && /^[1-9][0-9]*$/.test(userId) && (
        <Image
          source={{ uri: `https://avatars.githubusercontent.com/u/${userId}?s=64` }}
          onError={() => setFailed(true)}
          style={{ position: "absolute", width: 32, height: 32 }}
        />
      )}
    </View>
  );
}
