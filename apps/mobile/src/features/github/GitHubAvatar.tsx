import { useState } from "react";
import { Image, Text, View } from "react-native";
import { useColors, useTypography } from "../../ui/theme";

export function GitHubAvatar({ userId, login, compact = false }: { userId: string; login: string; compact?: boolean }) {
  const c = useColors();
  const type = useTypography();
  const [failed, setFailed] = useState(false);
  const size = compact ? 22 : 32;

  return (
    <View
      accessible={false}
      style={{
        width: size,
        height: size,
        borderRadius: 16,
        overflow: "hidden",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.inset,
      }}
    >
      <Text style={[type.meta, { color: c.muted, fontSize: compact ? 10 : type.meta.fontSize }]}>
        {login.slice(0, 2).toUpperCase()}
      </Text>
      {!failed && /^[1-9][0-9]*$/.test(userId) && (
        <Image
          source={{ uri: `https://avatars.githubusercontent.com/u/${userId}?s=64` }}
          onError={() => setFailed(true)}
          style={{ position: "absolute", width: size, height: size }}
        />
      )}
    </View>
  );
}
