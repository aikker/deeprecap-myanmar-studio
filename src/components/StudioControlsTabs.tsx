import React, { useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Copy,
  FlipHorizontal2,
  Loader2,
  Minus,
  Play,
  Plus,
  Square,
  Upload,
} from 'lucide-react';
import type {
  AspectRatioOption,
  CaptionFontOption,
  CaptionWeightOption,
  OutputLanguage,
  ProviderStatus,
  StudioConfig,
  StudioMode,
  TranscriptionProvider,
  TtsProvider,
  VideoFitMode,
  VoiceId,
} from '../types/studio';
import { parseJsonResponse } from '../utils/api';
import { ToggleSwitch } from './ToggleSwitch';

export type StudioTab = 'video' | 'voice' | 'captions' | 'extras';

interface StudioControlsTabsProps {
  activeTab: StudioTab;
  onTabChange: (tab: StudioTab) => void;
  config: StudioConfig;
  providerStatus: ProviderStatus;
  onChange: (patch: Partial<StudioConfig>) => void;
  onAddBlurBox: () => void;
  onClearBlurBoxes: () => void;
}

const ASPECT_OPTIONS: Array<{ value: AspectRatioOption; label: string }> = [
  { value: 'original', label: 'Original' },
  { value: '9:16', label: '9:16' },
  { value: '1:1', label: '1:1' },
  { value: '4:5', label: '4:5' },
  { value: '16:9', label: '16:9' },
];

const LANG_OPTIONS: Array<{ value: OutputLanguage; label: string }> = [
  { value: 'my', label: 'မြန်မာ' },
  { value: 'en', label: 'English' },
  { value: 'th', label: 'ไทย' },
];

const FONT_OPTIONS: CaptionFontOption[] = [
  'Noto Sans Myanmar',
  'Pyidaungsu',
  'Padauk',
  'Noto Serif Myanmar',
];

