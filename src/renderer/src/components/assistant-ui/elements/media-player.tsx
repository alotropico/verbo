"use client";

import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";
import { PauseIcon, PlayIcon } from "lucide-react";
import { cx } from "@/lib/cx";
import { ActionIcon } from "@mantine/core";
import { StatusMessage } from "@/components/StatusMessage";
import { field, mono, paper } from "./surfaces";
import styles from "./media-player.module.css";

export interface AudioPlayerProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  src: string;
  title?: string | undefined;
  artwork?: string | undefined;
  durationMs?: number | undefined;
}

export interface VideoPlayerProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  src: string;
  poster?: string | undefined;
  title?: string | undefined;
  ratio?: "16:9" | "4:3" | "1:1" | "9:16" | "auto" | undefined;
  durationMs?: number | undefined;
}

function formatDuration(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = wholeSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function useMediaDuration(
  mediaRef: RefObject<HTMLMediaElement | null>,
  src: string,
  durationMs?: number | undefined,
) {
  const [metadata, setMetadata] = useState<{ src: string; duration?: number }>({
    src,
  });

  // A server-rendered media element can load metadata before hydration attaches onLoadedMetadata.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media || media.readyState < HTMLMediaElement.HAVE_METADATA) return;
    if (Number.isFinite(media.duration) && media.duration >= 0) {
      setMetadata({ src, duration: media.duration });
    }
  }, [mediaRef, src]);
  const fallbackDuration =
    durationMs !== undefined && Number.isFinite(durationMs)
      ? Math.max(0, durationMs / 1000)
      : undefined;

  return {
    duration:
      metadata.src === src
        ? (metadata.duration ?? fallbackDuration)
        : fallbackDuration,
    setDurationFromMetadata: (duration: number) => {
      if (Number.isFinite(duration) && duration >= 0) {
        setMetadata({ src, duration });
      }
    },
  };
}

const ratioClass = {
  "1:1": styles.aspectSquare,
  "4:3": styles.aspect4x3,
  "16:9": styles.aspectVideo,
  "9:16": styles.aspect9x16,
} as const;

export function AudioPlayer({
  src,
  title,
  artwork,
  durationMs,
  className,
  ...props
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playback, setPlayback] = useState({
    src,
    currentTime: 0,
    playing: false,
    hasError: false,
  });
  const { duration, setDurationFromMetadata } = useMediaDuration(
    audioRef,
    src,
    durationMs,
  );
  const playbackState =
    playback.src === src
      ? playback
      : { src, currentTime: 0, playing: false, hasError: false };
  const { currentTime, playing, hasError } = playbackState;
  const update = (patch: Partial<Omit<typeof playback, "src">>) =>
    setPlayback((current) => ({
      ...(current.src === src
        ? current
        : { src, currentTime: 0, playing: false, hasError: false }),
      ...patch,
    }));
  const displayTitle = title ?? "Audio";
  const playbackLabel = title ? ` ${title}` : " audio";
  const durationLabel =
    duration === undefined ? "--:--" : formatDuration(duration);

  useEffect(() => {
    if (audioRef.current?.error) {
      setPlayback({ src, currentTime: 0, playing: false, hasError: true });
    }
  }, [src]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio || hasError) return;

    if (playing) {
      audio.pause();
      update({ playing: false });
      return;
    }

    void audio.play().then(
      () => update({ playing: true }),
      () =>
        update(
          audio.error ? { hasError: true, playing: false } : { playing: false },
        ),
    );
  };

  return (
    <div
      data-slot="audio-player"
      className={cx(paper, styles.audioRoot, className)}
      {...props}
    >
      {artwork ? <img src={artwork} alt="" className={styles.artwork} /> : null}
      <ActionIcon
        type="button"
        variant="subtle"
        aria-label={`${playing ? "Pause" : "Play"}${playbackLabel}`}
        disabled={hasError}
        onClick={togglePlayback}
        className={styles.playButton}
      >
        {playing ? (
          <PauseIcon aria-hidden className={styles.iconSm} />
        ) : (
          <PlayIcon
            aria-hidden
            className={cx(styles.iconSm, styles.playIconOffset)}
          />
        )}
      </ActionIcon>
      <div className={styles.metaCol}>
        <span className={styles.title}>{displayTitle}</span>
        <input
          type="range"
          min={0}
          max={duration ?? 0}
          step={0.1}
          value={Math.min(currentTime, duration ?? 0)}
          aria-label="Seek"
          aria-valuetext={`${formatDuration(currentTime)} of ${durationLabel}`}
          disabled={hasError}
          onChange={(event) => {
            const nextTime = Number(event.currentTarget.value);
            if (!Number.isFinite(nextTime)) return;
            const resolvedTime = Math.min(nextTime, duration ?? nextTime);
            if (audioRef.current) audioRef.current.currentTime = resolvedTime;
            update({ currentTime: resolvedTime });
          }}
          className={styles.seek}
        />
      </div>
      <span className={cx(mono, styles.timeMuted)}>
        {formatDuration(currentTime)}&nbsp;/ {durationLabel}
      </span>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className={styles.hiddenAudio}
        onLoadedMetadata={(event) => {
          setDurationFromMetadata(event.currentTarget.duration);
        }}
        onTimeUpdate={(event) =>
          update({ currentTime: event.currentTarget.currentTime })
        }
        onPlay={() => update({ playing: true })}
        onPause={() => update({ playing: false })}
        onError={() => update({ hasError: true, playing: false })}
      />
      {hasError ? (
        <StatusMessage display="plain" size="xs" tone="error">
          Can&apos;t play this audio
        </StatusMessage>
      ) : null}
    </div>
  );
}

export function VideoPlayer({
  src,
  poster,
  title,
  ratio = "16:9",
  durationMs,
  className,
  ...props
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { duration, setDurationFromMetadata } = useMediaDuration(
    videoRef,
    src,
    durationMs,
  );
  const ratioClassName =
    ratio !== "auto" ? ratioClass[ratio as keyof typeof ratioClass] : undefined;

  return (
    <div
      data-slot="video-player"
      className={cx(styles.videoRoot, className)}
      {...props}
    >
      <div className={cx(field, styles.videoField, ratioClassName)}>
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          controls
          playsInline
          preload="metadata"
          aria-label={title ?? "Video"}
          className={cx(
            styles.videoEl,
            ratio !== "auto" && styles.videoElContain,
          )}
          onLoadedMetadata={(event) => {
            setDurationFromMetadata(event.currentTarget.duration);
          }}
        />
      </div>
      {(title || duration !== undefined) && (
        <div className={styles.videoFooter}>
          {title ? <span className={styles.videoTitle}>{title}</span> : null}
          {duration !== undefined ? (
            <span className={cx(mono, styles.durationShrink)}>
              {formatDuration(duration)}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
