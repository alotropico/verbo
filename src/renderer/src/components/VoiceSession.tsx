import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { cx } from "@/lib/cx";
import {
  LOCAL_COMMAND_EVENT,
  publishCommandStatus,
} from "@/runtime/command-status";
import { holdQueueLease, takeQueueLease } from "@/runtime/queue-lease";
import { startVoiceCapture, type VoiceCapture } from "@/runtime/voice-capture";
import { useAui, useAuiState, type ThreadMessage } from "@assistant-ui/react";
import { Button, Select, Textarea } from "@mantine/core";
import {
  silenceSendDecision,
  speechChunks,
  voiceStatusLine,
  type VoiceDraftResult,
} from "@shared/voice-draft";
import { MAX_VOICE_TEXT_CHARS, type VoiceInfo } from "@shared/voice";
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_SETTINGS_EVENT,
  type VoiceSettings,
} from "@shared/voice-settings";
import { MicIcon, SquareIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import styles from "./VoiceSession.module.css";
import threadStyles from "./assistant-ui/elements/thread.module.css";
import {
  VoiceSessionContext,
  useVoiceSession,
  type VoiceSessionValue,
} from "./voice-session-context";

function replyText(message: ThreadMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

function VoiceSessionProvider({ children }: PropsWithChildren): ReactElement {
  const aui = useAui();
  const threadId = useAuiState((state) => state.threads.mainThreadId);
  const modelRunning = useAuiState((state) => state.thread.isRunning);
  const [active, setActive] = useState(false);
  const [capture, setCapture] = useState<"idle" | "listening" | "transcribing">(
    "idle",
  );
  const [paused, setPaused] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftState, setDraftState] = useState({ threadId: "", text: "" });
  const [editing, setEditing] = useState(false);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const shownDraft = draftState.threadId === threadId ? draftState.text : "";
  const selectedVoiceId = voiceId ?? voices[0]?.id ?? null;
  const activeRef = useRef(false);
  const captureHandle = useRef<VoiceCapture | null>(null);
  const pausedRef = useRef(false);
  const mutedRef = useRef(false);
  const speakingRef = useRef(false);
  const editingRef = useRef(false);
  const threadRef = useRef(threadId);
  const draftRef = useRef("");
  const audioQueue = useRef<
    { audio: Uint8Array; mode: "dictation" | "control" }[]
  >([]);
  const utteranceMode = useRef<"dictation" | "control">("dictation");
  const aheadRef = useRef(false);
  useEffect(() => {
    const sync = (): void => {
      const threadId = threadRef.current;
      if (!threadId) return;
      void window.verbo.queue.list(threadId).then((snapshot) => {
        aheadRef.current =
          snapshot.hold ||
          Boolean(snapshot.serviceHold) ||
          snapshot.items.some(
            (item) => item.status === "queued" || item.status === "editing",
          );
      });
    };
    sync();
    return window.verbo.queue.subscribe(sync);
  }, []);
  const draining = useRef(false);
  const playToken = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const applyRef = useRef<(result: VoiceDraftResult) => Promise<void>>(
    async () => undefined,
  );
  const speakRef = useRef<(text: string, origin: string) => Promise<void>>(
    async () => undefined,
  );
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const considerRef = useRef<() => void>(() => undefined);
  const sendingRef = useRef(false);
  const listenGen = useRef(0);
  const settingsRef = useRef<VoiceSettings>(DEFAULT_VOICE_SETTINGS);
  const settingsGen = useRef(0);
  const stopSpeechRef = useRef<() => void>(() => undefined);
  const hearingRef = useRef(false);
  const quietAt = useRef<number | null>(null);
  const endpointTimer = useRef(0);

  const replaceDraft = (text: string, id = threadRef.current): void => {
    draftRef.current = text;
    setDraftState({ threadId: id, text });
  };

  const anchor = (): string | null =>
    aui.thread().getState().messages.at(-1)?.id ?? null;

  const stopSpeech = (): void => {
    const wasSpeaking = speakingRef.current;
    playToken.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    speakingRef.current = false;
    pausedRef.current = false;
    setSpeaking(false);
    setPaused(false);
    if (wasSpeaking) void window.verbo.voice.cancel();
  };

  const applyResult = async (result: VoiceDraftResult): Promise<void> => {
    if (!result.ok) {
      setError(result.summary);
      return;
    }
    setError(null);
    if (result.kind === "command") {
      publishCommandStatus({
        status: "success",
        summary: "Opened a blank conversation. Stored chats stay in the list.",
        newThread: true,
      });
      aui.threads().switchToNewThread();
      return;
    }
    if (result.kind === "control" || result.kind === "ignored") return;
    if (result.kind === "composer") {
      const composer = aui.composer().getState();
      if (!composer.text.trim()) aui.composer().setText(result.text);
      setError(result.summary);
      return;
    }
    if (result.kind === "draft") {
      if (!editingRef.current) replaceDraft(result.draft.text);
      return;
    }
    if (result.kind !== "submitted") return;
    quietAt.current = null;
    window.clearTimeout(endpointTimer.current);
    endpointTimer.current = 0;
    replaceDraft("");
    if (!result.start) return;
    holdQueueLease(result.item.id);
    try {
      aui.thread().append(result.item.text);
    } catch (caught: unknown) {
      takeQueueLease();
      await window.verbo.queue.release(result.item.id);
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not send the voice draft.",
      );
    }
  };

  const ensureThread = async (): Promise<string> => {
    const { remoteId } = await aui.threadListItem.initialize();
    threadRef.current = remoteId;
    return remoteId;
  };

  const playWav = (audio: Uint8Array, token: number): Promise<void> => {
    const copy = new Uint8Array(audio.byteLength);
    copy.set(audio);
    const url = URL.createObjectURL(
      new Blob([copy.buffer], { type: "audio/wav" }),
    );
    return new Promise((resolve) => {
      const element = new Audio(url);
      audioRef.current = element;
      const finish = (): void => {
        URL.revokeObjectURL(url);
        if (audioRef.current === element) audioRef.current = null;
        resolve();
      };
      element.onended = finish;
      element.onerror = finish;
      if (token !== playToken.current) {
        finish();
        return;
      }
      void element.play().catch(finish);
    });
  };

  const speakText = async (text: string, origin: string): Promise<void> => {
    if (!activeRef.current || mutedRef.current) return;
    const chunks = speechChunks(
      text,
      MAX_VOICE_TEXT_CHARS,
      settingsRef.current.maxSpokenChunks,
    );
    if (chunks.length === 0) return;
    const token = playToken.current + 1;
    playToken.current = token;
    speakingRef.current = true;
    pausedRef.current = true;
    setSpeaking(true);
    setPaused(true);
    try {
      for (const chunk of chunks) {
        if (token !== playToken.current || threadRef.current !== origin) return;
        const voiceId = settingsRef.current.voiceId || selectedVoiceId;
        const result = await window.verbo.voice.synthesize({
          text: chunk,
          ...(voiceId ? { voiceId } : {}),
        });
        if (token !== playToken.current || threadRef.current !== origin) return;
        if (!result.ok) {
          if (result.code !== "cancelled") setError(result.detail);
          return;
        }
        await playWav(result.audio, token);
      }
    } finally {
      if (token === playToken.current) {
        speakingRef.current = false;
        pausedRef.current = false;
        setSpeaking(false);
        setPaused(false);
      }
    }
  };

  const flushDraft = async (): Promise<void> => {
    const id = aui.threadListItem.getState().remoteId;
    if (!id || editingRef.current || sendingRef.current) return;
    if (aui.thread().getState().isRunning) return;
    sendingRef.current = true;
    try {
      const result = await window.verbo.voice.flush({
        threadId: id,
        branchAnchor: anchor(),
      });
      await applyRef.current(result);
    } finally {
      sendingRef.current = false;
    }
  };

  const clearEndpoint = (): void => {
    window.clearTimeout(endpointTimer.current);
    endpointTimer.current = 0;
  };

  const considerSend = (): void => {
    const quietForMs =
      quietAt.current === null ? null : performance.now() - quietAt.current;
    const silenceSendMs = settingsRef.current.silenceSendMs;
    const decision = silenceSendDecision({
      quietForMs,
      editing: editingRef.current,
      modelRunning: aui.thread().getState().isRunning,
      hasDraft: draftRef.current.trim().length > 0,
      silenceSendMs,
    });
    if (decision !== "wait") {
      clearEndpoint();
      if (decision === "send") void flushRef.current();
      return;
    }
    const elapsed = quietForMs ?? 0;
    clearEndpoint();
    endpointTimer.current = window.setTimeout(
      () => {
        endpointTimer.current = 0;
        considerRef.current();
      },
      Math.max(0, silenceSendMs - elapsed),
    );
  };

  const drain = async (gen: number): Promise<void> => {
    if (draining.current || listenGen.current !== gen) return;
    const next = audioQueue.current.shift();
    if (!next) {
      setCapture(activeRef.current ? "listening" : "idle");
      if (!hearingRef.current) considerRef.current();
      return;
    }
    draining.current = true;
    setCapture("transcribing");
    try {
      const language = settingsRef.current.sttLanguage;
      const result = await window.verbo.voice.transcribe({
        audio: next.audio,
        ...(language === "auto" ? {} : { language }),
      });
      if (!result.ok) {
        if (result.code !== "cancelled") setError(result.detail);
      } else if (result.text.trim()) {
        const id = await ensureThread();
        const committed = await window.verbo.voice.commit({
          threadId: id,
          text: result.text.trim(),
          branchAnchor: anchor(),
          captureMode: next.mode,
        });
        if (committed.ok && committed.kind === "command") {
          quietAt.current = null;
          clearEndpoint();
        }
        await applyRef.current(committed);
      }
    } catch (caught: unknown) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Transcription failed. Typed chat still works.",
      );
    } finally {
      draining.current = false;
      void drain(listenGen.current);
    }
  };

  const stopListening = (): void => {
    listenGen.current += 1;
    hearingRef.current = false;
    activeRef.current = false;
    setActive(false);
    captureHandle.current?.stop();
    captureHandle.current = null;
    setCapture(draining.current ? "transcribing" : "idle");
  };

  const stopSession = (): void => {
    stopListening();
    stopSpeech();
  };

  const toggle = (): void => {
    if (activeRef.current) {
      stopListening();
      return;
    }
    const gen = listenGen.current;
    setError(null);
    void startVoiceCapture({
      paused: () => pausedRef.current,
      limits: () => ({
        speechRms: settingsRef.current.speechRms,
        silenceHoldMs: settingsRef.current.silenceHoldMs,
        minSpeechMs: settingsRef.current.minSpeechMs,
        maxSegmentMs: settingsRef.current.maxSegmentMs,
      }),
      onSpeechStart: () => {
        if (listenGen.current !== gen) return;
        utteranceMode.current =
          aui.thread().getState().isRunning || aheadRef.current
            ? "control"
            : "dictation";
        hearingRef.current = true;
        quietAt.current = null;
        clearEndpoint();
      },
      onSpeechEnd: (emitted) => {
        if (listenGen.current !== gen) return;
        hearingRef.current = false;
        quietAt.current = performance.now();
        if (!emitted) considerRef.current();
      },
      onSegmentSkipped: () => {
        if (listenGen.current !== gen || hearingRef.current) return;
        considerRef.current();
      },
      onSegment: (audio) => {
        if (listenGen.current !== gen) return;
        audioQueue.current.push({
          audio,
          mode: utteranceMode.current,
        });
        void drain(gen);
      },
    })
      .then((handle) => {
        if (listenGen.current !== gen) {
          handle.stop();
          return;
        }
        captureHandle.current = handle;
        activeRef.current = true;
        setActive(true);
        setCapture("listening");
        void window.verbo.voice.status().then((status) => {
          if (listenGen.current !== gen || !status.ok) return;
          setVoices(status.voices);
        });
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "Microphone capture failed. Typed chat still works.",
        );
      });
  };

  const stopSessionRef = useRef<() => void>(() => undefined);
  const renderedThread = useRef(threadId);

  useLayoutEffect(() => {
    pausedRef.current = paused;
    mutedRef.current = muted;
    editingRef.current = editing;
    draftRef.current = shownDraft;
    applyRef.current = applyResult;
    speakRef.current = speakText;
    flushRef.current = flushDraft;
    considerRef.current = considerSend;
    stopSessionRef.current = stopSession;
    stopSpeechRef.current = stopSpeech;
  });
  useEffect(() => () => stopSessionRef.current(), []);
  useEffect(() => {
    void window.verbo.voice.status().then((status) => {
      if (status.ok) setVoices(status.voices);
    });
  }, []);

  useEffect(() => {
    const stamp = settingsGen.current;
    const apply = (next: VoiceSettings, generation: number): void => {
      if (generation !== settingsGen.current) return;
      const wasAllowed = settingsRef.current.speakReplies;
      settingsRef.current = next;
      mutedRef.current = !next.speakReplies;
      setMuted(!next.speakReplies);
      setVoiceId(next.voiceId || null);
      if (wasAllowed && !next.speakReplies) stopSpeechRef.current();
    };
    void window.verbo.voice
      .settings()
      .then((next) => apply(next, stamp))
      .catch(() => undefined);
    const onSettings = (event: Event): void => {
      const detail = (event as CustomEvent<VoiceSettings>).detail;
      if (!detail) return;
      settingsGen.current += 1;
      apply(detail, settingsGen.current);
    };
    window.addEventListener(VOICE_SETTINGS_EVENT, onSettings);
    return () => window.removeEventListener(VOICE_SETTINGS_EVENT, onSettings);
  }, []);

  useEffect(() => {
    const onCommand = (event: Event): void => {
      const detail = (
        event as CustomEvent<{
          newThread?: boolean;
          openMemory?: boolean;
        }>
      ).detail;
      if (detail?.newThread) aui.threads().switchToNewThread();
      if (detail?.openMemory) {
        window.dispatchEvent(
          new CustomEvent("verbo:open-settings", { detail: { tab: "memory" } }),
        );
      }
    };
    window.addEventListener(LOCAL_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(LOCAL_COMMAND_EVENT, onCommand);
  }, [aui]);

  useEffect(() => {
    const previous = renderedThread.current;
    renderedThread.current = threadId;
    if (previous === threadId || threadRef.current === threadId) return;
    stopSessionRef.current();
    threadRef.current = threadId;
  }, [threadId]);

  useEffect(() => {
    const remoteId = aui.threadListItem.getState().remoteId;
    if (!remoteId) return undefined;
    let cancelled = false;
    void window.verbo.voice.draft(remoteId).then((result) => {
      if (cancelled || !result.ok || result.kind !== "draft") return;
      draftRef.current = result.draft.text;
      setDraftState({ threadId: remoteId, text: result.draft.text });
    });
    return () => {
      cancelled = true;
    };
  }, [aui, threadId]);

  useEffect(() => {
    const onQueue = (): void => {
      considerRef.current();
    };
    const onRunEnd = (): void => {
      const last = aui.thread().getState().messages.at(-1);
      const text = last ? replyText(last) : "";
      void speakRef.current(text, threadId);
      onQueue();
    };
    const stopQueue = window.verbo.queue.subscribe(onQueue);
    const stopRun = aui.on("thread.runEnd", onRunEnd);
    return () => {
      stopQueue();
      stopRun();
    };
  }, [aui, threadId]);

  const status = voiceStatusLine({
    active,
    capture: active ? capture : "idle",
    paused,
    speaking,
    error,
    hasDraft: shownDraft.trim().length > 0,
    modelRunning,
  });
  const showDraft = shownDraft.length > 0 || editing;
  const value: VoiceSessionValue = {
    active,
    draft: shownDraft,
    muted,
    showDraft,
    speaking,
    status,
    visible: active || showDraft || speaking || error !== null,
    voiceId: selectedVoiceId,
    voices,
    discardDraft: () => {
      setEditing(false);
      editingRef.current = false;
      const id = aui.threadListItem.getState().remoteId;
      if (!id) {
        replaceDraft("");
        return;
      }
      void window.verbo.voice
        .discard(id)
        .then((result) => applyRef.current(result));
    },
    sendDraft: () => {
      void (async () => {
        const id = await ensureThread();
        setEditing(false);
        editingRef.current = false;
        const saved = await window.verbo.voice.save({
          threadId: id,
          text: draftRef.current,
        });
        if (!saved.ok) {
          setError(saved.summary);
          return;
        }
        const result = await window.verbo.voice.send({
          threadId: id,
          branchAnchor: anchor(),
        });
        await applyRef.current(result);
      })();
    },
    setDraft: (text: string) => {
      replaceDraft(text);
    },
    setEditing: (next: boolean) => {
      editingRef.current = next;
      setEditing(next);
      if (!next) return;
      quietAt.current = null;
      clearEndpoint();
    },
    setVoiceId: (id: string) => {
      setVoiceId(id);
      const next = { ...settingsRef.current, voiceId: id };
      settingsGen.current += 1;
      settingsRef.current = next;
      void window.verbo.voice.setSettings(next);
    },
    stopSpeech,
    toggle,
    blurDraft: () => {
      setEditing(false);
      editingRef.current = false;
      const id = aui.threadListItem.getState().remoteId;
      if (!id) return;
      void window.verbo.voice
        .save({ threadId: id, text: draftRef.current })
        .then((result) => applyRef.current(result));
    },
    toggleMuted: () => {
      const next = !mutedRef.current;
      mutedRef.current = next;
      setMuted(next);
      if (next) stopSpeech();
      const saved = { ...settingsRef.current, speakReplies: !next };
      settingsGen.current += 1;
      settingsRef.current = saved;
      void window.verbo.voice.setSettings(saved);
    },
  };

  return (
    <VoiceSessionContext.Provider value={value}>
      {children}
    </VoiceSessionContext.Provider>
  );
}

