<script lang="ts">
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
</script>

<DeviceChoiceRow
  preference="diffColors"
  title="Diff colors"
  description="Set the colors for additions and deletions."
  options={[
    { value: "red-green", label: "Red & green" },
    { value: "blue-orange", label: "Blue & orange" },
  ]}
/>
