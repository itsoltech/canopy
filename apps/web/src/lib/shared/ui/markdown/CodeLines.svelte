<script lang="ts">
  /**
   * The text of a code block. While `streaming`, each line is its own element so a newly revealed line
   * resolves in on its own (motion.css `t-stream-line`); afterwards it is one text node again.
   */
  let { text, streaming = false }: { text: string; streaming?: boolean } = $props();
</script>

<!-- One line: this renders inside a <pre>, where whitespace in the template would show. -->
{#if streaming}{#each text.split("\n") as line, index (index)}<span class="t-stream-line">{index > 0 ? "\n" : ""}{line}</span>{/each}{:else}{text}{/if}
