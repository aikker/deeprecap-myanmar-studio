import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Github,
  History,
  Loader2,
  LogOut,
  Play,
  RotateCcw,
  Send,
  Sparkles,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { HistoryPanel } from './components/HistoryPanel';
import { ResultDownloadPanel } from './components/ResultDownloadPanel';
import {
  StudioControlsTabs,
  type StudioTab,
} from './components/StudioControlsTabs';
import { VideoIntakePanel } from './components/VideoIntakePanel';
import { VideoStudioPlayer } from './components/VideoStudioPlayer';
import {
  auth,
  getFirebaseAuthHeaders,
  googleProvider,
} from './lib/firebase';
import {
  deleteUserTelegramSettings,
  deleteUserVideoJob,
  ensureUserProfile,
  loadUserStudioSettings,
  loadUserTelegramSettings,
  loadUserVideoJobs,
  saveUserStudioSettings,
  saveUserTelegramSettings,
  syncUserVideoJob,
  type UserTelegramCreds,
} from './lib/firestoreStore';
import type {
  AspectRatioOption,
  BlurBox,
  GitHubAuthStatus,
  ProcessJobStatus,
  ProviderStatus,
  StudioConfig,
  SubtitleSegment,
  TelegramAuthStatus,
  VideoAsset,
  VideoHistoryItem,
} from './types/studio';
import {
  parseJsonResponse,
  refreshAuthBridgeSession,
  safeApiFetch,
} from './utils/api';

const LAST_CONFIG_KEY = 'dr_last_config_v1';
const ACTIVE_JOB_KEY = 'dr_active_job_id';

const ASPECT_CYCLE: AspectRatioOption[] = [
  'original',
  '9:16',
  '1:1',
  '4:5',
  '16:9',
];

function createDefaultConfig(title = ''): StudioConfig {
  return {
    videoTitle: title,
    showTitleOverlay: true,
    mode: 'dub',
    recapDurationMin: 4,
    aspectRatio: 'original',
    fitMode: 'contain',
    mirrorFlip: false,
    outputLanguage: 'my',
    transcriptionProvider: 'auto',
    ttsProvider: 'gemini',
    voiceId: 'thiha',
    speedPercent: 15,
    pitchHz: 0,
    originalAudioMix: 0,
    captionsEnabled: true,
    captionFont: 'Noto Sans Myanmar',
    captionWeight: 'bold',
    captionSize: 18,
    captionStyle: 'yellow-outline',
    captionColor: '#FFD400',
    captionBgColor: '#0F172A',
    captionBgOpacity: 0,
    blurBoxes: [],
    fullBandCover: false,
    blurStrength: 16,
    watermarkEnabled: false,
    watermarkText: '',
    logoEnabled: false,
    aiCaptionEnabled: true,
    aiSocialCaption:
      '#shortdramareview #myanmartiktok #ဘာသာပြန်ဇာတ်လမ်းများ #fyp',
    addFyp: true,
  };
}

