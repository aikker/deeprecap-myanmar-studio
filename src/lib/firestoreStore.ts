import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import type {
  StudioConfig,
  SubtitleSegment,
  VideoHistoryItem,
} from '../types/studio';
import { auth, db } from './firebase';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export interface UserTelegramCreds {
  botToken: string;
  chatId: string;
  botUsername?: string;
  accountLabel?: string;
}

export async function ensureUserProfile(user: User): Promise<void> {
  const path = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    const email = (user.email || `${user.uid}@user.local`).slice(0, 254);
    const displayName = (user.displayName || '').slice(0, 120);
    const photoURL = (user.photoURL || '').slice(0, 500);

    if (!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        email,
        ...(displayName ? { displayName } : {}),
        ...(photoURL ? { photoURL } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        email,
        ...(displayName ? { displayName } : {}),
        ...(photoURL ? { photoURL } : {}),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function loadUserStudioSettings(
  uid: string
): Promise<Partial<StudioConfig> | null> {
  const path = `users/${uid}/studioSettings/current`;
  const ref = doc(db, 'users', uid, 'studioSettings', 'current');
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const raw = snap.data() as Record<string, unknown>;
    const {
      userId: _u,
      createdAt: _c,
      updatedAt: _up,
      ...rest
    } = raw;
    return rest as Partial<StudioConfig>;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

function buildSanitizedStudioPayload(
  uid: string,
  cfg: StudioConfig
): Record<string, unknown> {
  const cleanBlurBoxes = Array.isArray(cfg.blurBoxes)
    ? cfg.blurBoxes.slice(0, 10).map((b) => ({
        id: String(b.id || '').slice(0, 64),
        x: Number(b.x) || 0,
        y: Number(b.y) || 0,
        w: Number(b.w) || 0,
        h: Number(b.h) || 0,
      }))
    : [];

  const payload: Record<string, unknown> = {
    userId: uid,
    showTitleOverlay: Boolean(cfg.showTitleOverlay),
    mode: cfg.mode,
    recapDurationMin: cfg.recapDurationMin,
    aspectRatio: cfg.aspectRatio,
    fitMode: cfg.fitMode,
    mirrorFlip: Boolean(cfg.mirrorFlip),
    outputLanguage: cfg.outputLanguage,
    transcriptionProvider: cfg.transcriptionProvider,
    ttsProvider: cfg.ttsProvider,
    voiceId: cfg.voiceId,
    speedPercent: Math.max(-50, Math.min(100, Number(cfg.speedPercent) || 0)),
    pitchHz: Math.max(-20, Math.min(20, Number(cfg.pitchHz) || 0)),
    originalAudioMix: Math.max(0, Math.min(1, Number(cfg.originalAudioMix) || 0)),
    captionsEnabled: Boolean(cfg.captionsEnabled),
    captionFont: String(cfg.captionFont || 'Noto Sans Myanmar').slice(0, 64),
    captionWeight: cfg.captionWeight || 'bold',
    captionSize: Math.max(12, Math.min(40, Number(cfg.captionSize) || 18)),
    captionStyle: cfg.captionStyle || 'yellow-outline',
    captionColor: String(cfg.captionColor || '#FFD400').slice(0, 16),
    captionBgColor: String(cfg.captionBgColor || '#0F172A').slice(0, 16),
    captionBgOpacity: Math.max(
      0,
      Math.min(100, Number(cfg.captionBgOpacity) || 0)
    ),
    blurBoxes: cleanBlurBoxes,
    fullBandCover: Boolean(cfg.fullBandCover),
    blurStrength: Math.max(4, Math.min(28, Number(cfg.blurStrength) || 16)),
    watermarkEnabled: Boolean(cfg.watermarkEnabled),
    watermarkText: String(cfg.watermarkText || '').slice(0, 120),
    logoEnabled: Boolean(cfg.logoEnabled),
    aiCaptionEnabled: Boolean(cfg.aiCaptionEnabled),
    aiSocialCaption: String(cfg.aiSocialCaption || '').slice(0, 1000),
    addFyp: Boolean(cfg.addFyp),
  };

  if (
    typeof cfg.logoDataUrl === 'string' &&
    cfg.logoDataUrl.length > 0 &&
    cfg.logoDataUrl.length <= 195000
  ) {
    payload.logoDataUrl = cfg.logoDataUrl;
  }

  return payload;
}

export async function saveUserStudioSettings(
  uid: string,
  cfg: StudioConfig
): Promise<void> {
  const path = `users/${uid}/studioSettings/current`;
  const ref = doc(db, 'users', uid, 'studioSettings', 'current');
  const payload = buildSanitizedStudioPayload(uid, cfg);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const { userId: _u, ...updateFields } = payload;
      await updateDoc(ref, {
        ...updateFields,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function loadUserTelegramSettings(
  uid: string
): Promise<UserTelegramCreds | null> {
  const path = `users/${uid}/telegramSettings/current`;
  const ref = doc(db, 'users', uid, 'telegramSettings', 'current');
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const data = snap.data() as Record<string, unknown>;
    if (typeof data.botToken !== 'string' || typeof data.chatId !== 'string') {
      return null;
    }
    return {
      botToken: data.botToken,
      chatId: data.chatId,
      botUsername:
        typeof data.botUsername === 'string' ? data.botUsername : undefined,
      accountLabel:
        typeof data.accountLabel === 'string' ? data.accountLabel : undefined,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function saveUserTelegramSettings(
  uid: string,
  creds: UserTelegramCreds
): Promise<void> {
  const path = `users/${uid}/telegramSettings/current`;
  const ref = doc(db, 'users', uid, 'telegramSettings', 'current');
  const payload = {
    botToken: creds.botToken.trim().slice(0, 120),
    chatId: creds.chatId.trim().slice(0, 64),
    ...(creds.botUsername
      ? { botUsername: creds.botUsername.trim().slice(0, 64) }
      : {}),
    ...(creds.accountLabel
      ? { accountLabel: creds.accountLabel.trim().slice(0, 120) }
      : {}),
  };

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        userId: uid,
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        ...payload,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteUserTelegramSettings(uid: string): Promise<void> {
  const path = `users/${uid}/telegramSettings/current`;
  const ref = doc(db, 'users', uid, 'telegramSettings', 'current');
  try {
    await deleteDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

function toHistoryItem(data: Record<string, unknown>): VideoHistoryItem {
  const hasResult =
    typeof data.outputVideoUrl === 'string' &&
    typeof data.outputSrtUrl === 'string';

  return {
    jobId: String(data.jobId || ''),
    userId: typeof data.userId === 'string' ? data.userId : undefined,
    videoId: String(data.videoId || ''),
    title: String(data.title || 'DeepRecap Video'),
    mode: (data.mode as VideoHistoryItem['mode']) || 'dub',
    aspectRatio:
      (data.aspectRatio as VideoHistoryItem['aspectRatio']) || 'original',
    outputLanguage:
      (data.outputLanguage as VideoHistoryItem['outputLanguage']) || 'my',
    mirrorFlip: Boolean(data.mirrorFlip),
    status: (data.status as VideoHistoryItem['status']) || 'queued',
    progress: Number(data.progress) || 0,
    stepLabel: String(data.stepLabel || ''),
    error: typeof data.error === 'string' ? data.error : undefined,
    telegramStatus: data.telegramStatus as VideoHistoryItem['telegramStatus'],
    telegramError:
      typeof data.telegramError === 'string' ? data.telegramError : undefined,
    createdAt: Number(data.createdAtMs) || Date.now(),
    completedAt:
      typeof data.completedAtMs === 'number' ? data.completedAtMs : undefined,
    expiresAt: Number(data.expiresAtMs) || Date.now() + 4 * 60 * 60 * 1000,
    result: hasResult
      ? {
          outputVideoUrl: String(data.outputVideoUrl),
          outputAudioUrl:
            typeof data.outputAudioUrl === 'string'
              ? data.outputAudioUrl
              : undefined,
          outputSrtUrl: String(data.outputSrtUrl),
          finalTitle: String(data.finalTitle || data.title || 'DeepRecap Video'),
          socialCaption: String(data.socialCaption || ''),
          durationSec: Number(data.durationSec) || 0,
          segments: Array.isArray(data.segments)
            ? (data.segments as SubtitleSegment[])
            : [],
        }
      : undefined,
  };
}

export async function loadUserVideoJobs(
  uid: string
): Promise<VideoHistoryItem[]> {
  const path = `users/${uid}/videoJobs`;
  const col = collection(db, 'users', uid, 'videoJobs');
  const q = query(col, where('userId', '==', uid), limit(50));
  try {
    const snap = await getDocs(q);
    const now = Date.now();
    const valid: VideoHistoryItem[] = [];
    for (const d of snap.docs) {
      const item = toHistoryItem(d.data() as Record<string, unknown>);
      if (item.expiresAt <= now) {
        // Delete expired (> 4h) record from Firestore immediately
        void deleteDoc(doc(db, 'users', uid, 'videoJobs', item.jobId)).catch(
          () => {}
        );
      } else {
        valid.push(item);
      }
    }
    return valid.sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function syncUserVideoJob(
  uid: string,
  item: VideoHistoryItem
): Promise<void> {
  if (!item.jobId || !/^[a-zA-Z0-9_\-]+$/.test(item.jobId)) return;
  const path = `users/${uid}/videoJobs/${item.jobId}`;
  const ref = doc(db, 'users', uid, 'videoJobs', item.jobId);

  const sanitizedSegments = (item.result?.segments || [])
    .slice(0, 250)
    .map((s) => ({
      id: String(s.id || '').slice(0, 64),
      startSec: Number(s.startSec) || 0,
      endSec: Number(s.endSec) || 0,
      sourceStartSec: Number(s.sourceStartSec) || 0,
      sourceEndSec: Number(s.sourceEndSec) || 0,
      myanmarText: String(s.myanmarText || '').slice(0, 500),
      ...(s.englishMeaning
        ? { englishMeaning: String(s.englishMeaning).slice(0, 400) }
        : {}),
      ...(s.emotionStyle
        ? { emotionStyle: String(s.emotionStyle).slice(0, 120) }
        : {}),
    }));

  const mutableFields: Record<string, unknown> = {
    title: String(item.title || 'DeepRecap Video').slice(0, 200),
    status: item.status,
    progress: Math.max(0, Math.min(100, Number(item.progress) || 0)),
    stepLabel: String(item.stepLabel || '').slice(0, 200),
    expiresAtMs: Number(item.expiresAt) || Date.now() + 4 * 60 * 60 * 1000,
    ...(item.error ? { error: String(item.error).slice(0, 500) } : {}),
    ...(item.telegramStatus ? { telegramStatus: item.telegramStatus } : {}),
    ...(item.telegramError
      ? { telegramError: String(item.telegramError).slice(0, 300) }
      : {}),
    ...(typeof item.completedAt === 'number'
      ? { completedAtMs: item.completedAt }
      : {}),
    ...(item.result
      ? {
          outputVideoUrl: String(item.result.outputVideoUrl || '').slice(0, 500),
          ...(item.result.outputAudioUrl
            ? {
                outputAudioUrl: String(item.result.outputAudioUrl).slice(
                  0,
                  500
                ),
              }
            : {}),
          outputSrtUrl: String(item.result.outputSrtUrl || '').slice(0, 500),
          finalTitle: String(item.result.finalTitle || item.title).slice(
            0,
            200
          ),
          socialCaption: String(item.result.socialCaption || '').slice(0, 1000),
          durationSec: Number(item.result.durationSec) || 0,
          segments: sanitizedSegments,
        }
      : {}),
  };

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        jobId: item.jobId,
        userId: uid,
        videoId: String(item.videoId || 'video').slice(0, 64),
        mode: item.mode,
        aspectRatio: item.aspectRatio,
        outputLanguage: item.outputLanguage,
        mirrorFlip: Boolean(item.mirrorFlip),
        createdAtMs: Number(item.createdAt) || Date.now(),
        ...mutableFields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return;
    }

    const existing = snap.data() as Record<string, unknown>;
    if (existing.status === 'failed') {
      return;
    }
    if (existing.status === 'completed') {
      if (
        item.status === 'completed' &&
        item.telegramStatus &&
        item.telegramStatus !== existing.telegramStatus
      ) {
        await updateDoc(ref, {
          telegramStatus: item.telegramStatus,
          ...(item.telegramError
            ? { telegramError: String(item.telegramError).slice(0, 300) }
            : {}),
          updatedAt: serverTimestamp(),
        });
      }
      return;
    }

    await updateDoc(ref, {
      ...mutableFields,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteUserVideoJob(
  uid: string,
  jobId: string
): Promise<void> {
  if (!jobId) return;
  const path = `users/${uid}/videoJobs/${jobId}`;
  const ref = doc(db, 'users', uid, 'videoJobs', jobId);
  try {
    await deleteDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
