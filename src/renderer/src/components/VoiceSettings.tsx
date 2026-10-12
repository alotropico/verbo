import { Select, Stack, Switch, Text } from "@mantine/core";
import { useEffect, useState, type ReactElement } from "react";
import type { VoiceStatus } from "@shared/voice";
import type { VoiceSettings } from "@shared/voice-settings";
import { SettingsLabel } from "./SettingsLabel";
import { SettingsSlider } from "./SettingsSlider";
import styles from "./VoiceSettings.module.css";

function useVoiceStatus(): VoiceStatus | null {
  const [status, setStatus] = useState<VoiceStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.verbo.voice
      .status()
      .then((next: VoiceStatus): void => {
        if (!cancelled) setStatus(next);
      })
      .catch((): void => {
        if (!cancelled) {
          setStatus({
            ok: false,
            code: "offline",
            detail: "Voice status failed. Typed chat still works.",
          });
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  return status;
}

function EngineStatus({
  status,
}: {
  status: VoiceStatus | null;
}): ReactElement {
  if (!status)
    return (
      <Text size="xs" c="dimmed" className={styles.engineStatus}>
        Checking the voice service…
      </Text>
    );
  if (!status.ok)
    return (
      <Text size="xs" className={styles.engineStatus}>
        {status.detail}
      </Text>
    );
  const ready = status.stt.ready && status.tts.ready;
  return (
    <Stack
      gap={4}
      className={styles.engineStatus}
      data-ready={ready || undefined}
    >
      <Text size="xs">
        {ready
          ? "Speech engines are ready."
          : "Speech engines are not ready. Typed chat still works."}
      </Text>
      {status.stt.ready ? null : (
        <Text size="xs" c="dimmed">
          {status.stt.detail}
        </Text>
      )}
      {status.tts.ready ? null : (
        <Text size="xs" c="dimmed">
          {status.tts.detail}
        </Text>
      )}
    </Stack>
  );
}

export function ListeningSettings({
  value,
  onChange,
}: {
  value: VoiceSettings;
  onChange: (next: VoiceSettings) => void;
}): ReactElement {
  const status = useVoiceStatus();
  return (
    <Stack gap="md">
      <EngineStatus status={status} />
      <Select
        label={
          <SettingsLabel
            label="Recognition language"
            tip="Detect English or Spanish automatically, or lock recognition to one language."
          />
        }
        data={[
          { value: "auto", label: "Auto-detect English or Spanish" },
          { value: "en", label: "English" },
          { value: "es", label: "Spanish" },
        ]}
        allowDeselect={false}
        value={value.sttLanguage}
        onChange={(next) => {
          if (next === "auto" || next === "en" || next === "es") {
            onChange({ ...value, sttLanguage: next });
          }
        }}
      />
      <SettingsSlider
        label="Microphone threshold"
        description="Raise this to ignore background noise. Lower it if quiet speech is missed."
        value={value.speechRms}
        min={0.005}
        max={0.12}
        step={0.005}
        display={value.speechRms.toFixed(3)}
        onChange={(speechRms) =>
          onChange({
            ...value,
            speechRms: Math.round(speechRms * 1000) / 1000,
          })
        }
      />
      <SettingsSlider
        label="Pause between phrases"
        description="How long to wait in silence before transcribing a phrase."
        value={value.silenceHoldMs}
        min={300}
        max={2500}
        step={100}
        display={`${(value.silenceHoldMs / 1000).toFixed(1)} s`}
        onChange={(silenceHoldMs) => onChange({ ...value, silenceHoldMs })}
      />
      <SettingsSlider
        label="Shortest phrase"
        description="Ignore sounds shorter than this."
        value={value.minSpeechMs}
        min={100}
        max={1500}
        step={50}
        display={`${value.minSpeechMs} ms`}
        onChange={(minSpeechMs) => onChange({ ...value, minSpeechMs })}
      />
      <SettingsSlider
        label="Longest phrase"
        description="Split continuous speech into phrases of this length."
        value={value.maxSegmentMs}
        min={5000}
        max={60000}
        step={1000}
        display={`${value.maxSegmentMs / 1000} s`}
        onChange={(maxSegmentMs) => onChange({ ...value, maxSegmentMs })}
      />
      <SettingsSlider
        label="Send after silence"
        description="Send the voice draft after this pause. Sending waits while you edit or a reply is running."
        value={value.silenceSendMs}
        min={400}
        max={8000}
        step={100}
        display={`${(value.silenceSendMs / 1000).toFixed(1)} s`}
        onChange={(silenceSendMs) => onChange({ ...value, silenceSendMs })}
      />
    </Stack>
  );
}

export function SpeechSettings({
  value,
  onChange,
}: {
  value: VoiceSettings;
  onChange: (next: VoiceSettings) => void;
}): ReactElement {
  const status = useVoiceStatus();
  const installed = status?.ok ? status.voices : [];
  const known = installed.some((voice) => voice.id === value.voiceId);
  const choices = [
    ...(value.voiceId && !known
      ? [{ value: value.voiceId, label: `${value.voiceId} (saved)` }]
      : []),
    ...installed.map((voice) => ({
      value: voice.id,
      label: `${voice.id} (${voice.language})`,
    })),
  ];
  return (
    <Stack gap="md">
      <EngineStatus status={status} />
      <Switch
        label={
          <SettingsLabel
            label="Speak replies"
            tip="Read answers aloud. The microphone pauses during playback."
          />
        }
        checked={value.speakReplies}
        onChange={(event) =>
          onChange({ ...value, speakReplies: event.currentTarget.checked })
        }
      />
      <Select
        label={
          <SettingsLabel
            label="Reply voice"
            tip="Choose an installed voice. An empty choice uses the first available voice."
          />
        }
        data={choices}
        placeholder="First installed voice"
        clearable
        value={value.voiceId || null}
        onChange={(voiceId) => onChange({ ...value, voiceId: voiceId ?? "" })}
        nothingFoundMessage="No voice installed"
      />
      <SettingsSlider
        label="Playback limit"
        description="Long answers are split into parts. Read up to this many parts aloud."
        value={value.maxSpokenChunks}
        min={1}
        max={4}
        step={1}
        display={String(value.maxSpokenChunks)}
        onChange={(maxSpokenChunks) => onChange({ ...value, maxSpokenChunks })}
      />
    </Stack>
  );
}