function loadSavedLocalConfig(): Partial<StudioConfig> | null {
  try {
    const raw = localStorage.getItem(LAST_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StudioConfig>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function persistLocalConfig(cfg: StudioConfig): void {
  const toSave: Partial<StudioConfig> = { ...cfg, videoTitle: '' };
  try {
    localStorage.setItem(LAST_CONFIG_KEY, JSON.stringify(toSave));
  } catch {
    try {
      const { logoDataUrl: _omit, ...withoutLogo } = toSave;
      localStorage.setItem(LAST_CONFIG_KEY, JSON.stringify(withoutLogo));
    } catch {
      // ignore storage errors
    }
  }
}

function formatDurationBadge(sec: number): string {
  const safe = Math.max(0, Math.round(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function App() {
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authSigningIn, setAuthSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [view, setView] = useState<'studio' | 'guide'>('studio');
  const [asset, setAsset] = useState<VideoAsset | null>(null);
  const [config, setConfig] = useState<StudioConfig>(() => ({
    ...createDefaultConfig(),
    ...(loadSavedLocalConfig() || {}),
    videoTitle: '',
  }));
  const [activeTab, setActiveTab] = useState<StudioTab>('video');
  const [activeTool, setActiveTool] = useState<'edit' | 'crop' | 'done'>('edit');

  const [job, setJob] = useState<ProcessJobStatus | null>(null);
  const [editableSegments, setEditableSegments] = useState<SubtitleSegment[]>(
    []
  );
  const [seekToSec, setSeekToSec] = useState<number | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus>({
    geminiKeyCount: 1,
    groqConfigured: false,
    assemblyAiConfigured: false,
  });
  const [githubAuth, setGithubAuth] = useState<GitHubAuthStatus>({
    configured: false,
    connected: false,
    user: null,
  });
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  const [showDeviceFallback, setShowDeviceFallback] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<{
    flowId: string;
    userCode: string;
    verificationUri: string;
    interval: number;
  } | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [showPushRepoPanel, setShowPushRepoPanel] = useState(false);
  const [repoName, setRepoName] = useState('deeprecap-myanmar-studio');
  const [repoPrivate, setRepoPrivate] = useState(false);
  const [pushingRepo, setPushingRepo] = useState(false);
  const [pushRepoResult, setPushRepoResult] = useState<{
    repoUrl: string;
    commitUrl: string;
    filesCount: number;
  } | null>(null);

  const [historyItems, setHistoryItems] = useState<VideoHistoryItem[]>([]);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);

  const [telegramAuth, setTelegramAuth] = useState<TelegramAuthStatus>({
    configured: false,
    botUsername: null,
    connected: false,
    account: null,
  });
  const [savedTelegramCreds, setSavedTelegramCreds] =
    useState<UserTelegramCreds | null>(null);
  const [showTelegramPanel, setShowTelegramPanel] = useState(false);
  const [tgBotTokenInput, setTgBotTokenInput] = useState('');
  const [tgChatIdInput, setTgChatIdInput] = useState('');
  const [showTgToken, setShowTgToken] = useState(false);
  const [tgSaving, setTgSaving] = useState(false);
  const [tgDetecting, setTgDetecting] = useState(false);
  const [telegramNotice, setTelegramNotice] = useState<string | null>(null);

  const configSaveTimerRef = useRef<number | null>(null);

  const getGhHeaders = (): Record<string, string> => {
    const token = sessionStorage.getItem('dr_gh_session_token') || '';
    return token ? { 'x-github-session': token } : {};
  };

  const refreshGitHubStatus = () => {
    safeApiFetch(
      '/api/auth/github/status',
      { headers: { Accept: 'application/json', ...getGhHeaders() } },
      20_000
    )
      .then((res) => parseJsonResponse<GitHubAuthStatus>(res))
      .then((status) => setGithubAuth(status))
      .catch(() => {});
  };

  const refreshTelegramStatus = useCallback(async () => {
    if (!auth.currentUser) return;
    try {
      const headers = await getFirebaseAuthHeaders();
      const res = await safeApiFetch(
        '/api/telegram/status',
        { headers: { Accept: 'application/json', ...headers } },
        20_000
      );
      if (!res.ok) return;
      const status = await parseJsonResponse<TelegramAuthStatus>(res);
      setTelegramAuth(status);
    } catch {
      // ignore transient errors
    }
  }, []);

  const refreshHistory = useCallback(async (): Promise<VideoHistoryItem[]> => {
    const currentUser = auth.currentUser;
    if (!currentUser) return [];
    try {
      const headers = await getFirebaseAuthHeaders();
      const [serverItems, fsItems] = await Promise.all([
        safeApiFetch(
          '/api/studio/history',
          { headers: { Accept: 'application/json', ...headers } },
          20_000
        )
          .then((res) =>
            res.ok ? parseJsonResponse<{ items: VideoHistoryItem[] }>(res) : { items: [] }
          )
          .then((d) => (Array.isArray(d.items) ? d.items : []))
          .catch(() => [] as VideoHistoryItem[]),
        loadUserVideoJobs(currentUser.uid).catch(() => [] as VideoHistoryItem[]),
      ]);

      const now = Date.now();
      const mergedMap = new Map<string, VideoHistoryItem>();
      for (const item of fsItems) {
        if (item.expiresAt > now) mergedMap.set(item.jobId, item);
      }
      for (const sItem of serverItems) {
        if (sItem.expiresAt <= now) continue;
        const prev = mergedMap.get(sItem.jobId);
        mergedMap.set(sItem.jobId, sItem);
        // Keep Firestore updated with latest server status/result
        if (
          !prev ||
          prev.status !== sItem.status ||
          prev.progress !== sItem.progress ||
          prev.telegramStatus !== sItem.telegramStatus
        ) {
          void syncUserVideoJob(currentUser.uid, sItem).catch(() => {});
        }
      }

      const merged = Array.from(mergedMap.values()).sort(
        (a, b) => b.createdAt - a.createdAt
      );
      setHistoryItems(merged);
      return merged;
    } catch {
      return [];
    }
  }, []);

  const restoreAssetForHistoryItem = useCallback(
    async (item: Pick<VideoHistoryItem, 'videoId' | 'title' | 'result'>) => {
      try {
        const res = await safeApiFetch(
          `/api/studio/asset/${item.videoId}`,
          { headers: { Accept: 'application/json' } },
          20_000
        );
        if (res.ok) {
          const loaded = await parseJsonResponse<VideoAsset>(res);
          setAsset(loaded);
          return;
        }
      } catch {
        // fallback below
      }
      if (item.result?.outputVideoUrl) {
        setAsset({
          videoId: item.videoId,
          title: item.result.finalTitle || item.title,
          duration: item.result.durationSec || 0,
          width: 1920,
          height: 1080,
          previewUrl: item.result.outputVideoUrl,
          sourceType: 'file',
          hasDownloadableStream: true,
        });
      }
    },
    []
  );

  const syncJobFromServer = useCallback(
    async (jobId: string, knownHistory?: VideoHistoryItem[]) => {
      const currentUser = auth.currentUser;
      if (!currentUser) return;
      try {
        const headers = await getFirebaseAuthHeaders();
        const res = await safeApiFetch(
          `/api/studio/job/${jobId}`,
          { headers: { Accept: 'application/json', ...headers } },
          20_000
        );
        if (!res.ok) {
          if (res.status === 404) {
            localStorage.removeItem(ACTIVE_JOB_KEY);
          }
          return;
        }
        const latest = await parseJsonResponse<ProcessJobStatus>(res);
        setJob(latest);

        const list = knownHistory || historyItems;
        const match = list.find((h) => h.jobId === jobId);

        if (match) {
          const updatedItem: VideoHistoryItem = {
            ...match,
            userId: currentUser.uid,
            title: latest.result?.finalTitle || match.title,
            status: latest.status,
            progress: latest.progress,
            stepLabel: latest.stepLabel,
            error: latest.error,
            telegramStatus: latest.telegramStatus,
            telegramError: latest.telegramError,
            completedAt: latest.completedAt,
            expiresAt: latest.expiresAt || match.expiresAt,
            result: latest.result,
          };
          void syncUserVideoJob(currentUser.uid, updatedItem).catch(() => {});
        }

        if (latest.status === 'completed' && latest.result) {
          setEditableSegments(latest.result.segments);
          setConfig((prev) => ({
            ...prev,
            videoTitle: latest.result?.finalTitle || prev.videoTitle,
            aiSocialCaption:
              latest.result?.socialCaption || prev.aiSocialCaption,
          }));
          if (latest.telegramStatus !== 'pending') {
            localStorage.removeItem(ACTIVE_JOB_KEY);
          }
          void refreshHistory();
        } else if (latest.status === 'failed') {
          localStorage.removeItem(ACTIVE_JOB_KEY);
          void refreshHistory();
        }

        if (!asset && match) {
          void restoreAssetForHistoryItem(match);
        }
      } catch {
        // transient network error
      }
    },
    [asset, historyItems, refreshHistory, restoreAssetForHistoryItem]
  );

  useEffect(() => {
    safeApiFetch(
      '/api/providers/status',
      { headers: { Accept: 'application/json' } },
      20_000
    )
      .then((res) => parseJsonResponse<ProviderStatus>(res))
      .then((status) => setProviderStatus(status))
      .catch(() => {});
    refreshGitHubStatus();

    // Keep Shared App (ais-pre) 60s auth-bridge session warm while tab is visible
    const keepAliveTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshAuthBridgeSession();
      }
    }, 45_000);
    return () => window.clearInterval(keepAliveTimer);
  }, []);

  // Listen to Firebase Google Auth state & hydrate per-user cloud data
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setAuthUser(user);
      setAuthReady(true);

      if (!user) {
        setHistoryItems([]);
        setSavedTelegramCreds(null);
        setTelegramAuth({
          configured: false,
          botUsername: null,
          connected: false,
          account: null,
        });
        return;
      }

      try {
        await ensureUserProfile(user);
        const headers = await getFirebaseAuthHeaders();

        const [fsConfig, fsTg, items] = await Promise.all([
          loadUserStudioSettings(user.uid).catch(() => null),
          loadUserTelegramSettings(user.uid).catch(() => null),
          refreshHistory(),
        ]);

        if (fsConfig) {
          setConfig((prev) => {
            const next = {
              ...prev,
              ...fsConfig,
              videoTitle: prev.videoTitle,
            };
            persistLocalConfig(next);
            return next;
          });
        } else {
          // Check server fallback if user had no Firestore config yet
          safeApiFetch(
            '/api/studio/config',
            { headers: { Accept: 'application/json', ...headers } },
            20_000
          )
            .then((r) =>
              r.ok
                ? parseJsonResponse<{ config: Partial<StudioConfig> | null }>(r)
                : { config: null }
            )
            .then((d) => {
              if (d.config) {
                setConfig((prev) => ({
                  ...prev,
                  ...d.config,
                  videoTitle: prev.videoTitle,
                }));
              }
            })
            .catch(() => {});
        }

        if (fsTg) {
          setSavedTelegramCreds(fsTg);
          setTgBotTokenInput(fsTg.botToken);
          setTgChatIdInput(fsTg.chatId);
          // Silently sync user's saved Bot Token + Chat ID to this server container (for shared links & phone screen-off cloud sends)
          const syncRes = await safeApiFetch(
            '/api/telegram/sync',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                ...headers,
              },
              body: JSON.stringify({ account: fsTg }),
            },
            20_000
          ).catch(() => null);
          if (syncRes?.ok) {
            const st = await parseJsonResponse<TelegramAuthStatus>(syncRes);
            setTelegramAuth(st);
          }
        } else {
          await refreshTelegramStatus();
        }

        const savedJobId = localStorage.getItem(ACTIVE_JOB_KEY);
        const runningInHistory = items.find(
          (h) => h.status !== 'completed' && h.status !== 'failed'
        );
        const targetJobId = savedJobId || runningInHistory?.jobId;
        if (targetJobId) {
          localStorage.setItem(ACTIVE_JOB_KEY, targetJobId);
          void syncJobFromServer(targetJobId, items);
        }
      } catch (err) {
        console.error('Failed to hydrate user cloud workspace:', err);
      }
    });

    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const origin = event.origin || '';
      if (
        origin !== window.location.origin &&
        !origin.endsWith('.run.app') &&
        !origin.includes('localhost')
      ) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        if (typeof event.data?.sessionToken === 'string') {
          sessionStorage.setItem('dr_gh_session_token', event.data.sessionToken);
        }
        setGithubNotice(null);
        setShowDeviceFallback(false);
        setDeviceFlow(null);
        refreshGitHubStatus();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (!deviceFlow) return;
    const waitMs = Math.max(5000, (deviceFlow.interval || 5) * 1000);
    const timer = window.setInterval(async () => {
      try {
        const res = await safeApiFetch(
          '/api/auth/github/device/poll',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ flowId: deviceFlow.flowId }),
          },
          20_000
        );
        const data = await parseJsonResponse<{
          status?: string;
          sessionToken?: string;
        }>(res);
        if (data.status === 'connected') {
          if (data.sessionToken) {
            sessionStorage.setItem('dr_gh_session_token', data.sessionToken);
          }
          setDeviceFlow(null);
          setShowDeviceFallback(false);
          setGithubNotice(null);
          refreshGitHubStatus();
        }
      } catch (err) {
        setGithubNotice(
          err instanceof Error ? err.message : 'GitHub authorization expired.'
        );
        setDeviceFlow(null);
      }
    }, waitMs);

    return () => window.clearInterval(timer);
  }, [deviceFlow]);

  const handleConnectGitHub = async () => {
    setGithubNotice(null);
    setShowDeviceFallback(true);
    try {
      const res = await safeApiFetch(
        `/api/auth/github/url?origin=${encodeURIComponent(window.location.origin)}`,
        { headers: { Accept: 'application/json' } },
        20_000
      );
      const data = await parseJsonResponse<{ url?: string }>(res);
      if (!data.url) {
        throw new Error('Could not generate GitHub OAuth URL.');
      }
      const authWindow = window.open(
        data.url,
        'github_oauth_popup',
        'width=600,height=700'
      );
      if (!authWindow) {
        setGithubNotice(
          'Popup blocked by browser — use the 8-digit Code option below or allow popups.'
        );
      }
    } catch (err) {
      setGithubNotice(
        err instanceof Error ? err.message : 'Unable to connect GitHub.'
      );
    }
  };

  const handleStartDeviceFlow = async () => {
    setGithubNotice(null);
    try {
      const res = await safeApiFetch(
        '/api/auth/github/device/start',
        {
          method: 'POST',
          headers: { Accept: 'application/json' },
        },
        20_000
      );
      const data = await parseJsonResponse<{
        flowId: string;
        userCode: string;
        verificationUri: string;
        interval: number;
      }>(res);
      setDeviceFlow(data);
    } catch (err) {
      setGithubNotice(
        err instanceof Error
          ? err.message
          : 'Enable "Enable Device Flow" in GitHub OAuth App settings first.'
      );
    }
  };

  const handleDisconnectGitHub = async () => {
    try {
      await safeApiFetch(
        '/api/auth/github/logout',
        {
          method: 'POST',
          headers: { Accept: 'application/json', ...getGhHeaders() },
        },
        20_000
      );
      sessionStorage.removeItem('dr_gh_session_token');
      setShowPushRepoPanel(false);
      setPushRepoResult(null);
      refreshGitHubStatus();
    } catch {
      // ignore
    }
  };

  const handleReconnectForRepo = async () => {
    await handleDisconnectGitHub();
    void handleConnectGitHub();
  };

  const handlePushToGitHub = async () => {
    if (pushingRepo) return;
    setGithubNotice(null);
    setPushRepoResult(null);
    setPushingRepo(true);
    try {
      const res = await safeApiFetch(
        '/api/github/push-repo',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...getGhHeaders(),
          },
          body: JSON.stringify({
            repoName: repoName.trim() || 'deeprecap-myanmar-studio',
            isPrivate: repoPrivate,
          }),
        },
        45_000
      );
      const data = await parseJsonResponse<{
        repoUrl: string;
        commitUrl: string;
        filesCount: number;
      }>(res);
      setPushRepoResult(data);
    } catch (err) {
      setGithubNotice(
        err instanceof Error ? err.message : 'Unable to push project to GitHub.'
      );
    } finally {
      setPushingRepo(false);
    }
  };

  const isProcessing = Boolean(
    job && job.status !== 'completed' && job.status !== 'failed'
  );
  const shouldPollJob = Boolean(
    job &&
      (job.status !== 'completed' && job.status !== 'failed'
        ? true
        : job.status === 'completed' && job.telegramStatus === 'pending')
  );

  // Poll active background processing job (and Telegram delivery confirmation)
  useEffect(() => {
    if (!job || !shouldPollJob) return;

    const timer = window.setInterval(() => {
      void syncJobFromServer(job.jobId);
    }, 1500);

    return () => window.clearInterval(timer);
  }, [job, shouldPollJob, syncJobFromServer]);

  // Immediately re-sync cloud job & history when user turns phone screen back on
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible' || !auth.currentUser) return;
      void refreshHistory();
      const targetJobId = job?.jobId || localStorage.getItem(ACTIVE_JOB_KEY);
      if (targetJobId) {
        void syncJobFromServer(targetJobId);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [job?.jobId, refreshHistory, syncJobFromServer]);

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setAuthSigningIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (
        code === 'auth/popup-blocked' ||
        code === 'auth/operation-not-supported-in-this-environment'
      ) {
        try {
          await signInWithRedirect(auth, googleProvider);
          return;
        } catch (redirectErr) {
          setAuthError(
            redirectErr instanceof Error
              ? redirectErr.message
              : 'Google account ဖြင့် Login ဝင်၍မရပါ။ ထပ်မံကြိုးစားပါ။'
          );
        }
      } else {
        setAuthError(
          err instanceof Error
            ? err.message
            : 'Google account ဖြင့် Login ဝင်၍မရပါ။ ထပ်မံကြိုးစားပါ။'
        );
      }
    } finally {
      setAuthSigningIn(false);
    }
  };

  const handleGoogleSignOut = async () => {
    try {
      await signOut(auth);
      setAsset(null);
      setJob(null);
      setEditableSegments([]);
      localStorage.removeItem(ACTIVE_JOB_KEY);
    } catch {
      // ignore
    }
  };

  const handleConnectTelegramCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authUser) return;
    setTelegramNotice(null);
    setTgSaving(true);
    try {
      const headers = await getFirebaseAuthHeaders();
      const res = await safeApiFetch('/api/telegram/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          botToken: tgBotTokenInput.trim(),
          chatId: tgChatIdInput.trim(),
        }),
      });
      const data = await parseJsonResponse<{
        status: TelegramAuthStatus;
        account: UserTelegramCreds;
      }>(res);
      setTelegramAuth(data.status);
      const nextCreds: UserTelegramCreds = {
        botToken: tgBotTokenInput.trim(),
        chatId: data.account?.chatId || tgChatIdInput.trim(),
        botUsername: data.status.botUsername || undefined,
        accountLabel: data.status.account?.accountLabel || undefined,
      };
      setSavedTelegramCreds(nextCreds);
      await saveUserTelegramSettings(authUser.uid, nextCreds);
      setTelegramNotice(null);
    } catch (err) {
      setTelegramNotice(
        err instanceof Error ? err.message : 'Telegram ချိတ်ဆက်၍ မရပါ။'
      );
    } finally {
      setTgSaving(false);
    }
  };

  const handleAutoDetectChatId = async () => {
    setTelegramNotice(null);
    setTgDetecting(true);
    try {
      const headers = await getFirebaseAuthHeaders();
      const res = await safeApiFetch('/api/telegram/detect-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ botToken: tgBotTokenInput.trim() }),
      });
      const data = await parseJsonResponse<{
        chatId: string;
        botUsername: string;
        label: string;
      }>(res);
      setTgChatIdInput(data.chatId);
    } catch (err) {
      setTelegramNotice(
        err instanceof Error ? err.message : 'Chat ID ရှာ၍မရပါ။'
      );
    } finally {
      setTgDetecting(false);
    }
  };

  const handleDisconnectTelegram = async () => {
    if (!authUser) return;
    try {
      const headers = await getFirebaseAuthHeaders();
      await safeApiFetch(
        '/api/telegram/disconnect',
        { method: 'POST', headers: { Accept: 'application/json', ...headers } },
        20_000
      );
      await deleteUserTelegramSettings(authUser.uid);
      setSavedTelegramCreds(null);
      setTgBotTokenInput('');
      setTgChatIdInput('');
      await refreshTelegramStatus();
    } catch {
      // ignore
    }
  };

  const handleSendToTelegram = async (jobId: string) => {
    if (!authUser) return;
    setTelegramNotice(null);
    try {
      const headers = await getFirebaseAuthHeaders();
      const res = await safeApiFetch(`/api/telegram/send/${jobId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          telegramOverride: savedTelegramCreds
            ? {
                botToken: savedTelegramCreds.botToken,
                chatId: savedTelegramCreds.chatId,
              }
            : undefined,
        }),
      });
      await parseJsonResponse<{ ok?: boolean }>(res);
      if (job?.jobId === jobId) {
        setJob((prev) =>
          prev
            ? { ...prev, telegramStatus: 'sent', telegramError: undefined }
            : prev
        );
      }
      const match = historyItems.find((h) => h.jobId === jobId);
      if (match) {
        void syncUserVideoJob(authUser.uid, {
          ...match,
          telegramStatus: 'sent',
          telegramError: undefined,
        }).catch(() => {});
      }
      await refreshHistory();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to send to Telegram.';
      setTelegramNotice(msg);
      if (job?.jobId === jobId) {
        setJob((prev) =>
          prev
            ? { ...prev, telegramStatus: 'failed', telegramError: msg }
            : prev
        );
      }
    }
  };

  const handleOpenHistoryItem = async (item: VideoHistoryItem) => {
    setShowHistoryPanel(false);
    setView('studio');
    await restoreAssetForHistoryItem(item);
    setJob({
      jobId: item.jobId,
      status: item.status,
      progress: item.progress,
      stepLabel: item.stepLabel,
      error: item.error,
      telegramStatus: item.telegramStatus,
      telegramError: item.telegramError,
      createdAt: item.createdAt,
      completedAt: item.completedAt,
      expiresAt: item.expiresAt,
      result: item.result,
    });
    setEditableSegments(item.result?.segments || []);
    setConfig((prev) => ({
      ...prev,
      mode: item.mode,
      aspectRatio: item.aspectRatio,
      outputLanguage: item.outputLanguage,
      mirrorFlip: item.mirrorFlip,
      videoTitle: item.result?.finalTitle || item.title,
      aiSocialCaption: item.result?.socialCaption || prev.aiSocialCaption,
    }));
    if (item.status !== 'completed' && item.status !== 'failed') {
      localStorage.setItem(ACTIVE_JOB_KEY, item.jobId);
    }
  };

  const handleDeleteHistoryItem = async (jobId: string) => {
    if (!authUser) return;
    try {
      const headers = await getFirebaseAuthHeaders();
      await safeApiFetch(
        `/api/studio/history/${jobId}`,
        {
          method: 'DELETE',
          headers: { Accept: 'application/json', ...headers },
        },
        20_000
      );
      await deleteUserVideoJob(authUser.uid, jobId).catch(() => {});
      if (job?.jobId === jobId) {
        setJob(null);
        setEditableSegments([]);
        localStorage.removeItem(ACTIVE_JOB_KEY);
      }
      await refreshHistory();
    } catch {
      // ignore
    }
  };

  const handleVideoLoaded = (loaded: VideoAsset) => {
    setAsset(loaded);
    setConfig((prev) => {
      const next = { ...prev, videoTitle: loaded.title };
      persistLocalConfig(next);
      return next;
    });
    setJob(null);
    setEditableSegments([]);
    setActiveTab('video');
    setView('studio');
  };

  const handleResetStudio = () => {
    setAsset(null);
    setJob(null);
    setEditableSegments([]);
    localStorage.removeItem(ACTIVE_JOB_KEY);
    setConfig((prev) => ({ ...prev, videoTitle: '' }));
    setView('studio');
  };

  const updateConfig = (patch: Partial<StudioConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      persistLocalConfig(next);
      if (authUser) {
        if (configSaveTimerRef.current) {
          window.clearTimeout(configSaveTimerRef.current);
        }
        configSaveTimerRef.current = window.setTimeout(() => {
          void saveUserStudioSettings(authUser.uid, next).catch(() => {});
        }, 700);
      }
      return next;
    });
  };

  const handleAddBlurBox = () => {
    const newBox: BlurBox = {
      id: `blur_${Date.now().toString(36)}`,
      x: 0.08,
      y: 0.77,
      w: 0.84,
      h: 0.12,
    };
    updateConfig({ blurBoxes: [...config.blurBoxes, newBox] });
    setActiveTool('edit');
  };

  const handleCycleAspectRatio = () => {
    const idx = ASPECT_CYCLE.indexOf(config.aspectRatio);
    const next = ASPECT_CYCLE[(idx + 1) % ASPECT_CYCLE.length];
    updateConfig({ aspectRatio: next });
    setActiveTool('crop');
  };

  const startProcessing = async (useEditedSegments = false) => {
    if (!asset || isProcessing || !authUser) return;
    persistLocalConfig(config);
    void saveUserStudioSettings(authUser.uid, config).catch(() => {});

    try {
      const headers = await getFirebaseAuthHeaders();
      const res = await safeApiFetch('/api/studio/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          videoId: asset.videoId,
          config,
          editedSegments: useEditedSegments ? editableSegments : undefined,
          telegramOverride: savedTelegramCreds
            ? {
                botToken: savedTelegramCreds.botToken,
                chatId: savedTelegramCreds.chatId,
              }
            : undefined,
        }),
      });
      const data = await parseJsonResponse<{ jobId?: string }>(res);
      if (!data.jobId) {
        throw new Error('Failed to start processing.');
      }
      localStorage.setItem(ACTIVE_JOB_KEY, data.jobId);
      const now = Date.now();
      const initialJob: ProcessJobStatus = {
        jobId: data.jobId,
        userId: authUser.uid,
        status: 'queued',
        progress: 5,
        stepLabel: 'Starting AI Myanmar Studio on cloud...',
        createdAt: now,
        expiresAt: now + 4 * 60 * 60 * 1000,
      };
      setJob(initialJob);
      void syncUserVideoJob(authUser.uid, {
        jobId: data.jobId,
        userId: authUser.uid,
        videoId: asset.videoId,
        title: config.videoTitle.trim() || asset.title,
        mode: config.mode,
        aspectRatio: config.aspectRatio,
        outputLanguage: config.outputLanguage,
        mirrorFlip: Boolean(config.mirrorFlip),
        status: 'queued',
        progress: 5,
        stepLabel: initialJob.stepLabel,
        createdAt: now,
        expiresAt: now + 4 * 60 * 60 * 1000,
      }).catch(() => {});
      void refreshHistory();
    } catch (err) {
      setJob({
        jobId: 'error',
        status: 'failed',
        progress: 0,
        stepLabel: 'Error',
        error:
          err instanceof Error ? err.message : 'Unable to start studio job.',
      });
    }
  };

  const modeSummaryLabel =
    config.mode === 'recap'
      ? `AI Recap (${config.recapDurationMin}m)`
      : config.mode === 'dub'
        ? 'Audio Dub'
        : 'Subtitle';

  const voiceLabel = config.voiceId === 'nilar' ? 'Nilar' : 'Thiha';
  const langLabel =
    config.outputLanguage === 'my'
      ? 'မြန်မာ'
      : config.outputLanguage === 'en'
        ? 'English'
        : 'ไทย';

  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F4F7FB] text-slate-700">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-7 h-7 animate-spin text-[#1D6CE0]" />
          <p className="text-xs font-medium text-slate-500">
            Loading DeepRecap Myanmar Studio...
          </p>
        </div>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F4F7FB] px-4 py-10 text-slate-900">
        <div className="w-full max-w-md rounded-3xl bg-white border border-slate-200/90 p-7 sm:p-8 shadow-sm space-y-6">
          <div className="space-y-2 text-center">
            <div className="w-12 h-12 rounded-2xl bg-sky-50 border border-sky-100 mx-auto flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-[#1D6CE0]" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              DeepRecap Myanmar Studio
            </h1>
            <p className="text-xs text-slate-600 font-myanmar leading-relaxed">
              Google Account ဖြင့် Sign In ဝင်ပြီး Setting များ၊ Telegram Bot ချိတ်ဆက်မှု၊ လုပ်လက်စ job များနှင့် 4-Hour Video History များကို Cloud တွင် သိမ်းဆည်းအသုံးပြုပါ။
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 border border-slate-200/80 p-3.5 text-xs text-slate-600 font-myanmar space-y-1.5">
            <p className="font-semibold text-slate-800">
              ✓ Account တစ်ခုတည်းဖြင့် နေရာတိုင်းတွင် ဆက်သုံးနိုင်ခြင်း
            </p>
            <p>
              Link share လိုက်သည့်အခါ သို့မဟုတ် ဖုန်းပြောင်းသုံးသည့်အခါ တစ်ခါပြန်ချိတ်စရာမလိုဘဲ မိမိ setting နှင့် Telegram account များ အလိုအလျောက် ပြန်ပါလာပါမည်။
            </p>
          </div>

          {authError && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-xs text-rose-700 font-myanmar">
              {authError}
            </div>
          )}

          <button
            type="button"
            disabled={authSigningIn}
            onClick={() => void handleGoogleSignIn()}
            className="w-full inline-flex items-center justify-center gap-2.5 rounded-2xl bg-[#1D6CE0] hover:bg-blue-700 disabled:opacity-60 text-white font-semibold text-sm py-3.5 px-5 transition-colors min-h-[48px] shadow-xs"
          >
            {authSigningIn ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Signing in...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#ffffff"
                    d="M21.35 11.1H12v2.98h5.35c-.45 2.4-2.38 3.92-5.35 3.92a6 6 0 1 1 0-12c1.54 0 2.9.56 3.96 1.5l2.24-2.24A9.2 9.2 0 0 0 12 2.8a9.2 9.2 0 1 0 0 18.4c5.3 0 8.8-3.73 8.8-8.98 0-.6-.06-1.08-.15-1.12Z"
                  />
                </svg>
                Continue with Google
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F7FB] text-slate-900">
      {/* Top Bar Contract: 3 zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur-md border-b border-slate-200/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-8">
          <button
            type="button"
            onClick={() => setView('studio')}
            className="text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
          >
            DeepRecap Myanmar
          </button>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
            <button
              type="button"
              onClick={() => setView('studio')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
                view === 'studio' ? 'text-slate-900 font-semibold' : ''
              }`}
            >
              Studio
            </button>
            <button
              type="button"
              onClick={() => {
                setView('studio');
                setActiveTab('voice');
              }}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Thiha Voice
            </button>
            <button
              type="button"
              onClick={() => {
                setView('studio');
                setActiveTab('captions');
              }}
              className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >
              Subtitles
            </button>
            <button
              type="button"
              onClick={() => setView('guide')}
              className={`hover:text-slate-900 transition-colors whitespace-nowrap shrink-0 ${
                view === 'guide' ? 'text-slate-900 font-semibold' : ''
              }`}
            >
              Guide
            </button>
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowHistoryPanel((v) => !v);
                void refreshHistory();
              }}
              className={`inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-2 text-xs font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0 min-h-[38px] ${
                showHistoryPanel
                  ? 'bg-[#1D6CE0] text-white'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-800'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">History</span>
              {historyItems.length > 0 && (
                <span
                  className={`font-mono-tabular text-[10px] font-bold px-1.5 py-0.5 rounded-md ${
                    showHistoryPanel
                      ? 'bg-white/20 text-white'
                      : 'bg-white text-slate-700'
                  }`}
                >
                  {historyItems.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setShowTelegramPanel((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-2 text-xs font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0 min-h-[38px] ${
                telegramAuth.connected
                  ? 'border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-800'
                  : 'bg-slate-100 hover:bg-slate-200 text-slate-800'
              }`}
            >
              <Send className="w-3.5 h-3.5 text-[#1D6CE0]" />
              <span className="hidden sm:inline">
                {telegramAuth.connected
                  ? telegramAuth.account?.username
                    ? `@${telegramAuth.account.username}`
                    : telegramAuth.account?.firstName || 'Telegram'
                  : 'Telegram'}
              </span>
            </button>

            {githubAuth.connected && githubAuth.user ? (
              <div className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 pl-1.5 pr-1.5 py-1 min-h-[38px]">
                <img
                  src={githubAuth.user.avatarUrl}
                  alt={githubAuth.user.login}
                  referrerPolicy="no-referrer"
                  className="w-6 h-6 rounded-full object-cover"
                />
                <span className="text-xs font-semibold text-slate-800 max-w-[90px] truncate hidden sm:inline">
                  @{githubAuth.user.login}
                </span>
                <button
                  type="button"
                  onClick={() => setShowPushRepoPanel((v) => !v)}
                  title="Push working files to GitHub"
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-semibold transition-colors whitespace-nowrap"
                >
                  <UploadCloud className="w-3 h-3" />
                  <span>Push</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleDisconnectGitHub()}
                  aria-label="Disconnect GitHub"
                  className="p-1 text-slate-400 hover:text-rose-600 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void handleConnectGitHub()}
                className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-2 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors whitespace-nowrap shrink-0 min-h-[38px]"
              >
                <Github className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">GitHub</span>
              </button>
            )}

            {asset ? (
              <button
                type="button"
                onClick={handleResetStudio}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors whitespace-nowrap shrink-0 min-h-[38px]"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">New Video</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setView(view === 'guide' ? 'studio' : 'guide')}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-[#1D6CE0] hover:bg-blue-700 rounded-xl transition-colors whitespace-nowrap shrink-0 min-h-[38px]"
              >
                {view === 'guide' ? 'Open Studio' : 'Guide'}
              </button>
            )}

            <div className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 pl-1.5 pr-1.5 py-1 min-h-[38px]">
              {authUser.photoURL ? (
                <img
                  src={authUser.photoURL}
                  alt={authUser.displayName || 'User'}
                  referrerPolicy="no-referrer"
                  className="w-6 h-6 rounded-full object-cover"
                />
              ) : (
                <span className="w-6 h-6 rounded-full bg-[#1D6CE0] text-white text-[11px] font-bold flex items-center justify-center">
                  {(authUser.displayName || authUser.email || 'U')[0].toUpperCase()}
                </span>
              )}
              <span className="text-xs font-semibold text-slate-700 max-w-[85px] truncate hidden md:inline">
                {authUser.displayName || authUser.email}
              </span>
              <button
                type="button"
                onClick={() => void handleGoogleSignOut()}
                aria-label="Sign out Google"
                title="Sign out Google"
                className="p-1 text-slate-400 hover:text-rose-600 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-5 sm:py-7 pb-24 lg:pb-10">
        {(githubNotice || telegramNotice) && (
          <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 flex items-center justify-between gap-3">
            <span>{telegramNotice || githubNotice}</span>
            <button
              type="button"
              onClick={() => {
                setGithubNotice(null);
                setTelegramNotice(null);
              }}
              aria-label="Dismiss notice"
              className="p-1 text-amber-700 hover:text-amber-950 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {showTelegramPanel && (
          <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 space-y-4 shadow-xs">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-slate-900">
                  Telegram Bot &amp; Chat ID ချိတ်ဆက်ရန်
                </p>
                <p className="text-xs text-slate-500 font-myanmar mt-0.5">
                  Bot Token (Bot ID) နှင့် Chat ID ထည့်သွင်းထားပါက Google Account ထဲတွင် အပြီးသိမ်းထားပေးပြီး Video Render ပြီးတိုင်း Telegram သို့ အလိုအလျောက် ပို့ပေးပါမည်။
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowTelegramPanel(false)}
                aria-label="Close Telegram panel"
                className="p-1 text-slate-400 hover:text-slate-700 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {telegramAuth.connected && telegramAuth.account && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-3 flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-emerald-900 font-myanmar">
                  <span className="font-bold">✓ ချိတ်ဆက်ပြီး: </span>
                  <span>
                    {telegramAuth.botUsername
                      ? `@${telegramAuth.botUsername}`
                      : 'Telegram Bot'}{' '}
                    · Chat ID:{' '}
                    <span className="font-mono-tabular font-semibold">
                      {telegramAuth.account.chatId}
                    </span>
                    {telegramAuth.account.accountLabel
                      ? ` (${telegramAuth.account.accountLabel})`
                      : ''}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleDisconnectTelegram()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 text-xs font-semibold px-3 py-1.5 min-h-[34px]"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              </div>
            )}

            <form
              onSubmit={(e) => void handleConnectTelegramCredentials(e)}
              className="space-y-3"
            >
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    Bot Token / Bot ID (@BotFather မှရသော Token)
                  </label>
                  <div className="relative flex items-center">
                    <input
                      type={showTgToken ? 'text' : 'password'}
                      value={tgBotTokenInput}
                      onChange={(e) => setTgBotTokenInput(e.target.value)}
                      placeholder="1234567890:AAHxxxxxxxxxxxxxxxxxxxx"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50 pl-3 pr-9 py-2.5 text-xs font-mono-tabular text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowTgToken((v) => !v)}
                      aria-label={showTgToken ? 'Hide token' : 'Show token'}
                      className="absolute right-2.5 text-slate-400 hover:text-slate-700"
                    >
                      {showTgToken ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    Telegram Chat ID (ဥပမာ 5123456789 သို့ -100...)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={tgChatIdInput}
                      onChange={(e) => setTgChatIdInput(e.target.value)}
                      placeholder="5123456789"
                      className="flex-1 min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-mono-tabular text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                      required
                    />
                    <button
                      type="button"
                      disabled={tgDetecting || !tgBotTokenInput.trim()}
                      onClick={() => void handleAutoDetectChatId()}
                      title="Bot ထံ Message တစ်စောင်ပို့ထားပါက Chat ID အလိုအလျောက်ရှာမည်"
                      className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-50 text-slate-700 text-xs font-semibold px-2.5 py-2.5 whitespace-nowrap shrink-0"
                    >
                      {tgDetecting ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        'Auto-Detect'
                      )}
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[11px] text-slate-500 font-myanmar">
                  Telegram တွင် <span className="font-semibold text-slate-700">@BotFather</span> မှ Bot Token ယူပြီး Bot ကို Start နှိပ်ထားပါ (Chat ID မသိပါက Auto-Detect နှိပ်၍ ရှာနိုင်ပါသည်)။
                </p>

                <button
                  type="submit"
                  disabled={tgSaving}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#1D6CE0] hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-semibold px-4 py-2.5 min-h-[40px] whitespace-nowrap"
                >
                  {tgSaving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Testing &amp; Saving...
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      {telegramAuth.connected
                        ? 'Update & Test Telegram'
                        : 'Save & Connect Telegram'}
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        )}

        {showHistoryPanel && (
          <div className="mb-5">
            <HistoryPanel
              items={historyItems}
              activeJobId={job?.jobId}
              telegramConnected={telegramAuth.connected}
              onOpenItem={(item) => void handleOpenHistoryItem(item)}
              onDeleteItem={(jobId) => handleDeleteHistoryItem(jobId)}
              onSendToTelegram={handleSendToTelegram}
              onRefresh={() => void refreshHistory()}
            />
          </div>
        )}

        {showDeviceFallback && !githubAuth.connected && (
          <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 space-y-3 shadow-xs">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-slate-900">
                  GitHub Account ချိတ်ဆက်ရန်
                </p>
                <p className="text-xs text-slate-500 font-myanmar mt-0.5">
                  AI Studio Preview (ais-dev) ထဲတွင် Popup Callback 403 ဖြစ်ပါက အောက်ပါ 8-Digit Code ဖြင့် တိုက်ရိုက်ချိတ်ဆက်နိုင်ပါသည်။
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowDeviceFallback(false);
                  setDeviceFlow(null);
                }}
                aria-label="Close GitHub panel"
                className="p-1 text-slate-400 hover:text-slate-700 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {!deviceFlow ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleStartDeviceFlow()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-3.5 py-2.5 transition-colors min-h-[40px]"
                  >
                    <Github className="w-3.5 h-3.5" />
                    Connect via 8-Digit Code (No 403)
                  </button>
                  <a
                    href="https://github.com/settings/developers"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold px-3 py-2.5 transition-colors min-h-[40px]"
                  >
                    GitHub Settings
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
                <p className="text-[11px] text-slate-500 font-myanmar">
                  OAuth App settings ထဲတွင် <span className="font-semibold text-slate-700">Enable Device Flow</span> ကို အမှန်ခြစ်၍ Update application နှိပ်ထားရန် လိုပါသည်။
                </p>
              </div>
            ) : (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-[11px] font-medium text-slate-500">
                      1. Copy this 8-digit code:
                    </p>
                    <p className="font-mono-tabular text-lg font-bold tracking-wider text-slate-900">
                      {deviceFlow.userCode}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(deviceFlow.userCode);
                        setCopiedCode(true);
                        setTimeout(() => setCopiedCode(false), 1800);
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-800 text-xs font-semibold px-3 py-2 min-h-[36px]"
                    >
                      {copiedCode ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          Copy
                        </>
                      )}
                    </button>
                    <a
                      href={deviceFlow.verificationUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg bg-[#1D6CE0] hover:bg-blue-700 text-white text-xs font-semibold px-3 py-2 min-h-[36px]"
                    >
                      Open GitHub
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin text-[#1D6CE0]" />
                  2. Enter the code on GitHub &amp; authorize — waiting automatically...
                </p>
              </div>
            )}
          </div>
        )}

        {showPushRepoPanel && githubAuth.connected && githubAuth.user && (
          <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 space-y-3 shadow-xs">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-slate-900">
                  GitHub Repo ပေါ်သို့ Code ဖိုင်များတင်ရန် (@{githubAuth.user.login})
                </p>
                <p className="text-xs text-slate-500 font-myanmar mt-0.5">
                  လက်ရှိအလုပ်လုပ်နေသော Code ဖိုင်အားလုံး (Dockerfile အပါအဝင်) ကို GitHub repository ထဲသို့ တိုက်ရိုက်တင်ပေးပါမည်။
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPushRepoPanel(false)}
                aria-label="Close push repo panel"
                className="p-1 text-slate-400 hover:text-slate-700 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {!githubAuth.hasRepoScope ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2">
                <p className="text-xs text-amber-900 font-myanmar">
                  Repository ဖန်တီး/တင်ခွင့် (repo scope) ရရှိရန် GitHub ကို တစ်ကြိမ်ပြန်ချိတ်ဆက်ပေးရန် လိုပါသည်။
                </p>
                <button
                  type="button"
                  onClick={() => void handleReconnectForRepo()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-3.5 py-2 transition-colors min-h-[38px]"
                >
                  <Github className="w-3.5 h-3.5" />
                  Reconnect GitHub (Grant Repo Permission)
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <input
                    type="text"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    placeholder="deeprecap-myanmar-studio"
                    className="flex-1 min-w-[200px] rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  />
                  <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
                    <button
                      type="button"
                      onClick={() => setRepoPrivate(false)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                        !repoPrivate
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      Public
                    </button>
                    <button
                      type="button"
                      onClick={() => setRepoPrivate(true)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                        repoPrivate
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      Private
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={pushingRepo}
                    onClick={() => void handlePushToGitHub()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#1D6CE0] hover:bg-blue-700 disabled:opacity-60 text-white text-xs font-semibold px-4 py-2.5 transition-colors min-h-[40px]"
                  >
                    {pushingRepo ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Pushing files...
                      </>
                    ) : (
                      <>
                        <UploadCloud className="w-3.5 h-3.5" />
                        Push Working Files to GitHub
                      </>
                    )}
                  </button>
                </div>

                {pushRepoResult && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 flex flex-wrap items-center justify-between gap-2.5">
                    <div className="text-xs text-emerald-900">
                      <span className="font-semibold">
                        {pushRepoResult.filesCount} files pushed to GitHub!
                      </span>{' '}
                      <span className="font-myanmar">
                        နောက်ပိုင်း ဒီကပြင်ပြီးတိုင်း Push ပြန်နှိပ်၍ Update တင်နိုင်ပါသည်။
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={pushRepoResult.repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-3 py-1.5"
                      >
                        Open Repo
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                      <a
                        href={`https://render.com/deploy?repo=${encodeURIComponent(pushRepoResult.repoUrl)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold px-3 py-1.5"
                      >
                        Deploy Online (Render)
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {view === 'guide' ? (
          <div className="max-w-3xl mx-auto bg-white rounded-3xl border border-slate-200/80 p-6 sm:p-8 space-y-6">
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-slate-900">
                Myanmar AI Dubbing & Video Recap Studio
              </h1>
              <p className="text-sm text-slate-600 font-myanmar leading-relaxed">
                ဗီဒီယိုဖိုင် သို့မဟုတ် YouTube Link ကိုထည့်သွင်းပြီး မြန်မာဘာသာ
                အသံသွင်း (Audio Dub) သို့မဟုတ် ၃-၅ မိနစ် အနှစ်ချုပ် (AI Recap)
                အဖြစ် အလွယ်တကူ ဖန်တီးနိုင်ပါသည်။
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="rounded-2xl border border-slate-200/80 p-4 space-y-1.5">
                <p className="text-sm font-bold text-slate-900">
                  01. Video File or YouTube Link
                </p>
                <p className="text-xs text-slate-600 leading-relaxed font-myanmar">
                  MP4, MOV, MKV ဖိုင်များ တိုက်ရိုက်တင်နိုင်သလို YouTube link
                  ကို paste လုပ်၍လည်း အသုံးပြုနိုင်ပါသည်။
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200/80 p-4 space-y-1.5">
                <p className="text-sm font-bold text-slate-900">
                  02. Audio Dub with Thiha Voice
                </p>
                <p className="text-xs text-slate-600 leading-relaxed font-myanmar">
                  Thiha voice model ဖြင့် မြန်မာဘာသာသို့ အလိုအလျောက်
                  ပြောင်းလဲပြီး အသံသွင်းပေးပါသည်။
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200/80 p-4 space-y-1.5">
                <p className="text-sm font-bold text-slate-900">
                  03. 3–5 Min AI Video Recap
                </p>
                <p className="text-xs text-slate-600 leading-relaxed font-myanmar">
                  ဗီဒီယိုတစ်ခုလုံးကို အနှစ်ချုပ်ပြီး 3 မှ 5 မိနစ်စာ recap
                  video နှင့် မြန်မာ voiceover ထုတ်ပေးပါသည်။
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200/80 p-4 space-y-1.5">
                <p className="text-sm font-bold text-slate-900">
                  04. Burmese Subtitles & MP4 Download
                </p>
                <p className="text-xs text-slate-600 leading-relaxed font-myanmar">
                  မူရင်းစာတန်းကို Blur box ဖြင့်ဖုံးပြီး မြန်မာစာတန်းထိုး၊
                  Video Title များထည့်ကာ MP4 ဖိုင်အဖြစ် ဒေါင်းလုဒ်ရယူနိုင်ပါသည်။
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setView('studio')}
              className="px-5 py-3 rounded-xl bg-[#1D6CE0] hover:bg-blue-700 text-white text-sm font-semibold transition-colors min-h-[44px]"
            >
              Back to Studio
            </button>
          </div>
        ) : !asset ? (
          <div className="py-4 sm:py-8 space-y-6">
            <VideoIntakePanel onVideoLoaded={handleVideoLoaded} />
            {!showHistoryPanel && historyItems.length > 0 && (
              <div className="max-w-3xl mx-auto">
                <HistoryPanel
                  items={historyItems}
                  activeJobId={job?.jobId}
                  telegramConnected={telegramAuth.connected}
                  onOpenItem={(item) => void handleOpenHistoryItem(item)}
                  onDeleteItem={(jobId) => handleDeleteHistoryItem(jobId)}
                  onSendToTelegram={handleSendToTelegram}
                  onRefresh={() => void refreshHistory()}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column: Video Preview, Blur Box Editor, Scrubber & Final Download */}
            <div className="lg:col-span-7 space-y-4">
              <VideoStudioPlayer
                asset={asset}
                config={config}
                segments={editableSegments}
                renderedVideoUrl={job?.result?.outputVideoUrl || null}
                activeTool={activeTool}
                onActiveToolChange={setActiveTool}
                onUpdateBlurBoxes={(boxes) => updateConfig({ blurBoxes: boxes })}
                onCycleAspectRatio={handleCycleAspectRatio}
                seekToSec={seekToSec}
              />

              {asset.sourceType === 'youtube' && !asset.hasDownloadableStream && (
                <div className="rounded-2xl border border-sky-200 bg-sky-50/70 px-4 py-3 text-xs text-slate-700 font-myanmar">
                  YouTube link metadata နှင့် AI analysis ကို ချိတ်ဆက်ပြီးပါပြီ။
                  မူရင်း video stream ကို တိုက်ရိုက်သုံးလိုပါက MP4 file ကိုလည်း
                  အစားထိုး upload လုပ်နိုင်ပါသည်။
                </div>
              )}

              <ResultDownloadPanel
                job={job}
                editableSegments={editableSegments}
                onEditSegment={(id, nextText) =>
                  setEditableSegments((prev) =>
                    prev.map((s) =>
                      s.id === id ? { ...s, myanmarText: nextText } : s
                    )
                  )
                }
                onSeekTo={(sec) => setSeekToSec(sec)}
                onRerender={() => void startProcessing(true)}
                isProcessing={isProcessing}
                githubAuth={githubAuth}
                telegramAuth={telegramAuth}
                onSendToTelegram={handleSendToTelegram}
              />
            </div>

            {/* Right Column: 4-Tab Inspector + Desktop Start Bar */}
            <div className="lg:col-span-5 space-y-4">
              <StudioControlsTabs
                activeTab={activeTab}
                onTabChange={setActiveTab}
                config={config}
                providerStatus={providerStatus}
                onChange={updateConfig}
                onAddBlurBox={handleAddBlurBox}
                onClearBlurBoxes={() => updateConfig({ blurBoxes: [] })}
              />

              {/* Desktop Action Footer inside Right Column */}
              <div className="hidden lg:flex items-center justify-between gap-4 rounded-2xl bg-white border border-slate-200/90 px-4 py-3.5 shadow-xs">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900 truncate">
                    {modeSummaryLabel} · {formatDurationBadge(asset.duration)}
                  </p>
                  <p className="text-xs text-slate-500 font-myanmar truncate mt-0.5">
                    {voiceLabel} · {config.aspectRatio} · 1080p 30fps
                    {config.mirrorFlip ? ' · Mirror' : ''} · Blur{' '}
                    {config.blurBoxes.length} ·{' '}
                    {config.captionsEnabled ? 'Captions on' : 'Captions off'} ·{' '}
                    {langLabel}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => void startProcessing(false)}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#1D6CE0] hover:bg-blue-700 disabled:opacity-60 text-white font-semibold text-sm px-5 py-3 transition-colors whitespace-nowrap shrink-0 min-h-[44px]"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-white" />
                      Start
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Mobile Sticky Bottom Action Bar (<= 15% mobile viewport height) */}
      {view === 'studio' && (
        <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200/90 px-4 py-2.5">
          <div className="flex items-center justify-between gap-3">
            {!asset ? (
              <>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">No video yet</p>
                  <p className="text-xs text-slate-500 truncate">
                    Choose a file or paste a YouTube link
                  </p>
                </div>
                <button
                  type="button"
                  disabled
                  className="inline-flex items-center gap-1.5 rounded-xl bg-slate-200 text-slate-400 font-semibold text-sm px-5 py-2.5 whitespace-nowrap shrink-0 min-h-[44px]"
                >
                  <Play className="w-4 h-4 fill-current" />
                  Start
                </button>
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900 truncate">
                    {modeSummaryLabel} ·{' '}
                    <span className="font-mono-tabular">
                      {formatDurationBadge(asset.duration)}
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 font-myanmar truncate">
                    {config.aspectRatio} · 1080p 30fps
                    {config.mirrorFlip ? ' · Mirror' : ''} · Blur{' '}
                    {config.blurBoxes.length} ·{' '}
                    {config.captionsEnabled ? 'Captions on' : 'Captions off'} ·{' '}
                    {langLabel}
                  </p>
                </div>

                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => void startProcessing(false)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#1D6CE0] hover:bg-blue-700 disabled:opacity-60 text-white font-semibold text-sm px-5 py-2.5 transition-colors whitespace-nowrap shrink-0 min-h-[44px]"
                >
                  {isProcessing ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Running
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-white" />
                      Start
                    </>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
