import { File, Paths } from "expo-file-system";
import { parseDeviceAppearance, type DeviceAppearance } from "@canopy/domain";

const appearanceFile = () => new File(Paths.document, "device-appearance.json");
const pendingFile = () => new File(Paths.document, "device-appearance.pending");

export async function loadDeviceAppearance() {
  const file = appearanceFile();

  if (file.exists) return parseDeviceAppearance(await file.text());

  // iOS removes the destination before moving the replacement. Recover an interrupted replacement.
  const pending = pendingFile();
  const values = parseDeviceAppearance(pending.exists ? await pending.text() : null);

  if (values)
    await pending.move(file).catch((error) => {
      if (!file.exists) throw error;
    });

  return values;
}

export async function saveDeviceAppearance(values: DeviceAppearance) {
  const pending = pendingFile();
  await pending.write(JSON.stringify(values));
  await pending.move(appearanceFile(), { overwrite: true });
}
