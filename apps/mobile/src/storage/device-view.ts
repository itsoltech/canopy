import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { deviceViewStorageKey } from "@canopy/domain/device-view";

const viewFile = (scope: string) => new File(Paths.document, `${deviceViewStorageKey(scope)}.json`);

/** Filters may exceed SecureStore's value limit; keep view state in the existing document storage. */
export async function loadDeviceView(scope: string): Promise<string | null> {
  const file = viewFile(scope);

  if (file.exists) return file.text();

  return SecureStore.getItemAsync("canopy.settings.view.v1");
}

export async function saveDeviceView(scope: string, raw: string): Promise<void> {
  const file = viewFile(scope);

  if (!file.exists) file.create();
  await file.write(raw);
}
