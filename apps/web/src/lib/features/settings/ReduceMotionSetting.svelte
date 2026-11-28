<script lang="ts">
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
</script>

<DeviceChoiceRow
  preference="reduceMotion"
  title="Reduce motion"
  description="Follow your device’s reduced motion setting or always reduce motion in Canopy."
  options={[
    { value: "system", label: "System" },
    { value: "always", label: "Always" },
  ]}
/>
