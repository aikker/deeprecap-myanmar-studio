export type StudioMode = 'dub' | 'recap' | 'subtitle';

export type AspectRatioOption = 'original' | '9:16' | '1:1' | '4:5' | '16:9';

export type OutputLanguage = 'my' | 'en' | 'th';

export type VideoFitMode = 'contain' | 'cover';

export type VoiceId = 'thiha' | 'nilar';

export type CaptionFontOption =
  | 'Noto Sans Myanmar'
  | 'Pyidaungsu'
  | 'Padauk'
  | 'Noto Serif Myanmar';

export type CaptionWeightOption = 'bold' | 'normal' | 'italic';

export type CaptionStyleOption = 'yellow-outline' | 'white-outline' | 'boxed-dark';

export interface BlurBox {
  id: string;
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  w: number; // normalized 0..1
  h: number; // normalized 0..1
}

export interface SubtitleSegment {
  id: string;
  startSec: number;
  endSec: number;
  sourceStartSec: number;
  sourceEndSec: number;
  myanmarText: string;
  englishMeaning?: string;
  emotionStyle?: string;
}

export interface VideoAsset {
  videoId: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  previewUrl: string;
  thumbnailUrl?: string;
  sourceType: 'file' | 'youtube' | 'demo';
  youtubeUrl?: string;
  hasDownloadableStream: boolean;
}

export type TranscriptionProvider = 'auto' | 'gemini' | 'groq' | 'assemblyai';

export type TtsProvider = 'gemini' | 'groq';

export interface ProviderStatus {
  geminiKeyCount: number;
  groqConfigured: boolean;
  assemblyAiConfigured: boolean;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
}

export interface GitHubAuthStatus {
  configured: boolean;
  connected: boolean;
  hasRepoScope?: boolean;
  user: GitHubUser | null;
}

export interface StudioConfig {
  videoTitle: string;
  showTitleOverlay: boolean;
  mode: StudioMode;
  recapDurationMin: 3 | 4 | 5;
  aspectRatio: AspectRatioOption;
  fitMode: VideoFitMode;
  mirrorFlip: boolean;
  outputLanguage: OutputLanguage;
  transcriptionProvider: TranscriptionProvider;
  ttsProvider: TtsProvider;
  voiceId: VoiceId;
  speedPercent: number; // -50 to 100
  pitchHz: number; // -20 to 20
  originalAudioMix: number; // 0 to 1
  captionsEnabled: boolean;
  captionFont: CaptionFontOption;
  captionWeight: CaptionWeightOption;
  captionSize: number; // 12 to 40
  captionStyle: CaptionStyleOption;
  captionColor: string; // hex e.g. #FFD400
  captionBgColor: string; // hex e.g. #000000
  captionBgOpacity: number; // 0 to 100
  blurBoxes: BlurBox[];
  fullBandCover: boolean;
  blurStrength: number; // 4 to 28
  watermarkEnabled: boolean;
  watermarkText: string;
  logoEnabled: boolean;
  logoDataUrl?: string;
  aiCaptionEnabled: boolean;
  aiSocialCaption: string;
  addFyp: boolean;
}

export interface TelegramAccount {
  chatId: string;
  botToken?: string;
  botUsername?: string | null;
  accountLabel?: string | null;
  username?: string | null;
  firstName?: string | null;
}

export interface TelegramAuthStatus {
  configured: boolean;
  botUsername: string | null;
  connected: boolean;
  account: {
    chatId: string;
    botUsername?: string | null;
    accountLabel?: string | null;
    username?: string | null;
    firstName?: string | null;
  } | null;
}

export interface ProcessJobStatus {
  jobId: string;
  userId?: string;
  status: 'queued' | 'analyzing' | 'translating' | 'voicing' | 'rendering' | 'completed' | 'failed';
  progress: number;
  stepLabel: string;
  error?: string;
  telegramStatus?: 'pending' | 'sent' | 'failed' | 'skipped';
  telegramError?: string;
  createdAt?: number;
  completedAt?: number;
  expiresAt?: number;
  result?: {
    outputVideoUrl: string;
    outputAudioUrl?: string;
    outputSrtUrl: string;
    finalTitle: string;
    socialCaption: string;
    durationSec: number;
    segments: SubtitleSegment[];
  };
}

export interface VideoHistoryItem {
  jobId: string;
  userId?: string;
  videoId: string;
  title: string;
  mode: StudioMode;
  aspectRatio: AspectRatioOption;
  outputLanguage: OutputLanguage;
  mirrorFlip: boolean;
  status: ProcessJobStatus['status'];
  progress: number;
  stepLabel: string;
  error?: string;
  telegramStatus?: 'pending' | 'sent' | 'failed' | 'skipped';
  telegramError?: string;
  createdAt: number;
  completedAt?: number;
  expiresAt: number;
  result?: ProcessJobStatus['result'];
}
