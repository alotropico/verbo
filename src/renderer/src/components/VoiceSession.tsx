import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { cx } from "@/lib/cx";
import {
  LOCAL_COMMAND_EVENT,
  publishCommandStatus,
} from "@/runtime/command-status";
import { holdQueueLease, takeQueueLease } from "@/runtime/queue-lease";
import { startVoiceCapture, type VoiceCapture } from "@/runtime/voice-capture";
import { useAui, useAuiState, type ThreadMessage } from "@assistant-ui/react";
import { Button, Textarea } from "@mantine/core";
import { ChatBlob } from "@/features/chat-blob";
import {
  revealTextPrefix,
  speechProgress,
  type SpeechCaption,
} from "@shared/speech-reveal";
import {
  silenceSendDecision,
  joinSpeech,
  speechChunks,
  voiceStatusLine,
  type VoiceDraftResult,
} from "@shared/voice-draft";
import { ProgressiveRecognition } from "@shared/progressive-recognition";
import { MAX_VOICE_TEXT_CHARS, type VoiceInfo } from "@shared/voice";
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_SETTINGS_EVENT,
  type VoiceSettings,
} from "@shared/voice-settings";
import { MicIcon, SquareIcon } from "lucide-react";
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
  const [speechCaption, setSpeechCaption] = useState<SpeechCaption | null>(
    null,
  );
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftState, setDraftState] = useState({ threadId: "", text: "" });
  const [editing, setEditing] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [preview, setPreview] = useState<{
    threadId: string;
    id: string;
    text: string;
  } | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const shownDraft = draftState.threadId === threadId ? draftState.text : "";
  const selectedVoiceId = voiceId ?? voices[0]?.id ?? null;
  const activeRef = useRef(false);
  const startingRef = useRef(false);
  const captureHandle = useRef<VoiceCapture | null>(null);
  const pausedRef = useRef(false);
  const mutedRef = useRef(false);
  const speakingRef = useRef(false);
  const editingRef = useRef(false);
  const threadRef = useRef(threadId);
  const draftRef = useRef("");
  const recognizer = useRef<ProgressiveRecognition | null>(null);
  const unfinished = useRef(new Set<string>());
  const utteranceModes = useRef(new Map<string, "dictation" | "control">());
  const utteranceMode = useRef<"dictation" | "control">("dictation");
  const aheadRef = useRef(false);
  const considerRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const sync = (): void => {
      const threadId = threadRef.current;
      if (!threadId) return;
      void window.verbo.queue
        .list(threadId)
        .then((snapshot) => {
          if (threadRef.current !== threadId) return;
          aheadRef.current =
            snapshot.hold ||
            Boolean(snapshot.serviceHold) ||
            snapshot.items.some((item) => item.id !== snapshot.outgoingId);
          considerRef.current();
        })
        .catch(() => undefined);
    };
    sync();
    return window.verbo.queue.subscribe(sync);
  }, []);
  const playToken = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const applyRef = useRef<(result: VoiceDraftResult) => Promise<void>>(
    async () => undefined,
  );
  const speakRef = useRef<
    (text: string, origin: string, messageId: string | null) => Promise<void>
  >(async () => undefined);
  const shownRef = useRef("");
  const captionRef = useRef<SpeechCaption | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
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

  const clearCaption = (): void => {
    if (!captionRef.current && shownRef.current.length === 0) return;
    captionRef.current = null;
    shownRef.current = "";
    setSpeechCaption(null);
  };

  const stopSpeech = (): void => {
    const wasSpeaking = speakingRef.current;
    playToken.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    speakingRef.current = false;
    pausedRef.current = false;
    setSpeaking(false);
    setPaused(false);
    clearCaption();
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
      const id = aui.threadListItem.getState().remoteId;
      if (id)
        await applyRef.current(
          await window.verbo.voice.save({
            threadId: id,
            text: joinSpeech(draftRef.current, result.text),
          }),
        );
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

  const playWav = (
    audio: Uint8Array,
    token: number,
    onProgress: (ratio: number) => void,
  ): Promise<void> => {
    const copy = new Uint8Array(audio.byteLength);
    copy.set(audio);
    const url = URL.createObjectURL(
      new Blob([copy.buffer], { type: "audio/wav" }),
    );
    return new Promise((resolve) => {
      const element = new Audio(url);
      audioRef.current = element;
      let frame = 0;
      let settled = false;
      const stopTick = (): void => {
        if (frame === 0) return;
        cancelAnimationFrame(frame);
        frame = 0;
      };
      const tick = (): void => {
        frame = 0;
        if (token !== playToken.current || audioRef.current !== element) return;
        const duration = element.duration;
        if (Number.isFinite(duration) && duration > 0) {
          onProgress(Math.min(1, element.currentTime / duration));
        }
        frame = requestAnimationFrame(tick);
      };
      const finish = (completed: boolean): void => {
        if (settled) return;
        settled = true;
        stopTick();
        element.onended = null;
        element.onerror = null;
        element.onplay = null;
        URL.revokeObjectURL(url);
        if (audioRef.current === element) audioRef.current = null;
        if (completed && token === playToken.current) onProgress(1);
        resolve();
      };
      const startTick = (): void => {
        if (token !== playToken.current || audioRef.current !== element) return;
        if (frame !== 0) return;
        frame = requestAnimationFrame(tick);
      };
      element.onended = () => finish(true);
      element.onerror = () => finish(false);
      if (token !== playToken.current) {
        finish(false);
        return;
      }
      element.onplay = startTick;
      void element
        .play()
        .then(startTick)
        .catch(() => finish(false));
    });
  };

  const speakText = async (
    text: string,
    origin: string,
    messageId: string | null,
  ): Promise<void> => {
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
    if (messageId) {
      const caption = { messageId, ratio: 0 };
      captionRef.current = caption;
      shownRef.current = "";
      setSpeechCaption(caption);
    }
    const publish = (ratio: number): void => {
      if (!messageId || token !== playToken.current) return;
      const shown = revealTextPrefix(text, ratio);
      if (shown === shownRef.current) return;
      shownRef.current = shown;
      const caption = { messageId, ratio };
      captionRef.current = caption;
      setSpeechCaption(caption);
    };
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (!chunk) continue;
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
        await playWav(result.audio, token, (chunkRatio) => {
          publish(speechProgress({ chunks, index, chunkRatio }));
        });
      }
    } finally {
      if (token === playToken.current) {
        speakingRef.current = false;
        pausedRef.current = false;
        setSpeaking(false);
        setPaused(false);
        clearCaption();
      }
    }
  };

  const flushDraft = async (): Promise<void> => {
    const id = aui.threadListItem.getState().remoteId;
    if (
      !id ||
      editingRef.current ||
      sendingRef.current ||
      hearingRef.current ||
      unfinished.current.size ||
      recognizer.current?.pending
    )
      return;
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
      recognitionPending:
        unfinished.current.size > 0 || recognizer.current?.pending === true,
      hearing: hearingRef.current,
      queueHeld: aheadRef.current,
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

  const stopListening = (): void => {
    listenGen.current += 1;
    startingRef.current = false;
    if (recognizer.current?.pending) void window.verbo.voice.cancel();
    recognizer.current?.stop();
    recognizer.current = null;
    unfinished.current.clear();
    utteranceModes.current.clear();
    setPreview(null);
    setRecognizing(false);
    quietAt.current = null;
    clearEndpoint();
    hearingRef.current = false;
    activeRef.current = false;
    setActive(false);
    captureHandle.current?.stop();
    captureHandle.current = null;
    setCapture("idle");
  };

  const stopSession = (): void => {
    stopListening();
    stopSpeech();
  };

  const toggle = (): void => {
    if (activeRef.current || startingRef.current) {
      stopSession();
      return;
    }
    startingRef.current = true;
    setActive(true);
    const gen = ++listenGen.current;
    setError(null);
    recognizer.current = new ProgressiveRecognition({
      transcribe: (audio) => {
        const language = settingsRef.current.sttLanguage;
        return window.verbo.voice.transcribe({
          audio,
          ...(language === "auto" ? {} : { language }),
        });
      },
      preview: (id, text) => {
        if (
          listenGen.current === gen &&
          utteranceModes.current.get(id) === "dictation" &&
          !editingRef.current
        )
          setPreview({ threadId: threadRef.current, id, text });
      },
      commit: async (utteranceId, text) => {
        if (listenGen.current !== gen) return;
        const mode = utteranceModes.current.get(utteranceId) ?? "control";
        const id = await ensureThread();
        if (listenGen.current !== gen || threadRef.current !== id) return;
        const committed = await window.verbo.voice.commit({
          threadId: id,
          text,
          branchAnchor: anchor(),
          captureMode: mode,
        });
        if (listenGen.current !== gen || threadRef.current !== id) return;
        setPreview((current) => (current?.id === utteranceId ? null : current));
        utteranceModes.current.delete(utteranceId);
        // Recognition finishing gets its own visibility interval, independent of the old silence deadline.
        if (!hearingRef.current) quietAt.current = performance.now();
        if (committed.ok && committed.kind === "command") {
          quietAt.current = null;
          clearEndpoint();
        }
        await applyRef.current(committed);
      },
      error: (message) => {
        if (listenGen.current === gen) {
          setError(message);
          setPreview(null);
          quietAt.current = null;
          clearEndpoint();
        }
      },
      settled: (id) => {
        if (listenGen.current !== gen) return;
        unfinished.current.delete(id);
        setPreview((current) => (current?.id === id ? null : current));
        utteranceModes.current.delete(id);
      },
      pending: (pending) => {
        if (listenGen.current !== gen) return;
        const outstanding =
          pending || unfinished.current.size > 0 || hearingRef.current;
        setRecognizing(outstanding);
        setCapture(
          pending ? "transcribing" : activeRef.current ? "listening" : "idle",
        );
        if (!outstanding) considerRef.current();
      },
    });
    void startVoiceCapture({
      paused: () => pausedRef.current || editingRef.current,
      limits: () => ({
        speechRms: settingsRef.current.speechRms,
        silenceHoldMs: settingsRef.current.silenceHoldMs,
        minSpeechMs: settingsRef.current.minSpeechMs,
        maxSegmentMs: settingsRef.current.maxSegmentMs,
      }),
      onSpeechStart: (id) => {
        if (listenGen.current !== gen) return;
        utteranceMode.current =
          aui.thread().getState().isRunning || aheadRef.current
            ? "control"
            : "dictation";
        utteranceModes.current.set(id, utteranceMode.current);
        unfinished.current.add(id);
        setRecognizing(true);
        hearingRef.current = true;
        quietAt.current = null;
        clearEndpoint();
      },
      onSpeechEnd: (emitted, id) => {
        if (listenGen.current !== gen) return;
        hearingRef.current = false;
        quietAt.current = performance.now();
        if (!emitted) {
          unfinished.current.delete(id);
          recognizer.current?.discard(id);
          utteranceModes.current.delete(id);
          setPreview((current) => (current?.id === id ? null : current));
          considerRef.current();
        }
      },
      onSegmentSkipped: (id) => {
        if (listenGen.current !== gen) return;
        unfinished.current.delete(id);
        recognizer.current?.discard(id);
        utteranceModes.current.delete(id);
        setPreview((current) => (current?.id === id ? null : current));
        if (!hearingRef.current) considerRef.current();
      },
      onSnapshot: (snapshot) => {
        if (listenGen.current !== gen) return;
        if (snapshot.final) unfinished.current.delete(snapshot.id);
        recognizer.current?.enqueue(snapshot);
      },
      onSegment: () => undefined,
    })
      .then((handle) => {
        if (listenGen.current !== gen) {
          handle.stop();
          return;
        }
        captureHandle.current = handle;
        startingRef.current = false;
        activeRef.current = true;
        setActive(true);
        setCapture("listening");
        void window.verbo.voice.status().then((status) => {
          if (listenGen.current !== gen || !status.ok) return;
          setVoices(status.voices);
        });
      })
      .catch((caught: unknown) => {
        if (listenGen.current !== gen) return;
        stopListening();
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

  useLayoutEffect(() => {
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
      void speakRef.current(text, threadId, last?.id ?? null);
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
  const shownPreview =
    preview && preview.threadId === threadId ? preview.text : "";
  const transcript = joinSpeech(shownDraft, shownPreview);
  const showDraft = transcript.length > 0 || editing || recognizing;
  const value: VoiceSessionValue = {
    active,
    draft: shownDraft,
    transcript,
    recognizing,
    muted,
    showDraft,
    speaking,
    speechCaption,
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
  const [editing, setEditing] = useState(false);
  if (!session?.showDraft) return null;
  return (
    <section
      className={threadStyles.userMessageRoot}
      aria-label="Pending voice message"
      data-provisional="true"
    >
      <div className={threadStyles.userContentWrapper}>
        <TextVoiceDraft text={session.transcript || "Recognizing…"} />
        {editing ? (
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
        <div className={styles.actions}>
          <Button
            type="button"
            size="compact-xs"
            variant="subtle"
            disabled={session.recognizing}
            onClick={() => {
              setEditing((value) => !value);
              session.setEditing(!editing);
            }}
          >
            Edit draft
          </Button>
          <Button
            type="button"
            size="xs"
            variant="filled"
            disabled={session.recognizing || !session.draft.trim()}
            onClick={session.sendDraft}
          >
            Send draft
          </Button>
          <Button
            type="button"
            size="xs"
            variant="subtle"
            onClick={session.discardDraft}
          >
            Discard
          </Button>
        </div>
      </div>
    </section>
  );
}

function TextVoiceDraft({ text }: { text: string }): ReactElement {
  return (
    <div className={cx(threadStyles.userMessageContent, styles.transcript)}>
      <span className={styles.pendingLabel}>Voice · pending</span>
      <div>{text}</div>
    </div>
  );
}

export function VoiceOrb(): ReactElement | null {
  const session = useVoiceSession();
  if (!session?.active) return null;
  return (
    <div
      className={styles.orbDock}
      data-state={session.speaking ? "playback" : "listening"}
    >
      <div className={styles.orb}>
        <ChatBlob />
      </div>
    </div>
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