export function VoiceDraftPanel(): ReactElement | null {
  const session = useVoiceSession();
  if (!session?.visible) return null;
  return (
    <section className={styles.panel} aria-label="Voice session">
      <div className={styles.header}>
        {session.status ? (
          <p
            className={styles.status}
            role="status"
            data-active={session.active || undefined}
          >
            <MicIcon className={styles.statusIcon} aria-hidden="true" />
            <span>{session.status}</span>
          </p>
        ) : null}
        <Button
          type="button"
          size="xs"
          variant="subtle"
          aria-pressed={session.muted}
          leftSection={
            session.muted ? (
              <VolumeXIcon size={14} />
            ) : (
              <Volume2Icon size={14} />
            )
          }
          onClick={session.toggleMuted}
        >
          {session.muted ? "Speak replies" : "Mute replies"}
        </Button>
      </div>
      {session.voices.length > 0 && session.voiceId ? (
        <Select
          label="Reply voice"
          size="xs"
          allowDeselect={false}
          data={session.voices.map((voice) => ({
            value: voice.id,
            label: `${voice.id} (${voice.language})`,
          }))}
          value={session.voiceId}
          onChange={(value) => {
            if (value) session.setVoiceId(value);
          }}
        />
      ) : null}
      {session.showDraft ? (
        <Textarea
          label="Voice draft"
          description="You can edit the recognized text before sending."
          autosize
          minRows={2}
          value={session.draft}
          onFocus={() => session.setEditing(true)}
          onBlur={session.blurDraft}
          onChange={(event) => session.setDraft(event.currentTarget.value)}
        />
      ) : null}
      {session.speaking || session.showDraft ? (
        <div className={styles.actions}>
          {session.speaking ? (
            <Button
              type="button"
              size="xs"
              variant="default"
              onClick={session.stopSpeech}
            >
              Stop playback
            </Button>
          ) : null}
          {session.showDraft ? (
            <Button
              type="button"
              size="xs"
              variant="filled"
              onClick={session.sendDraft}
            >
              Send draft
            </Button>
          ) : null}
          {session.showDraft ? (
            <Button
              type="button"
              size="xs"
              variant="subtle"
              onClick={session.discardDraft}
            >
              Discard
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function VoiceSessionButton(): ReactElement | null {
  const session = useVoiceSession();
  if (!session) return null;
  const label = session.active ? "Stop voice" : "Start voice";
  return (
    <TooltipIconButton
      tooltip={label}
      side="bottom"
      type="button"
      className={cx(
        threadStyles.composerIconButton,
        session.active
          ? threadStyles.composerVoiceLive
          : threadStyles.composerVoice,
      )}
      aria-label={label}
      aria-pressed={session.active}
      onClick={session.toggle}
    >
      {session.active ? (
        <SquareIcon className={threadStyles.composerIconSm} />
      ) : (
        <MicIcon className={threadStyles.composerIconSm} />
      )}
    </TooltipIconButton>
  );
}

export { VoiceSessionProvider };
