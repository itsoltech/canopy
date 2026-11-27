<script lang="ts">
  let { value, amount }: { value: string; amount?: number | bigint } = $props();

  interface Reading {
    value: string;
    amount: number | bigint | undefined;
  }

  function animate(next: Reading, previous: Reading | undefined) {
    const digits = Array.from(next.value);
    const isDigit = (character: string) => /\p{Nd}/u.test(character);
    const lastDigit = digits.findLastIndex(isDigit);
    const shape = (text: string) => text.replace(/\p{Nd}/gu, "0");
    const oldDigits = previous && shape(previous.value) === shape(next.value) ? Array.from(previous.value) : [];

    const characters = digits.map((character, index) => ({
      character,
      old: oldDigits[index],
      changed: isDigit(character) && oldDigits[index] !== character,
      stagger: Math.max(0, 2 + index - lastDigit),
    }));

    const lastChanged = characters.findLastIndex(({ changed }) => changed);

    if (lastChanged === -1) return;

    return {
      characters,
      lastChanged,
      opening: previous === undefined,
      direction: next.amount !== undefined && previous?.amount !== undefined && next.amount < previous.amount ? -1 : 1,
    };
  }

  let previous: Reading | undefined;
  let motion = $state.raw<ReturnType<typeof animate>>();

  $effect(() => {
    const next = { value, amount };

    if (value !== previous?.value) motion = animate(next, previous);
    previous = next;
  });
</script>

<span class:animating={motion !== undefined}>
  <span class="number-text">{value}</span>
  {#if motion}
    {#key motion}
      {@const { characters, lastChanged, opening, direction } = motion}
      <span class="digits" class:opening aria-hidden="true" style:--digit-direction={direction}>
        {#each characters as { character, old, changed, stagger }, index}
          {#if changed}
            <span class="digit-slot" data-old={old} style:--digit-stagger={stagger}>
              <span
                class="new-digit"
                onanimationend={() => {
                  if (index === lastChanged) motion = undefined;
                }}>{character}</span
              >
            </span>
          {:else}{character}{/if}
        {/each}
      </span>
    {/key}
  {/if}
</span>

<style>
  .animating {
    position: relative;
    display: inline-block;
  }

  .animating .number-text {
    color: transparent;
  }

  .digits {
    position: absolute;
    inset: 0;
    pointer-events: none;
    user-select: none;
    white-space: pre;
  }

  .digit-slot {
    position: relative;
    display: inline-block;
  }

  .digit-slot[data-old]::before {
    content: attr(data-old);
    position: absolute;
    inset: 0;
    animation: digit-exit var(--duration-slow) var(--ease-smooth-out) both;
  }

  .new-digit {
    display: inline-block;
    animation: digit-enter var(--duration-slow) var(--ease-smooth-out) backwards;
  }

  .opening .new-digit {
    animation: digit-pop var(--duration-very-slow) var(--ease-smooth-out) backwards;
    animation-delay: calc(var(--digit-stagger) * var(--duration-stagger));
  }

  @keyframes digit-pop {
    from {
      transform: translateY(0.52em) scale(0.7);
      filter: blur(var(--blur-small));
      opacity: 0;
    }

    48% {
      transform: translateY(-0.045em) scale(1.03);
      filter: blur(0);
      opacity: 1;
    }

    to {
      transform: none;
    }
  }

  @keyframes digit-enter {
    from {
      translate: 0 calc(0.14em * var(--digit-direction));
      opacity: 0;
    }
  }

  @keyframes digit-exit {
    to {
      translate: 0 calc(-0.14em * var(--digit-direction));
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce), (forced-colors: active) {
    .animating {
      display: inline;
    }

    .animating .number-text {
      color: inherit;
    }

    .digits {
      display: none;
    }
  }
</style>
