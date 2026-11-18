import type { ModuleId } from "@canopy/domain";
import type { TestGateway } from "./gateway.ts";

export async function setModules(gateway: TestGateway, ...enabled: ModuleId[]) {
  const { user } = await gateway.api.getSettings({});
  await gateway.api.updateUserSettings({ expectedVersion: user!.version, modules: { enabled } });
}
