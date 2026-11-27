import mobilePush from "./0201_mobile_push.sql" with { type: "text" };
import mobilePushRelaySettings from "./0202_mobile_push_relay_settings.sql" with { type: "text" };
import managedMobilePush from "./0203_managed_mobile_push.sql" with { type: "text" };
import mobilePushRelayChoice from "./0204_mobile_push_relay_choice.sql" with { type: "text" };
import mobilePushRevocations from "./0205_mobile_push_revocations.sql" with { type: "text" };
import mobilePushManagedSelection from "./0206_mobile_push_managed_selection.sql" with { type: "text" };
import mobilePushDismissals from "./0221_mobile_push_dismissals.sql" with { type: "text" };
import { sqlFile } from "./run.ts";

export const mobilePushMigrations = {
  "0201_mobile_push": sqlFile(mobilePush),
  "0202_mobile_push_relay_settings": sqlFile(mobilePushRelaySettings),
  "0203_managed_mobile_push": sqlFile(managedMobilePush),
  "0204_mobile_push_relay_choice": sqlFile(mobilePushRelayChoice),
  "0205_mobile_push_revocations": sqlFile(mobilePushRevocations),
  "0206_mobile_push_managed_selection": sqlFile(mobilePushManagedSelection),
};

/** Applied after 0220; kept apart so the map stays in migration order. */
export const mobilePushDismissalMigrations = {
  "0221_mobile_push_dismissals": sqlFile(mobilePushDismissals),
};
