<script lang="ts">
  import { untrack } from "svelte";

  type Digit = { value: string; previous: string | undefined; stagger: number | undefined };

  let { value }: { value: number } = $props();
  const percent = $derived(String(Math.round(value)));
  let digits = $state.raw<Digit[]>([]);

  $effect.pre(() => {
    const previous = untrack(() => digits);
    let stagger = 0;

    digits = Array.from(percent, (value, index) => {
      // Match place values when the number gains a digit.
      const old = previous[previous.length - percent.length + index];

      if (old?.value === value) return old;

      return { value, previous: old?.value, stagger: previous.length ? stagger++ : undefined };
    });
  });
</script>

<span class="sr-only">{percent}%</span>
<span class="percent" aria-hidden="true">
  <span class="digit-field">
    <span class="digits">
      {#each digits as digit, index (digits.length - index)}
        <span class="digit" style:--digit-index={digit.stagger}>
          {#key digit}
            {#if digit.previous !== undefined}<span class="outgoing">{digit.previous}</span>{/if}
            <span class:incoming={digit.stagger !== undefined}>{digit.value}</span>
          {/key}
        </span>
      {/each}
    </span>
  </span><span>%</span>
</span>

<style>
  .percent,
  .digits {
    display: inline-flex;
    align-items: baseline;
  }

  .digit-field {
    display: inline-grid;
    justify-items: end;
  }

  /* Reserve the width of three tabular digits so the percent sign stays put. */
  .digit-field::before {
    content: "000";
    visibility: hidden;
  }

  .digit-field::before,
  .digits {
    grid-area: 1 / 1;
  }

  .digit {
    position: relative;
    --digit-delay: calc(var(--duration-stagger) * var(--digit-index, 0));
    --digit-blur: min(var(--blur-small), 0.067em);
  }

  .incoming {
    display: inline-block;
    animation: digit-in var(--duration-very-slow) var(--ease-linear) calc(var(--digit-delay) + var(--duration-stagger))
      both;
  }

  .outgoing {
    position: absolute;
    inset: 0;
    text-align: center;
    animation: digit-out var(--duration-quick) var(--ease-linear) var(--digit-delay) both;
  }

  @keyframes digit-in {
    0% {
      transform: translateY(0.52em) scale(0.7);
      opacity: 0;
      filter: blur(var(--digit-blur));
    }
    15% {
      transform: translateY(0.37em) scale(0.7);
      opacity: 0.53;
      filter: blur(var(--digit-blur));
    }
    30% {
      transform: translateY(0) scale(0.99);
      opacity: 1;
      filter: blur(calc(var(--digit-blur) * 0.6));
    }
    40% {
      transform: translateY(-0.034em) scale(1.03);
      filter: blur(calc(var(--digit-blur) * 0.3));
    }
    70% {
      transform: translateY(0.006em) scale(0.994);
      filter: blur(0);
    }
    100% {
      transform: translateY(0) scale(1);
      opacity: 1;
      filter: blur(0);
    }
  }

  @keyframes digit-out {
    0% {
      transform: translateY(0) scale(1);
      opacity: 1;
    }
    40% {
      transform: translateY(-0.13em) scale(0.92);
      opacity: 1;
    }
    60% {
      transform: translateY(-0.39em) scale(0.78);
      opacity: 0.42;
    }
    100% {
      transform: translateY(-0.52em) scale(0.7);
      opacity: 0;
      filter: blur(var(--digit-blur));
      visibility: hidden;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .incoming {
      animation: none;
    }

    .outgoing {
      display: none;
    }
  }
</style>
