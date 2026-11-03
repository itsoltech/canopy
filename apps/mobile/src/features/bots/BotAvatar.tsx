import Svg, { Circle, Ellipse, Path } from "react-native-svg";
import {
  defaultAppearance,
  eyeColor,
  mascotFor,
  mascotShapes,
  normalizeColor,
} from "@canopy/ui/mascot";
import type { bots } from "@canopy/contracts";
import { palette } from "@canopy/ui";

export function BotAvatar({
  bot,
  size = 40,
}: {
  bot: bots.Bot;
  size?: number;
}) {
  const config = bot.configuration;
  const legacy = !config?.color ? mascotFor(bot.id, config?.shape) : undefined;
  const body =
    legacy?.shape ??
    mascotShapes.find((s) => s.id === config?.shape) ??
    mascotShapes[0];
  const tone = legacy?.tone.body.split("-")[1] as
    keyof typeof palette | undefined;
  const fill =
    normalizeColor(config?.color ?? "") ??
    (tone && palette[tone]?.[400]) ??
    defaultAppearance.color;
  const eyes = eyeColor(fill);
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      accessibilityLabel={config?.name}
    >
      <Path d={body.body} fill={fill} />
      {[16, 24].map((x) =>
        legacy?.eyes === "happy" ? (
          <Path
            key={x}
            d={`M${x - 2.4} ${body.eyeY + 0.8}q2.4 -3 4.8 0`}
            stroke={eyes}
            strokeWidth={1.6}
            fill="none"
            strokeLinecap="round"
          />
        ) : legacy?.eyes === "round" ? (
          <Circle key={x} cx={x} cy={body.eyeY} r={3.2} fill="#ffffff" />
        ) : (
          <Ellipse
            key={x}
            cx={x}
            cy={body.eyeY}
            rx={legacy ? 1.9 : 2.1}
            ry={legacy ? 1.9 : 3.2}
            fill={eyes}
          />
        ),
      )}
      {legacy?.eyes === "round" &&
        [16, 24].map((x) => (
          <Circle
            key={x}
            cx={x + legacy.gaze * 0.9}
            cy={body.eyeY + 0.4}
            r={1.6}
            fill="#09090b"
          />
        ))}
      {legacy?.smile && (
        <Path
          d={`M17.5 ${body.eyeY + 4.5}q2.5 2.2 5 0`}
          stroke={eyes}
          strokeWidth={1.4}
          fill="none"
          strokeLinecap="round"
        />
      )}
    </Svg>
  );
}