export const StudioControlsTabs: React.FC<StudioControlsTabsProps> = ({
  activeTab,
  onTabChange,
  config,
  providerStatus,
  onChange,
  onAddBlurBox,
  onClearBlurBoxes,
}) => {
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'playing'>(
    'idle'
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copiedCaption, setCopiedCaption] = useState(false);

  const handleVoicePreview = async () => {
    if (previewState === 'playing' && previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      setPreviewState('idle');
      return;
    }

    setPreviewError(null);
    setPreviewState('loading');
    try {
      const res = await fetch('/api/voice/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voiceId: config.voiceId,
          ttsProvider: config.ttsProvider,
          outputLanguage: config.outputLanguage,
          speedPercent: config.speedPercent,
          pitchHz: config.pitchHz,
        }),
      });
      const data = await parseJsonResponse<{
        audioBase64?: string;
        mimeType?: string;
      }>(res);
      if (!data.audioBase64) {
        throw new Error('Voice preview did not return audio.');
      }

      const binary = atob(data.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const wavBlob = new Blob([bytes], { type: data.mimeType || 'audio/wav' });
      const blobUrl = URL.createObjectURL(wavBlob);

      const audio = new Audio(blobUrl);
      previewAudioRef.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(blobUrl);
        setPreviewState('idle');
      };
      audio.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        setPreviewState('idle');
      };
      await audio.play();
      setPreviewState('playing');
    } catch (err) {
      setPreviewError(
        err instanceof Error ? err.message : 'Unable to preview voice.'
      );
      setPreviewState('idle');
    }
  };

  const handleLogoUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onChange({ logoDataUrl: reader.result, logoEnabled: true });
      }
    };
    reader.readAsDataURL(file);
  };

  const handleCopyCaption = async () => {
    try {
      await navigator.clipboard.writeText(config.aiSocialCaption);
      setCopiedCaption(true);
      setTimeout(() => setCopiedCaption(false), 1800);
    } catch {
      // ignore clipboard restriction
    }
  };

  const handleModeSelect = (mode: StudioMode) => {
    // Automatically align Thiha voice when Audio Dub or AI Recap is chosen
    if (mode === 'dub' || mode === 'recap') {
      onChange({
        mode,
        outputLanguage: 'my',
        captionsEnabled: true,
      });
    } else {
      onChange({ mode });
    }
  };

  return (
    <div className="space-y-4">
      {/* Segmented 4-Tab Bar */}
      <div className="grid grid-cols-4 gap-1 rounded-2xl bg-[#E8EEF7] p-1">
        {(
          [
            { id: 'video', label: 'Video' },
            { id: 'voice', label: 'Voice' },
            { id: 'captions', label: 'Captions' },
            { id: 'extras', label: 'Extras' },
          ] as Array<{ id: StudioTab; label: string }>
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={`py-2.5 px-2 rounded-xl text-sm font-semibold transition-all whitespace-nowrap min-h-[42px] ${
              activeTab === tab.id
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* TAB 1: VIDEO */}
      {activeTab === 'video' && (
        <div className="space-y-5">
          {/* Video Title Input (Requirement #5) */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="studio-video-title"
                className="text-sm font-semibold text-slate-800"
              >
                Video title
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Show on video</span>
                <ToggleSwitch
                  checked={config.showTitleOverlay}
                  onChange={(next) => onChange({ showTitleOverlay: next })}
                  ariaLabel="Show video title on video"
                />
              </div>
            </div>
            <input
              id="studio-video-title"
              type="text"
              value={config.videoTitle}
              onChange={(e) => onChange({ videoTitle: e.target.value })}
              placeholder="ဗီဒီယိုခေါင်းစဉ် ထည့်ပါ (ဥပမာ - မမျှော်လင့်ထားတဲ့ အမှန်တရား)..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm font-myanmar text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-[#1D6CE0] focus:outline-none"
            />
          </div>

          {/* Mode Selection: Audio Dub vs AI Recap vs Subtitle (Requirement #2) */}
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-700">Mode</p>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => handleModeSelect('dub')}
                className={`text-left rounded-2xl border p-3 transition-all min-h-[76px] ${
                  config.mode === 'dub'
                    ? 'border-[#1D6CE0] bg-sky-50/60 ring-1 ring-[#1D6CE0]'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                      config.mode === 'dub'
                        ? 'border-[#1D6CE0] bg-[#1D6CE0]'
                        : 'border-slate-300'
                    }`}
                  >
                    {config.mode === 'dub' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    )}
                  </span>
                  <span className="text-sm font-bold text-slate-900 whitespace-nowrap">
                    Audio Dub
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1.5 leading-snug">
                  Thiha voice · Myanmar
                </p>
              </button>

              <button
                type="button"
                onClick={() => handleModeSelect('recap')}
                className={`text-left rounded-2xl border p-3 transition-all min-h-[76px] ${
                  config.mode === 'recap'
                    ? 'border-[#1D6CE0] bg-sky-50/60 ring-1 ring-[#1D6CE0]'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                      config.mode === 'recap'
                        ? 'border-[#1D6CE0] bg-[#1D6CE0]'
                        : 'border-slate-300'
                    }`}
                  >
                    {config.mode === 'recap' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    )}
                  </span>
                  <span className="text-sm font-bold text-slate-900 whitespace-nowrap">
                    AI Recap
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1.5 leading-snug">
                  3–5 min Burmese summary
                </p>
              </button>

              <button
                type="button"
                onClick={() => handleModeSelect('subtitle')}
                className={`text-left rounded-2xl border p-3 transition-all min-h-[76px] ${
                  config.mode === 'subtitle'
                    ? 'border-[#1D6CE0] bg-sky-50/60 ring-1 ring-[#1D6CE0]'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                      config.mode === 'subtitle'
                        ? 'border-[#1D6CE0] bg-[#1D6CE0]'
                        : 'border-slate-300'
                    }`}
                  >
                    {config.mode === 'subtitle' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    )}
                  </span>
                  <span className="text-sm font-bold text-slate-900 whitespace-nowrap">
                    Subtitle
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1.5 leading-snug">
                  Original + Myanmar subs
                </p>
              </button>
            </div>
          </div>

          {/* 3 to 5 Minute Recap Target Length (Requirement #7) */}
          {config.mode === 'recap' && (
            <div className="bg-white rounded-2xl border border-slate-200/80 p-4 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800">
                  Recap target duration
                </span>
                <span className="text-xs font-semibold text-[#1D6CE0]">
                  3–5 minutes · Burmese voiceover
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-100 p-1">
                {([3, 4, 5] as const).map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    onClick={() => onChange({ recapDurationMin: mins })}
                    className={`py-2 rounded-lg text-xs font-semibold transition-colors min-h-[38px] ${
                      config.recapDurationMin === mins
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {mins} minutes
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Aspect Ratio */}
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-700">Ratio</p>
            <div className="grid grid-cols-5 gap-1 rounded-2xl bg-white border border-slate-200/80 p-1">
              {ASPECT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange({ aspectRatio: opt.value })}
                  className={`py-2 px-1 rounded-xl text-xs font-semibold transition-colors whitespace-nowrap min-h-[38px] ${
                    config.aspectRatio === opt.value
                      ? 'bg-[#E8EEF7] text-slate-900'
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Output Language */}
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-700">
              Output language
            </p>
            <div className="grid grid-cols-3 gap-1 rounded-2xl bg-white border border-slate-200/80 p-1">
              {LANG_OPTIONS.map((lang) => (
                <button
                  key={lang.value}
                  type="button"
                  onClick={() => onChange({ outputLanguage: lang.value })}
                  className={`py-2 px-2 rounded-xl text-sm font-semibold font-myanmar transition-colors whitespace-nowrap min-h-[40px] ${
                    config.outputLanguage === lang.value
                      ? 'bg-sky-50 text-[#1D6CE0] border border-[#1D6CE0]/40'
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          </div>

          {/* How the video fits */}
          <div className="space-y-2">
            <p className="text-sm font-semibold text-slate-700">
              How the video fits
            </p>
            <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-white border border-slate-200/80 p-1">
              {(
                [
                  { value: 'contain', label: 'Fit (Full frame)' },
                  { value: 'cover', label: 'Fill (Crop edges)' },
                ] as Array<{ value: VideoFitMode; label: string }>
              ).map((fit) => (
                <button
                  key={fit.value}
                  type="button"
                  onClick={() => onChange({ fitMode: fit.value })}
                  className={`py-2 px-3 rounded-xl text-xs font-semibold transition-colors min-h-[38px] ${
                    config.fitMode === fit.value
                      ? 'bg-[#E8EEF7] text-slate-900'
                      : 'text-slate-500 hover:text-slate-900'
                  }`}
                >
                  {fit.label}
                </button>
              ))}
            </div>
          </div>

          {/* Mirror Flip + Export Quality */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-4 flex items-center justify-between gap-3">
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-sky-50 text-[#1D6CE0] flex items-center justify-center shrink-0 mt-0.5">
                <FlipHorizontal2 className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-800">
                  Mirror Flip
                </p>
                <p className="text-xs text-slate-500 font-myanmar mt-0.5">
                  ဗီဒီယို ဘယ်/ညာ လှန်ရန် · Export 1080p 30fps
                </p>
              </div>
            </div>
            <ToggleSwitch
              checked={Boolean(config.mirrorFlip)}
              onChange={(next) => onChange({ mirrorFlip: next })}
              ariaLabel="Toggle video mirror flip"
            />
          </div>

          {/* AI Engine / Transcription Provider */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-800">
                AI Speech Engine
              </span>
              <span className="text-xs text-slate-500">
                {providerStatus.geminiKeyCount} Google key
                {providerStatus.geminiKeyCount === 1 ? '' : 's'}
                {providerStatus.groqConfigured ? ' · Groq' : ''}
                {providerStatus.assemblyAiConfigured ? ' · AssemblyAI' : ''}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1">
              {(
                [
                  { value: 'auto', label: 'Auto' },
                  { value: 'gemini', label: 'Gemini' },
                  { value: 'groq', label: 'Groq' },
                  { value: 'assemblyai', label: 'Assembly' },
                ] as Array<{ value: TranscriptionProvider; label: string }>
              ).map((eng) => (
                <button
                  key={eng.value}
                  type="button"
                  onClick={() => onChange({ transcriptionProvider: eng.value })}
                  className={`py-2 px-1 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap min-h-[36px] ${
                    config.transcriptionProvider === eng.value
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {eng.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed font-myanmar text-slate-500">
              {config.transcriptionProvider === 'assemblyai' ||
              (config.transcriptionProvider === 'auto' &&
                providerStatus.assemblyAiConfigured)
                ? 'အသံမှ စာသားထုတ်ယူခြင်းကို AssemblyAI ဖြင့်သုံးပြီး ဘာသာပြန်/Recap နှင့် မြန်မာအသံထွက် (Thiha) ကို Gemini ဖြင့် လုပ်ဆောင်ပါမည်။'
                : config.transcriptionProvider === 'groq'
                  ? 'အသံမှ စာသားထုတ်ယူခြင်းကို Groq Whisper ဖြင့်သုံးပြီး မြန်မာအသံထွက် (Thiha) ကို Gemini ဖြင့် လုပ်ဆောင်ပါမည်။'
                  : 'ဗီဒီယိုခွဲခြမ်းစိတ်ဖြာမှု၊ ဘာသာပြန်/Recap နှင့် မြန်မာအသံထွက် (Thiha) အားလုံးကို Gemini ဖြင့် လုပ်ဆောင်ပါမည်။'}
            </p>
          </div>
        </div>
      )}

      {/* TAB 2: VOICE (Screenshot 5) */}
      {activeTab === 'voice' && (
        <div className="space-y-5">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-700">Voice</span>
              <span className="text-slate-500 font-myanmar text-xs">
                2 မြန်မာ voices
              </span>
            </div>

            <div className="flex items-center gap-3 rounded-2xl bg-white border border-slate-200/90 p-3">
              <div className="w-11 h-11 rounded-full bg-sky-100 text-[#1D6CE0] font-bold text-base flex items-center justify-center shrink-0">
                {config.voiceId === 'nilar' ? 'N' : 'T'}
              </div>

              <div className="relative flex-1 min-w-0">
                <select
                  aria-label="Select Myanmar voice model"
                  value={config.voiceId}
                  onChange={(e) =>
                    onChange({ voiceId: e.target.value as VoiceId })
                  }
                  className="w-full appearance-none bg-transparent pr-7 py-0.5 text-sm font-bold text-slate-900 focus:outline-none cursor-pointer"
                >
                  <option value="thiha">Thiha — Male · Myanmar (Burma)</option>
                  <option value="nilar">Nilar — Female · Myanmar (Burma)</option>
                </select>
                <p className="text-xs text-slate-500 truncate">
                  {config.voiceId === 'nilar'
                    ? 'Female · Myanmar (Burma)'
                    : 'Male · Myanmar (Burma)'}
                </p>
                <ChevronDown className="pointer-events-none w-4 h-4 text-slate-400 absolute right-1 top-2" />
              </div>

              <button
                type="button"
                onClick={handleVoicePreview}
                aria-label="Preview Myanmar voice"
                className="w-11 h-11 rounded-full bg-sky-50 hover:bg-sky-100 text-[#1D6CE0] flex items-center justify-center transition-colors shrink-0"
              >
                {previewState === 'loading' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : previewState === 'playing' ? (
                  <Square className="w-4 h-4 fill-current" />
                ) : (
                  <Play className="w-4 h-4 fill-current ml-0.5" />
                )}
              </button>
            </div>

            {previewError && (
              <p className="text-xs text-rose-600">{previewError}</p>
            )}
          </div>

          {/* Voiceover TTS Engine */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-800">
                Voiceover TTS Engine
              </span>
              <span className="text-xs text-slate-500">
                {config.ttsProvider === 'groq' && config.outputLanguage === 'en'
                  ? 'Groq Orpheus'
                  : 'Gemini TTS'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
              {(
                [
                  { value: 'gemini', label: 'Gemini (မြန်မာ · All)' },
                  { value: 'groq', label: 'Groq Orpheus (English)' },
                ] as Array<{ value: TtsProvider; label: string }>
              ).map((tts) => (
                <button
                  key={tts.value}
                  type="button"
                  onClick={() => onChange({ ttsProvider: tts.value })}
                  className={`py-2 px-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap min-h-[36px] ${
                    config.ttsProvider === tts.value
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tts.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed font-myanmar text-slate-500">
              {config.ttsProvider === 'groq'
                ? config.outputLanguage === 'en'
                  ? 'English Voiceover ကို Groq Orpheus (Troy / Hannah) ဖြင့် ထုတ်ပေးပါမည်။'
                  : 'မှတ်ချက် — Groq Orpheus TTS သည် English ဘာသာသီးသန့်သာ ရရှိသဖြင့် မြန်မာ (Thiha/Nilar) အသံထွက်အတွက် Gemini TTS ကို အလိုအလျောက် အသုံးပြုပေးပါမည်။'
                : 'မြန်မာ (Thiha / Nilar) နှင့် ဘာသာစကားအားလုံးအတွက် Gemini TTS ကို အသုံးပြုပါမည်။'}
            </p>
          </div>

          {/* Speed Slider */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-800">Speed</span>
              <span className="font-mono-tabular font-semibold text-[#1D6CE0]">
                {config.speedPercent >= 0
                  ? `+${config.speedPercent}%`
                  : `${config.speedPercent}%`}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Decrease voice speed"
                onClick={() =>
                  onChange({
                    speedPercent: Math.max(-50, config.speedPercent - 5),
                  })
                }
                className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-50 shrink-0"
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                type="range"
                min={-50}
                max={100}
                step={5}
                value={config.speedPercent}
                aria-label="Voice speed"
                onChange={(e) =>
                  onChange({ speedPercent: Number(e.target.value) })
                }
                className="studio-range w-full"
              />
              <button
                type="button"
                aria-label="Increase voice speed"
                onClick={() =>
                  onChange({
                    speedPercent: Math.min(100, config.speedPercent + 5),
                  })
                }
                className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-50 shrink-0"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Pitch Slider */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-800">Pitch</span>
              <span className="font-mono-tabular font-semibold text-[#1D6CE0]">
                {config.pitchHz >= 0
                  ? `+${config.pitchHz}Hz`
                  : `${config.pitchHz}Hz`}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Decrease voice pitch"
                onClick={() =>
                  onChange({ pitchHz: Math.max(-20, config.pitchHz - 2) })
                }
                className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-50 shrink-0"
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                type="range"
                min={-20}
                max={20}
                step={2}
                value={config.pitchHz}
                aria-label="Voice pitch"
                onChange={(e) => onChange({ pitchHz: Number(e.target.value) })}
                className="studio-range w-full"
              />
              <button
                type="button"
                aria-label="Increase voice pitch"
                onClick={() =>
                  onChange({ pitchHz: Math.min(20, config.pitchHz + 2) })
                }
                className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-50 shrink-0"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Original Audio Ducking */}
          <div className="bg-white rounded-2xl border border-slate-200/80 p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-800">
                Background original audio
              </span>
              <span className="font-mono-tabular text-xs font-semibold text-slate-600">
                {Math.round(config.originalAudioMix * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={0.4}
              step={0.05}
              value={config.originalAudioMix}
              aria-label="Original background audio level"
              onChange={(e) =>
                onChange({ originalAudioMix: Number(e.target.value) })
              }
              className="studio-range w-full"
            />
          </div>
        </div>
      )}

      {/* TAB 3: CAPTIONS & BLUR */}
      {activeTab === 'captions' && (
        <div className="space-y-3.5">
          {/* Blur Original Subtitle Band */}
          <div className="rounded-2xl bg-white border border-slate-200/80 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <span className="text-sm font-bold text-slate-900">
                  Blur original subtitles (Band)
                </span>
                <p className="text-xs text-slate-500 font-myanmar mt-0.5">
                  နဂိုစာတန်းနေရာကို အလိုအလျောက် Blur လုပ်ပေးမည်
                </p>
              </div>
              <ToggleSwitch
                checked={config.fullBandCover}
                onChange={(next) => onChange({ fullBandCover: next })}
                ariaLabel="Blur original subtitles with full band"
              />
            </div>

            <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">
                  {config.blurBoxes.length} custom blur box(es)
                </p>
                <p className="text-xs text-slate-500">
                  Draw on video or drag to move
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {config.blurBoxes.length > 0 && (
                  <button
                    type="button"
                    onClick={onClearBlurBoxes}
                    className="px-2.5 py-2 rounded-xl text-xs font-semibold text-slate-500 hover:text-rose-600 min-h-[38px]"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={onAddBlurBox}
                  className="inline-flex items-center gap-1 px-3.5 py-2 rounded-xl bg-sky-50 hover:bg-sky-100 text-[#1D6CE0] text-xs font-bold transition-colors min-h-[38px]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add box
                </button>
              </div>
            </div>

            {(config.fullBandCover || config.blurBoxes.length > 0) && (
              <div className="pt-2 border-t border-slate-100 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-700">
                    Blur intensity
                  </span>
                  <span className="font-mono-tabular font-semibold text-[#1D6CE0]">
                    {config.blurStrength}px
                  </span>
                </div>
                <input
                  type="range"
                  min={4}
                  max={28}
                  step={2}
                  value={config.blurStrength}
                  aria-label="Blur intensity"
                  onChange={(e) =>
                    onChange({ blurStrength: Number(e.target.value) })
                  }
                  className="studio-range w-full"
                />
              </div>
            )}
          </div>

          {/* Captions Toggle */}
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-white border border-slate-200/80 p-4">
            <span className="text-sm font-bold text-slate-900">
              Captions (မြန်မာစာတန်းထိုး)
            </span>
            <ToggleSwitch
              checked={config.captionsEnabled}
              onChange={(next) => onChange({ captionsEnabled: next })}
              ariaLabel="Enable Myanmar captions"
            />
          </div>

          {/* Font Family & Weight */}
          <div className="rounded-2xl bg-white border border-slate-200/80 p-4 space-y-3.5">
            <div className="space-y-1.5">
              <label
                htmlFor="caption-font-select"
                className="block text-sm font-semibold text-slate-800"
              >
                Font family
              </label>
              <div className="relative">
                <select
                  id="caption-font-select"
                  value={config.captionFont}
                  onChange={(e) =>
                    onChange({ captionFont: e.target.value as CaptionFontOption })
                  }
                  className="w-full appearance-none rounded-xl bg-slate-50 border border-slate-200 px-3.5 py-2.5 pr-10 text-sm font-medium text-slate-900 focus:bg-white focus:border-[#1D6CE0] focus:outline-none"
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none w-4 h-4 text-slate-400 absolute right-3 top-3" />
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-semibold text-slate-800">Font style</p>
              <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-100 p-1">
                {(
                  [
                    { value: 'bold', label: 'Bold' },
                    { value: 'normal', label: 'Regular' },
                    { value: 'italic', label: 'Italic' },
                  ] as Array<{ value: CaptionWeightOption; label: string }>
                ).map((w) => (
                  <button
                    key={w.value}
                    type="button"
                    onClick={() => onChange({ captionWeight: w.value })}
                    className={`py-2 px-2 rounded-lg text-xs font-semibold transition-colors min-h-[36px] ${
                      config.captionWeight === w.value
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Text Size */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-slate-800">Font size</span>
                <span className="font-mono-tabular font-semibold text-[#1D6CE0]">
                  {config.captionSize}px
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Decrease caption size"
                  onClick={() =>
                    onChange({
                      captionSize: Math.max(12, config.captionSize - 2),
                    })
                  }
                  className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-100 shrink-0"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <input
                  type="range"
                  min={12}
                  max={40}
                  step={1}
                  value={config.captionSize}
                  aria-label="Caption font size"
                  onChange={(e) =>
                    onChange({ captionSize: Number(e.target.value) })
                  }
                  className="studio-range w-full"
                />
                <button
                  type="button"
                  aria-label="Increase caption size"
                  onClick={() =>
                    onChange({
                      captionSize: Math.min(40, config.captionSize + 2),
                    })
                  }
                  className="w-10 h-10 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-100 shrink-0"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Text Color & Subtitle Background Color / Opacity */}
          <div className="rounded-2xl bg-white border border-slate-200/80 p-4 space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800">
                  Text color
                </span>
                <span className="font-mono-tabular text-xs text-slate-500 uppercase">
                  {config.captionColor}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {['#FFD400', '#FFFFFF', '#38BDF8', '#A3E635', '#FB7185'].map(
                  (hex) => (
                    <button
                      key={hex}
                      type="button"
                      aria-label={`Set text color ${hex}`}
                      onClick={() => onChange({ captionColor: hex })}
                      className={`w-9 h-9 rounded-full border-2 transition-transform ${
                        config.captionColor.toUpperCase() === hex
                          ? 'border-[#1D6CE0] scale-110'
                          : 'border-slate-300'
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  )
                )}
                <label className="relative inline-flex items-center justify-center w-9 h-9 rounded-full border border-slate-300 bg-slate-50 cursor-pointer text-[11px] font-semibold text-slate-600 hover:bg-slate-100">
                  <span>Pick</span>
                  <input
                    type="color"
                    value={config.captionColor}
                    aria-label="Custom subtitle text color"
                    onChange={(e) =>
                      onChange({ captionColor: e.target.value.toUpperCase() })
                    }
                    className="sr-only"
                  />
                </label>
              </div>
            </div>

            <div className="pt-3 border-t border-slate-100 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800">
                  Background color
                </span>
                <span className="font-mono-tabular text-xs text-slate-500 uppercase">
                  {config.captionBgOpacity === 0
                    ? 'Outline only'
                    : config.captionBgColor}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {['#0F172A', '#000000', '#1E293B', '#78350F', '#1E3A8A'].map(
                  (hex) => (
                    <button
                      key={hex}
                      type="button"
                      aria-label={`Set background color ${hex}`}
                      onClick={() =>
                        onChange({
                          captionBgColor: hex,
                          captionBgOpacity:
                            config.captionBgOpacity === 0
                              ? 75
                              : config.captionBgOpacity,
                        })
                      }
                      className={`w-9 h-9 rounded-full border-2 transition-transform ${
                        config.captionBgColor.toUpperCase() === hex &&
                        config.captionBgOpacity > 0
                          ? 'border-[#1D6CE0] scale-110'
                          : 'border-slate-300'
                      }`}
                      style={{ backgroundColor: hex }}
                    />
                  )
                )}
                <label className="relative inline-flex items-center justify-center w-9 h-9 rounded-full border border-slate-300 bg-slate-50 cursor-pointer text-[11px] font-semibold text-slate-600 hover:bg-slate-100">
                  <span>Pick</span>
                  <input
                    type="color"
                    value={config.captionBgColor}
                    aria-label="Custom subtitle background color"
                    onChange={(e) =>
                      onChange({
                        captionBgColor: e.target.value.toUpperCase(),
                        captionBgOpacity:
                          config.captionBgOpacity === 0
                            ? 75
                            : config.captionBgOpacity,
                      })
                    }
                    className="sr-only"
                  />
                </label>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-slate-800">
                  Background opacity
                </span>
                <span className="font-mono-tabular font-semibold text-[#1D6CE0]">
                  {config.captionBgOpacity}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={config.captionBgOpacity}
                aria-label="Subtitle background opacity"
                onChange={(e) =>
                  onChange({ captionBgOpacity: Number(e.target.value) })
                }
                className="studio-range w-full"
              />
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: EXTRAS (Screenshot 1) */}
      {activeTab === 'extras' && (
        <div className="space-y-3.5">
          {/* Watermark text */}
          <div className="rounded-2xl bg-white border border-slate-200/80 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-bold text-slate-900">
                Watermark text
              </span>
              <ToggleSwitch
                checked={config.watermarkEnabled}
                onChange={(next) => onChange({ watermarkEnabled: next })}
                ariaLabel="Toggle watermark text"
              />
            </div>
            {config.watermarkEnabled && (
              <input
                type="text"
                value={config.watermarkText}
                onChange={(e) => onChange({ watermarkText: e.target.value })}
                placeholder="@yourchannel"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-sm text-slate-900 focus:bg-white focus:border-[#1D6CE0] focus:outline-none"
              />
            )}
          </div>

          {/* Logo (round) */}
          <div className="rounded-2xl bg-white border border-slate-200/80 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-slate-900">Logo (round)</p>
                <p className="text-xs text-slate-500 mt-0.5">PNG / JPG</p>
              </div>
              <ToggleSwitch
                checked={config.logoEnabled}
                onChange={(next) => onChange({ logoEnabled: next })}
                ariaLabel="Toggle round logo overlay"
              />
            </div>
            {config.logoEnabled && (
              <div className="flex items-center gap-3">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleLogoUpload(f);
                  }}
                />
                {config.logoDataUrl && (
                  <img
                    src={config.logoDataUrl}
                    alt="Uploaded logo"
                    className="w-10 h-10 rounded-full object-cover border border-slate-200"
                  />
                )}
                <button
                  type="button"
                  onClick={() => logoInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-sky-50 hover:bg-sky-100 text-[#1D6CE0] text-xs font-semibold min-h-[38px]"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {config.logoDataUrl ? 'Change Logo' : 'Upload Logo'}
                </button>
              </div>
            )}
          </div>

          {/* AI Caption + Hashtags */}
          <div className="rounded-2xl bg-white border border-slate-200/80 p-4 space-y-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-slate-900">
                  AI caption + hashtags
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  TikTok caption · hashtags · thumbnail
                </p>
              </div>
              <ToggleSwitch
                checked={config.aiCaptionEnabled}
                onChange={(next) => onChange({ aiCaptionEnabled: next })}
                ariaLabel="Toggle AI caption and hashtags"
              />
            </div>

            {config.aiCaptionEnabled && (
              <>
                <div className="relative">
                  <textarea
                    rows={3}
                    value={config.aiSocialCaption}
                    onChange={(e) =>
                      onChange({ aiSocialCaption: e.target.value })
                    }
                    className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 pr-10 text-sm font-myanmar text-slate-700 focus:bg-white focus:border-[#1D6CE0] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleCopyCaption}
                    aria-label="Copy caption and hashtags"
                    className="absolute right-2 top-2 w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-500 hover:text-[#1D6CE0]"
                  >
                    {copiedCaption ? (
                      <Check className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                </div>

                <div className="flex items-center justify-between gap-3 pt-1">
                  <span className="text-sm font-semibold text-slate-900">
                    Add #fyp
                  </span>
                  <ToggleSwitch
                    checked={config.addFyp}
                    onChange={(next) => onChange({ addFyp: next })}
                    ariaLabel="Include #fyp hashtag"
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
