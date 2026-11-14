import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  StudioConfig,
  TelegramAccount,
  VideoAsset,
  VideoHistoryItem,
} from '../src/types/studio.ts';
import {
  BASE_MEDIA_DIR,
  OUTPUTS_DIR,
  UPLOADS_DIR,
  WORK_DIR,
} from './mediaProcessor.ts';

export const RETENTION_MS = 4 * 60 * 60 * 1000; // 4 hours retention

const META_DIR = path.join(BASE_MEDIA_DIR, 'meta');
const USERS_META_DIR = path.join(META_DIR, 'users');
const HISTORY_FILE = path.join(META_DIR, 'history.json');
const ASSETS_FILE = path.join(META_DIR, 'assets.json');

let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => {});
  return next;
}

function safeUserDir(userId: string): string {
  const safeUid = userId.replace(/[^a-zA-Z0-9_\-]/g, '_') || 'default';
  return path.join(USERS_META_DIR, safeUid);
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

let historyCache: VideoHistoryItem[] = [];
let assetsCache: Array<VideoAsset & { filePath: string; createdAt?: number }> = [];

export async function initStudioStorage(): Promise<{
  history: VideoHistoryItem[];
  assets: Array<VideoAsset & { filePath: string }>;
}> {
  await fs.mkdir(USERS_META_DIR, { recursive: true });
  const loadedHistory = await readJsonSafe<VideoHistoryItem[]>(HISTORY_FILE, []);
  const loadedAssets = await readJsonSafe<
    Array<VideoAsset & { filePath: string; createdAt?: number }>
  >(ASSETS_FILE, []);

  const now = Date.now();
  historyCache = loadedHistory.map((item) => {
    if (item.status !== 'completed' && item.status !== 'failed') {
      return {
        ...item,
        status: 'failed',
        progress: 0,
        stepLabel: 'Interrupted by server restart',
        error: 'Server restarted while processing. Please start again.',
        expiresAt: item.expiresAt || now + RETENTION_MS,
      };
    }
    return item;
  });

  const validAssets: Array<VideoAsset & { filePath: string; createdAt?: number }> =
    [];
  for (const a of loadedAssets) {
    try {
      await fs.stat(a.filePath);
      validAssets.push(a);
    } catch {
      // file missing
    }
  }
  assetsCache = validAssets;

  await cleanupExpiredHistory();
  return {
    history: historyCache,
    assets: assetsCache,
  };
}

export function getHistorySnapshot(userId?: string): VideoHistoryItem[] {
  const now = Date.now();
  return historyCache
    .filter((item) => {
      if (item.expiresAt <= now) return false;
      if (userId) return item.userId === userId;
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function upsertHistoryItem(item: VideoHistoryItem): Promise<void> {
  const idx = historyCache.findIndex((h) => h.jobId === item.jobId);
  if (idx >= 0) {
    historyCache[idx] = item;
  } else {
    historyCache.unshift(item);
  }
  await enqueueWrite(() => writeJsonSafe(HISTORY_FILE, historyCache));
}

export async function patchHistoryItem(
  jobId: string,
  patch: Partial<VideoHistoryItem>
): Promise<VideoHistoryItem | null> {
  const idx = historyCache.findIndex((h) => h.jobId === jobId);
  if (idx < 0) return null;
  historyCache[idx] = { ...historyCache[idx], ...patch };
  await enqueueWrite(() => writeJsonSafe(HISTORY_FILE, historyCache));
  return historyCache[idx];
}

export function getHistoryItemById(
  jobId: string,
  userId?: string
): VideoHistoryItem | undefined {
  const item = historyCache.find((h) => h.jobId === jobId);
  if (!item) return undefined;
  if (userId && item.userId && item.userId !== userId) return undefined;
  return item;
}

export async function saveRegisteredAsset(
  asset: VideoAsset & { filePath: string }
): Promise<void> {
  const idx = assetsCache.findIndex((a) => a.videoId === asset.videoId);
  const record = { ...asset, createdAt: Date.now() };
  if (idx >= 0) assetsCache[idx] = record;
  else assetsCache.unshift(record);
  await enqueueWrite(() => writeJsonSafe(ASSETS_FILE, assetsCache));
}

async function deleteJobArtifacts(jobId: string): Promise<void> {
  const candidates = [
    path.join(OUTPUTS_DIR, `${jobId}_final.mp4`),
    path.join(OUTPUTS_DIR, `${jobId}_voice.wav`),
    path.join(OUTPUTS_DIR, `${jobId}_subtitles.srt`),
    path.join(OUTPUTS_DIR, `${jobId}_telegram.mp4`),
  ];
  for (const file of candidates) {
    await fs.rm(file, { force: true }).catch(() => {});
  }
  await fs
    .rm(path.join(WORK_DIR, jobId), { recursive: true, force: true })
    .catch(() => {});
}

export async function deleteHistoryItem(
  jobId: string,
  userId?: string
): Promise<boolean> {
  const idx = historyCache.findIndex(
    (h) => h.jobId === jobId && (!userId || !h.userId || h.userId === userId)
  );
  if (idx < 0) return false;
  historyCache.splice(idx, 1);
  await deleteJobArtifacts(jobId);
  await enqueueWrite(() => writeJsonSafe(HISTORY_FILE, historyCache));
  return true;
}

export async function cleanupExpiredHistory(): Promise<number> {
  const now = Date.now();
  const expired = historyCache.filter((item) => item.expiresAt <= now);

  if (expired.length > 0) {
    for (const item of expired) {
      await deleteJobArtifacts(item.jobId);
    }
    historyCache = historyCache.filter((item) => item.expiresAt > now);
    await enqueueWrite(() => writeJsonSafe(HISTORY_FILE, historyCache));
  }

  const activeVideoIds = new Set(
    historyCache
      .filter((h) => h.status !== 'completed' && h.status !== 'failed')
      .map((h) => h.videoId)
  );
  const cutoffMs = now - RETENTION_MS;

  for (const dir of [OUTPUTS_DIR, WORK_DIR, UPLOADS_DIR]) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs < cutoffMs) {
            const belongsToActive = Array.from(activeVideoIds).some((vid) =>
              entry.name.startsWith(vid)
            );
            if (!belongsToActive) {
              await fs.rm(full, { recursive: true, force: true }).catch(() => {});
            }
          }
        } catch {
          // ignore entry stat errors
        }
      }
    } catch {
      // ignore dir read errors
    }
  }

  const validAssets: Array<VideoAsset & { filePath: string; createdAt?: number }> =
    [];
  let assetsChanged = false;
  for (const a of assetsCache) {
    try {
      const st = await fs.stat(a.filePath);
      const age = a.createdAt ? now - a.createdAt : now - st.mtimeMs;
      if (age > RETENTION_MS && !activeVideoIds.has(a.videoId)) {
        await fs.rm(a.filePath, { force: true }).catch(() => {});
        assetsChanged = true;
      } else {
        validAssets.push(a);
      }
    } catch {
      assetsChanged = true;
    }
  }
  if (assetsChanged) {
    assetsCache = validAssets;
    await enqueueWrite(() => writeJsonSafe(ASSETS_FILE, assetsCache));
  }

  return expired.length;
}

export async function getLastSavedConfig(
  userId: string
): Promise<Partial<StudioConfig> | null> {
  const filePath = path.join(safeUserDir(userId), 'last_config.json');
  return readJsonSafe<Partial<StudioConfig> | null>(filePath, null);
}

export async function saveLastConfig(
  userId: string,
  config: StudioConfig
): Promise<void> {
  const filePath = path.join(safeUserDir(userId), 'last_config.json');
  const toSave: Partial<StudioConfig> = {
    ...config,
    videoTitle: '',
  };
  await enqueueWrite(() => writeJsonSafe(filePath, toSave));
}

export async function getSavedTelegramAccount(
  userId: string
): Promise<TelegramAccount | null> {
  const filePath = path.join(safeUserDir(userId), 'telegram.json');
  const saved = await readJsonSafe<TelegramAccount | null>(filePath, null);
  if (saved?.chatId) return saved;
  return null;
}

export async function saveTelegramAccount(
  userId: string,
  account: TelegramAccount | null
): Promise<void> {
  const filePath = path.join(safeUserDir(userId), 'telegram.json');
  await enqueueWrite(() => writeJsonSafe(filePath, account));
}
