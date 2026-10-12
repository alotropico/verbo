import type { VoiceInfo } from "@shared/voice";
import { createContext, useContext } from "react";

export type VoiceSessionValue = {
  active: boolean;
  draft: string;
  muted: boolean;
  showDraft: boolean;
  speaking: boolean;
  status: string;
  visible: boolean;
  voiceId: string | null;
  voices: VoiceInfo[];
  discardDraft: () => void;
  sendDraft: () => void;
  setDraft: (text: string) => void;
  setEditing: (editing: boolean) => void;
  setVoiceId: (voiceId: string) => void;
  stopSpeech: () => void;
  toggle: () => void;
  toggleMuted: () => void;
  blurDraft: () => void;
};

export const VoiceSessionContext = createContext<VoiceSessionValue | null>(
  null,
);

export function useVoiceSession(): VoiceSessionValue | null {
  return useContext(VoiceSessionContext);
}

export function useVoiceListening(): boolean {
  return useVoiceSession()?.active ?? false;
}
