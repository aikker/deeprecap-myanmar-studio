import React, { useRef, useState } from 'react';
import {
  ClipboardPaste,
  Download,
  Film,
  Info,
  Link2,
  Loader2,
  Upload,
} from 'lucide-react';
import type { VideoAsset } from '../types/studio';
import {
  parseJsonResponse,
  refreshAuthBridgeSession,
  safeApiFetch,
} from '../utils/api';

interface VideoIntakePanelProps {
  onVideoLoaded: (asset: VideoAsset) => void;
}

const CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2MB chunks balance speed & mobile reliability
const FALLBACK_SUBCHUNK_BYTES = 512 * 1024; // 512KB adaptive fallback when a larger chunk hits proxy/network drops
const MAX_UPLOAD_RETRIES = 6;
const CHUNK_TIMEOUT_MS = 45_000;
const MAX_STATUS_POLL_MS = 10 * 60 * 1000; // 10 minutes max for large transcode
const RESUME_STORAGE_KEY = 'dr_resume_upload_v1';

interface SavedResumeState {
  fileKey: string;
  uploadId: string;
  uploadedBytes: number;
  updatedAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function loadResumeState(fileKey: string): SavedResumeState | null {
  try {
    const raw = localStorage.getItem(RESUME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedResumeState;
    if (
      parsed.fileKey !== fileKey ||
      !parsed.uploadId ||
      Date.now() - parsed.updatedAt > 2 * 60 * 60 * 1000
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveResumeState(state: SavedResumeState): void {
  try {
    localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage quota
  }
}

function clearResumeState(): void {
  try {
    localStorage.removeItem(RESUME_STORAGE_KEY);
  } catch {
    // ignore
  }
}

async function waitForOnline(maxWaitMs = 15_000): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.onLine) return;
  const start = Date.now();
  while (!navigator.onLine && Date.now() - start < maxWaitMs) {
    await sleep(500);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = CHUNK_TIMEOUT_MS
): Promise<Response> {
  return safeApiFetch(url, init, timeoutMs);
}

export const VideoIntakePanel: React.FC<VideoIntakePanelProps> = ({
  onVideoLoaded,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [linkValue, setLinkValue] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [loadingMode, setLoadingMode] = useState<'file' | 'youtube' | 'demo' | null>(
    null
  );
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadDetail, setUploadDetail] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const uploadSingleSliceWithRetry = async (
    uploadId: string,
    sliceBlob: Blob,
    offset: number,
    allowSplit = true
  ): Promise<void> => {
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
      try {
        await waitForOnline();
        const formData = new FormData();
        formData.append('chunk', sliceBlob, 'chunk.bin');
        const chunkRes = await fetchWithTimeout(
          `/api/video/upload/chunk/${uploadId}?offset=${offset}`,
          {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: formData,
          }
        );
        await parseJsonResponse<{ ok: boolean }>(chunkRes);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : '';
        if (
          msg.includes('Session auth expired') ||
          msg.includes('Upload session not found')
        ) {
          throw err;
        }
        // If a 2MB chunk fails due to network/timeout/413, adaptively split into 512KB sub-chunks
        if (allowSplit && sliceBlob.size > FALLBACK_SUBCHUNK_BYTES) {
          for (
            let subStart = 0;
            subStart < sliceBlob.size;
            subStart += FALLBACK_SUBCHUNK_BYTES
          ) {
            const subEnd = Math.min(
              sliceBlob.size,
              subStart + FALLBACK_SUBCHUNK_BYTES
            );
            await uploadSingleSliceWithRetry(
              uploadId,
              sliceBlob.slice(subStart, subEnd),
              offset + subStart,
              false
            );
          }
          return;
        }
        if (attempt < MAX_UPLOAD_RETRIES) {
          setUploadDetail(`Network retry ${attempt}/${MAX_UPLOAD_RETRIES - 1}...`);
          await sleep(Math.min(8000, Math.pow(2, attempt - 1) * 1000));
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('Upload connection failed. Please try again to resume.');
  };

  const handleFileUpload = async (file: File) => {
    setErrorMsg(null);
    setLoadingMode('file');
    setUploadProgress(0);
    setUploadDetail(null);

    const fileKey = getFileKey(file);
    let uploadId = '';
    let startByteOffset = 0;
    let alreadyCompleting = false;

    try {
      const saved = loadResumeState(fileKey);
      if (saved) {
        try {
          const checkRes = await fetchWithTimeout(
            `/api/video/upload/status/${saved.uploadId}`,
            { headers: { Accept: 'application/json' } },
            15_000
          );
          if (checkRes.ok) {
            const checkData = await parseJsonResponse<{
              status: 'uploading' | 'preparing' | 'ready' | 'failed';
              uploadedBytes?: number;
              asset?: VideoAsset;
            }>(checkRes);
            if (checkData.status === 'ready' && checkData.asset) {
              clearResumeState();
              setUploadProgress(100);
              onVideoLoaded(checkData.asset);
              return;
            }
            if (checkData.status === 'preparing') {
              uploadId = saved.uploadId;
              alreadyCompleting = true;
              setUploadProgress(92);
            } else if (checkData.status === 'uploading') {
              uploadId = saved.uploadId;
              const serverBytes = Number(checkData.uploadedBytes) || 0;
              startByteOffset = Math.min(
                file.size,
                Math.min(saved.uploadedBytes, serverBytes)
              );
              if (startByteOffset > 0) {
                const pct = Math.round((startByteOffset / file.size) * 90);
                setUploadProgress(pct);
                setUploadDetail(`Resuming from ${pct}%...`);
              }
            }
          }
        } catch {
          // ignore resume probe failure and start fresh
        }
      }

      if (!uploadId) {
        const initRes = await fetchWithTimeout(
          '/api/video/upload/init',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ filename: file.name, size: file.size }),
          },
          20_000
        );
        const initData = await parseJsonResponse<{ uploadId: string }>(initRes);
        if (!initData.uploadId || typeof initData.uploadId !== 'string') {
          throw new Error('Failed to obtain upload session ID from server.');
        }
        uploadId = initData.uploadId;
        startByteOffset = 0;
        saveResumeState({
          fileKey,
          uploadId,
          uploadedBytes: 0,
          updatedAt: Date.now(),
        });
      }

      if (!alreadyCompleting) {
        const totalMb = Math.max(1, Math.round(file.size / (1024 * 1024)));
        let lastKeepAlive = Date.now();
        for (
          let offset = startByteOffset;
          offset < file.size;
          offset += CHUNK_SIZE_BYTES
        ) {
          if (Date.now() - lastKeepAlive > 20_000) {
            lastKeepAlive = Date.now();
            void refreshAuthBridgeSession();
          }
          const end = Math.min(file.size, offset + CHUNK_SIZE_BYTES);
          const blob = file.slice(offset, end);
          const uploadedMb = Math.round(end / (1024 * 1024));
          setUploadDetail(`${uploadedMb} / ${totalMb} MB`);

          await uploadSingleSliceWithRetry(uploadId, blob, offset, true);

          saveResumeState({
            fileKey,
            uploadId,
            uploadedBytes: end,
            updatedAt: Date.now(),
          });
          setUploadProgress(
            Math.max(1, Math.round((end / Math.max(1, file.size)) * 90))
          );
        }
      }

      setUploadDetail('Processing video...');
      const completeRes = await fetchWithTimeout(
        `/api/video/upload/complete/${uploadId}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json' },
        },
        30_000
      );
      const completeData = await parseJsonResponse<{
        status: 'uploading' | 'preparing' | 'ready' | 'failed';
        asset?: VideoAsset;
        error?: string;
      }>(completeRes);

      if (completeData.status === 'ready' && completeData.asset) {
        clearResumeState();
        setUploadProgress(100);
        onVideoLoaded(completeData.asset);
        return;
      }

      if (completeData.status === 'failed') {
        clearResumeState();
        throw new Error(completeData.error || 'Unable to process video file.');
      }

      const pollStart = Date.now();
      let consecutivePollErrors = 0;
      while (Date.now() - pollStart < MAX_STATUS_POLL_MS) {
        await sleep(1000);
        try {
          const statusRes = await fetchWithTimeout(
            `/api/video/upload/status/${uploadId}`,
            { headers: { Accept: 'application/json' } },
            15_000
          );
          const statusData = await parseJsonResponse<{
            status: 'uploading' | 'preparing' | 'ready' | 'failed';
            asset?: VideoAsset;
            error?: string;
          }>(statusRes);
          consecutivePollErrors = 0;

          if (statusData.status === 'ready' && statusData.asset) {
            clearResumeState();
            setUploadProgress(100);
            onVideoLoaded(statusData.asset);
            return;
          }
          if (statusData.status === 'failed') {
            clearResumeState();
            throw new Error(statusData.error || 'Unable to process video file.');
          }
          setUploadProgress((prev) => (prev < 98 ? prev + 1 : 98));
        } catch (pollErr) {
          consecutivePollErrors++;
          if (
            consecutivePollErrors >= 5 ||
            (pollErr instanceof Error &&
              pollErr.message &&
              !pollErr.message.includes('HTTP 5') &&
              !pollErr.message.includes('network') &&
              !pollErr.message.includes('Failed to fetch') &&
              !pollErr.message.includes('aborted') &&
              !pollErr.message.includes('HTML page') &&
              !pollErr.message.includes('non-JSON'))
          ) {
            throw pollErr;
          }
        }
      }

      throw new Error('Video preparation timed out. Please try a smaller clip.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Unable to process video file.'
      );
    } finally {
      setLoadingMode(null);
      setUploadProgress(0);
      setUploadDetail(null);
    }
  };

  const handleYouTubeLoad = async () => {
    const trimmed = linkValue.trim();
    if (!trimmed) {
      setErrorMsg('Please paste a YouTube video link first.');
      return;
    }
    setErrorMsg(null);
    setLoadingMode('youtube');
    try {
      const res = await safeApiFetch(
        '/api/video/youtube',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ url: trimmed }),
        },
        90_000
      );
      const asset = await parseJsonResponse<VideoAsset>(res);
      onVideoLoaded(asset);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not load YouTube link.'
      );
    } finally {
      setLoadingMode(null);
    }
  };

  const handleDemoLoad = async () => {
    setErrorMsg(null);
    setLoadingMode('demo');
    try {
      const res = await safeApiFetch(
        '/api/video/demo',
        {
          method: 'POST',
          headers: { Accept: 'application/json' },
        },
        60_000
      );
      const asset = await parseJsonResponse<VideoAsset>(res);
      onVideoLoaded(asset);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Could not generate sample video.'
      );
    } finally {
      setLoadingMode(null);
    }
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setLinkValue(text.trim());
        setErrorMsg(null);
      }
    } catch {
      setErrorMsg('Clipboard access blocked — please paste link manually into the box.');
    }
  };

  return (
    <div className="w-full max-w-xl mx-auto space-y-4">
      <div className="bg-white rounded-3xl border border-slate-200/90 p-5 sm:p-6 shadow-xs space-y-5">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) void handleFileUpload(dropped);
          }}
          onClick={() => {
            if (!loadingMode) fileInputRef.current?.click();
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && !loadingMode) {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={`relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors ${
            isDragging
              ? 'border-[#1D6CE0] bg-sky-50'
              : 'border-sky-300/90 bg-sky-50/45 hover:bg-sky-50/80'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void handleFileUpload(file);
            }}
          />

          <div className="w-12 h-12 rounded-2xl bg-white border border-slate-200/80 shadow-xs flex items-center justify-center mb-3.5 text-[#1D6CE0]">
            {loadingMode === 'file' ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : (
              <Upload className="w-6 h-6" />
            )}
          </div>

          <p className="text-base font-semibold text-slate-900">
            {loadingMode === 'file'
              ? uploadProgress >= 90
                ? 'Preparing video for studio...'
                : `Uploading video (${uploadProgress}%)...`
              : 'Choose a video file'}
          </p>
          <p className="text-sm text-slate-500 mt-1">
            {loadingMode === 'file' && uploadDetail
              ? uploadDetail
              : 'You can also drop it here · MP4, MOV, MKV'}
          </p>
        </div>

        <div className="relative flex items-center justify-center">
          <span className="text-xs font-medium text-slate-400">
            or paste a link
          </span>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50/70 pl-3.5 pr-1.5 py-1.5 focus-within:border-[#1D6CE0] focus-within:bg-white transition-colors">
            <Link2 className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              type="url"
              value={linkValue}
              onChange={(e) => setLinkValue(e.target.value)}
              placeholder="YouTube link (https://youtube.com/...)"
              aria-label="YouTube link"
              className="w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none py-1.5"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleYouTubeLoad();
              }}
            />
            <button
              type="button"
              onClick={handlePasteClipboard}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-sky-50 hover:bg-sky-100 text-[#1D6CE0] text-xs font-semibold transition-colors whitespace-nowrap shrink-0 min-h-[38px]"
            >
              <ClipboardPaste className="w-3.5 h-3.5" />
              Paste
            </button>
          </div>

          <button
            type="button"
            disabled={Boolean(loadingMode)}
            onClick={handleYouTubeLoad}
            className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-[#E2E8F0] hover:bg-[#1D6CE0] hover:text-white disabled:opacity-60 text-slate-700 font-semibold text-sm py-3 px-4 transition-colors min-h-[46px]"
          >
            {loadingMode === 'youtube' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading YouTube video...
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Download from link
              </>
            )}
          </button>
        </div>

        <div className="pt-1 flex items-center justify-between gap-3 border-t border-slate-100">
          <span className="text-xs text-slate-500 font-myanmar">
            နမူနာဗီဒီယိုဖြင့် အမြန်စမ်းသပ်ကြည့်ရန်
          </span>
          <button
            type="button"
            disabled={Boolean(loadingMode)}
            onClick={handleDemoLoad}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 transition-colors whitespace-nowrap shrink-0 min-h-[38px]"
          >
            {loadingMode === 'demo' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1D6CE0]" />
            ) : (
              <Film className="w-3.5 h-3.5 text-[#1D6CE0]" />
            )}
            Load Sample Clip
          </button>
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 space-y-2.5"
        >
          <p>{errorMsg}</p>
          {errorMsg.toLowerCase().includes('refresh') && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold px-3.5 py-2 transition-colors"
            >
              Refresh Page Now
            </button>
          )}
        </div>
      )}

      <div className="flex items-start gap-3 rounded-2xl border border-sky-100 bg-sky-50/75 px-4 py-3.5 text-sm text-slate-700">
        <Info className="w-4 h-4 text-[#1D6CE0] shrink-0 mt-0.5" />
        <p className="leading-relaxed font-myanmar">
          <span className="font-semibold text-slate-900">Audio Dub</span>{' '}
          (Thiha Voice ဖြင့် မြန်မာဘာသာပြန် အသံသွင်း) သို့မဟုတ်{' '}
          <span className="font-semibold text-slate-900">AI Recap</span>{' '}
          (ဗီဒီယိုတစ်ခုလုံးကို 3–5 မိနစ် အနှစ်ချုပ်) ကို ရွေးချယ်ပြီး
          မြန်မာစာတန်းထိုးနှင့်တကွ MP4 ဒေါင်းလုဒ်ရယူနိုင်ပါသည်။
        </p>
      </div>
    </div>
  );
};
