import Svg, { Circle, Ellipse, Path } from "react-native-svg";
import { defaultAppearance, eyeColor, mascotFor, mascotShapes, normalizeColor } from "@canopy/ui/mascot";
import type { bots } from "@canopy/contracts";
import { palette } from "@canopy/ui";

function isPaletteTone(tone: string | undefined): tone is keyof typeof palette {
  return tone !== undefined && tone in palette;
}

export function BotAvatar({ bot, size = 40 }: { bot: bots.Bot; size?: number }) {
  const config = bot.configuration;

  return <MascotAvatar id={bot.id} name={config?.name} shape={config?.shape} color={config?.color} size={size} />;
}

/** A bot's mascot from its shape and colour (a chat participant, the sender of a thread message). */
export function MascotAvatar({
  id,
  name,
  shape,
  color,
  size = 40,
}: {
  id: string;
  name?: string | undefined;
  shape?: string | undefined;
  color?: string | undefined;
  size?: number;
}) {
  const legacy = !color ? mascotFor(id, shape) : undefined;
  const body = legacy?.shape ?? mascotShapes.find((s) => s.id === shape) ?? mascotShapes[0];
  const tone = legacy?.tone.body.split("-")[1];

  const fill =
    normalizeColor(color ?? "") ?? (isPaletteTone(tone) ? palette[tone]?.[400] : undefined) ?? defaultAppearance.color;

  const eyes = eyeColor(fill);

  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" accessibilityLabel={name}>
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
          <Ellipse key={x} cx={x} cy={body.eyeY} rx={legacy ? 1.9 : 2.1} ry={legacy ? 1.9 : 3.2} fill={eyes} />
        ),
      )}
      {legacy?.eyes === "round" &&
        [16, 24].map((x) => <Circle key={x} cx={x + legacy.gaze * 0.9} cy={body.eyeY + 0.4} r={1.6} fill="#09090b" />)}
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
