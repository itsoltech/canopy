<script lang="ts">
  import DeviceChoiceRow from "./DeviceChoiceRow.svelte";
</script>

<DeviceChoiceRow
  preference="interfaceSize"
  title="Interface size"
  description="Change the size of text and controls."
  options={[12, 14, 16, 18].map((v) => ({ value: String(v), label: `${v} px` }))}
/>
