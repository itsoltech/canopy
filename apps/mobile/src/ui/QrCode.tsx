import QRCode from "qrcode";
import Svg, { Path, Rect } from "react-native-svg";

/** Encode locally: pairing secrets never leave the gateway/client connection. */
export function QrCode({ value }: { value: string }) {
  const { modules } = QRCode.create(value, { errorCorrectionLevel: "M" });
  const paths: string[] = [];

  for (let y = 0; y < modules.size; y++) {
    for (let x = 0; x < modules.size; x++) {
      if (modules.get(y, x)) paths.push(`M${x + 2} ${y + 2}h1v1h-1z`);
    }
  }

  return (
    <Svg
      accessibilityLabel="Pairing QR code"
      width={260}
      height={260}
      viewBox={`0 0 ${modules.size + 4} ${modules.size + 4}`}
    >
      <Rect width="100%" height="100%" fill="#ffffff" />
      <Path d={paths.join("")} fill="#000000" />
    </Svg>
  );
}
