---
name: unslop-ui
description: Review Canopy interface copy, navigation, status cues and charts for readability. Use for UI audits and cleanup; include spacing, styling and motion when requested.
---

# Canopy UI review

Read the [Canopy review rules](../../../docs/ui-review.md) before assessing a screen. They define how U1–U20 apply here, including the role of section icons in Settings. Use [Canopy copy](../../../docs/copy.md) for wording and the [UI scale](../../../docs/ui-scale.md) for layout. Apply these project decisions on web, desktop and mobile.

Work on the requested screen or files. Identify the user's task, inspect the rendered state and distinguish cues for navigation, recognition, accessibility and recovery from decoration. For an audit, report findings. When implementing fixes, verify each changed state in its relevant layouts and interaction modes. Keep a useful cue when its removal has no demonstrated benefit.

The pinned upstream skill provides a read-only candidate counter. From the repository root, for example:

```bash
python3 .agents/skills/unslop-ui-upstream/scripts/count_tells.py apps/web/src/lib/features/settings
```

The default covers U1–U16. Add `--surface` for U17–U20 when reviewing style or motion. A zero count can miss a usability issue, and a high count can include useful controls. Record the user-facing reason for each proposed change.

The upstream reference is installed separately so refreshing it preserves this entry point and the Canopy rules. To update the reference from the repository root:

```bash
npx skills add felipebasurto/unslop-ui --skill unslop-ui --rename unslop-ui-upstream --agent codex --yes
```

Review the upstream diff and its license, then commit the installed files with the updated [skills lock](../../../skills-lock.json). The checkout contains the counter and rules for offline use. [Upstream source](https://github.com/felipebasurto/unslop-ui) · [MIT license](../../licenses/unslop-ui.txt)
