<script lang="ts">
  import { tick, untrack } from "svelte";
  import { VIDEO_CONTROLS_IDLE_MS, videoClock } from "@canopy/ui/video-controls";
  import { observeActivity } from "#lib/shared/activity.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import VideoControlIcon from "./VideoControlIcon.svelte";
  import VideoSlider from "./VideoSlider.svelte";
  import "./video-player.css";

  let {
    src,
    poster,
    active = true,
    placement = "lightbox",
    label = "Video player",
  }: {
    src: string;
    poster?: string | undefined;
    active?: boolean;
    placement?: "lightbox" | "workspace" | "chat";
    label?: string;
  } = $props();

  // iPhone Safari exposes full screen on the media element when element full screen is unavailable.
  type VideoElement = HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitDisplayingFullscreen?: boolean;
  };

  let player = $state<HTMLDivElement>();
  let video = $state<VideoElement>();
  let playButton = $state<HTMLButtonElement>();
  let failed = $state(false);
  let hasBeenVisible = $state(false);
  let paused = $state(true);
  let ended = $state(false);
  let time = $state(0);
  let mediaDuration = $state(0);
  let buffered = $state<{ start: number; end: number }[]>([]);
  let muted = $state(false);
  let volume = $state(1);
  let waiting = $state(false);
  let awake = $state(true);
  let fullscreen = $state(false);
  let canFullscreen = $state(false);
  let captionTrack = $state<TextTrack>();
  let captions = $state(false);
  let captionText = $state("");
  let lastPointer = "";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const lightbox = $derived(placement === "lightbox");
  const duration = $derived(Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : 0);
  const loaded = $derived(Math.max(0, ...buffered.map((range) => range.end)));
  const silent = $derived(muted || volume === 0);
  const idle = $derived(!paused && !awake);
  const playbackLabel = $derived(paused ? (ended ? "Replay" : "Play") : "Pause");
  const playbackIcon = $derived(paused ? (ended ? "replay" : "play") : "pause");

  $effect(() => {
    if (!active) video?.pause();
  });

  $effect(() => {
    const node = video;

    if (!node) return;

    const stop = observeActivity(node, (visible) => {
      if (!visible && !node.webkitDisplayingFullscreen) node.pause();
      else if (visible && placement === "chat") hasBeenVisible = true;
    });

    return () => {
      stop();
      node.pause();

      if (!lightbox) {
        node.removeAttribute("src");
        node.load();
      }
    };
  });

  $effect(() => {
    if (!video) return;
    canFullscreen = document.fullscreenEnabled || Boolean(video.webkitEnterFullscreen);
    const tracks = video.textTracks;

    const update = () => {
      const available = Array.from(tracks).filter((track) => track.kind === "captions" || track.kind === "subtitles");

      const selected =
        available.find((track) => track.mode === "showing") ??
        available.find((track) => track === captionTrack) ??
        available[0];

      if (captionTrack !== selected) {
        captionTrack = selected;
        captions = selected?.mode === "showing";
      }
    };

    const events = ["addtrack", "removetrack", "change"] as const;
    untrack(update);

    for (const event of events) tracks.addEventListener(event, update);

    return () => {
      for (const event of events) tracks.removeEventListener(event, update);
    };
  });

  $effect(() => {
    const track = captionTrack;
    captionText = "";

    if (!track) return;
    track.mode = captions ? "hidden" : "disabled";

    if (!captions) return;

    const update = () => {
      captionText = Array.from(track.activeCues ?? [], (cue) =>
        cue instanceof VTTCue ? (cue.getCueAsHTML().textContent ?? "") : "",
      ).join("\n");
    };

    update();
    track.addEventListener("cuechange", update);

    return () => track.removeEventListener("cuechange", update);
  });

  $effect(() => () => clearTimeout(idleTimer));

  function wake() {
    awake = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (awake = false), VIDEO_CONTROLS_IDLE_MS);
  }

  function toggle() {
    if (!video) return;

    if (video.paused) {
      if (video.ended) video.currentTime = 0;
      void video.play().catch(() => {});
    } else video.pause();

    wake();
  }

  function seek(position: number) {
    if (!video || !duration) return;
    video.currentTime = Math.max(0, Math.min(duration, position));
    wake();
  }

  function setVolume(value: number) {
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    wake();
  }

  function toggleMute() {
    if (!video) return;

    if (video.volume === 0) setVolume(0.5);
    else video.muted = !video.muted;

    wake();
  }

  function toggleCaptions() {
    if (captionTrack) captions = !captions;
    wake();
  }

  function toggleFullscreen() {
    if (!player || !video || !canFullscreen) return;

    if (document.fullscreenElement === player) void document.exitFullscreen().catch(() => {});
    else if (document.fullscreenEnabled) void player.requestFullscreen().catch(() => {});
    else video.webkitEnterFullscreen?.();

    wake();
  }

  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

    switch (event.key.toLowerCase()) {
      case "k":
        toggle();
        break;
      case "arrowleft":
      case "j":
        if (!duration) return;
        seek(time - 5);
        break;
      case "arrowright":
      case "l":
        if (!duration) return;
        seek(time + 5);
        break;
      case "m":
        toggleMute();
        break;
      case "c":
        if (!captionTrack) return;
        toggleCaptions();
        break;
      case "f":
        if (!canFullscreen) return;
        toggleFullscreen();
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  async function retry() {
    failed = false;
    waiting = false;
    video?.load();
    await tick();
    playButton?.focus();
  }
</script>

<svelte:document onfullscreenchange={() => (fullscreen = !!player && document.fullscreenElement === player)} />

<div class="video-player-layout" data-placement={placement}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- group delegates shortcuts from its focusable controls -->
  <div
    bind:this={player}
    class="video-player"
    data-idle={idle}
    role="group"
    aria-label={label}
    onpointermove={(event) => {
      if (event.pointerType === "mouse") wake();
    }}
    onpointerdown={(event) => (lastPointer = event.pointerType)}
    onpointerleave={() => {
      if (!paused) awake = false;
    }}
    onkeydown={keydown}
  >
    <!-- svelte-ignore a11y_media_has_caption -- caption tracks present in the media are exposed as a player control -->
    <video
      bind:this={video}
      bind:paused
      bind:ended
      bind:currentTime={time}
      bind:duration={mediaDuration}
      bind:buffered
      src={placement !== "chat" || hasBeenVisible ? src : undefined}
      {poster}
      playsinline
      preload="metadata"
      muted={lightbox}
      onplay={wake}
      onwaiting={() => (waiting = true)}
      oncanplay={() => (waiting = false)}
      onplaying={() => {
        waiting = false;
        failed = false;
      }}
      onvolumechange={() => {
        if (!video) return;
        muted = video.muted;
        volume = video.volume;
      }}
      onloadedmetadata={() => {
        if (!video) return;
        muted = video.muted;
        volume = video.volume;
        failed = false;
      }}
      onerror={() => (failed = true)}
    ></video>

    <button
      type="button"
      class="video-player-surface"
      aria-label={playbackLabel}
      tabindex="-1"
      onclick={() => {
        if (lastPointer !== "mouse" && idle) wake();
        else toggle();
      }}
      disabled={failed}
    >
      {#if waiting && !paused && !failed}
        <span class="video-player-badge" role="status"><Spinner /><span class="sr-only">Loading video</span></span>
      {:else if paused && !failed}
        <span class="video-player-badge video-player-badge-large" data-play={!ended}>
          <VideoControlIcon name={playbackIcon} />
        </span>
      {/if}
    </button>

    {#if captions && captionText}
      <p class="video-player-caption"><span>{captionText}</span></p>
    {/if}

    {#if !failed}
      <div class="video-player-bar" onfocusin={wake}>
        <VideoSlider
          label="Seek"
          value={time}
          max={duration}
          step={5}
          buffered={loaded}
          changed={seek}
          format={videoClock}
          previewTime
        />
        <div class="video-player-row">
          <button bind:this={playButton} type="button" aria-label={playbackLabel} onclick={toggle}>
            <VideoControlIcon name={playbackIcon} />
          </button>
          <div class="video-player-sound">
            <button type="button" aria-label={silent ? "Unmute" : "Mute"} onclick={toggleMute}>
              <VideoControlIcon name={silent ? "muted" : "volume"} />
            </button>
            <span class="video-player-time">{videoClock(time)} <span>/ {videoClock(duration)}</span></span>
            <div class="video-player-volume">
              <VideoSlider
                label="Volume"
                value={silent ? 0 : volume}
                max={1}
                step={0.05}
                changed={setVolume}
                format={(value) => `${Math.round(value * 100)}%`}
              />
            </div>
          </div>
          {#if captionTrack}
            <button type="button" aria-label="Captions" aria-pressed={captions} onclick={toggleCaptions}>
              <VideoControlIcon name="captions" />
            </button>
          {/if}
          {#if canFullscreen}
            <button
              type="button"
              aria-label={fullscreen ? "Exit full screen" : "Full screen"}
              onclick={toggleFullscreen}
            >
              <VideoControlIcon name={fullscreen ? "exit" : "enter"} />
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if failed && !lightbox}
    <div class="flex flex-wrap items-center justify-center gap-2">
      <p role="alert" class="text-base text-muted sm:text-sm">Could not play this video.</p>
      <Button size="sm" onclick={retry}>Retry</Button>
    </div>
  {:else if failed}
    <p role="alert" class="px-3 pb-3 text-base sm:text-sm">
      Could not play this video. Download it to open it in another app.
    </p>
  {/if}
</div>
