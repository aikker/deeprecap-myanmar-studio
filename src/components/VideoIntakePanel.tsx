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
import { parseJsonResponse } from '../utils/api';

interface VideoIntakePanelProps {
  onVideoLoaded: (asset: VideoAsset) => void;
}

const CHUNK_SIZE_BYTES = 1 * 1024 * 1024; // 1MB multipart chunks avoid proxy timeouts & limits
const MAX_UPLOAD_RETRIES = 3;
const MAX_STATUS_POLL_MS = 10 * 60 * 1000; // 10 minutes max for large transcode

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleFileUpload = async (file: File) => {
    setErrorMsg(null);
    setLoadingMode('file');
    setUploadProgress(0);
    try {
      const initRes = await fetch('/api/video/upload/init', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ filename: file.name, size: file.size }),
      });
      const { uploadId } = await parseJsonResponse<{ uploadId: string }>(initRes);
      if (!uploadId || typeof uploadId !== 'string') {
        throw new Error('Failed to obtain upload session ID from server.');
      }

      const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE_BYTES));
      for (let idx = 0; idx < totalChunks; idx++) {
        const start = idx * CHUNK_SIZE_BYTES;
        const end = Math.min(file.size, start + CHUNK_SIZE_BYTES);
        const blob = file.slice(start, end);

        let lastErr: unknown = null;
        for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
          try {
            const formData = new FormData();
            formData.append('chunk', blob, 'chunk.bin');
            const chunkRes = await fetch(
              `/api/video/upload/chunk/${uploadId}?offset=${start}`,
              {
                method: 'POST',
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
                body: formData,
              }
            );
            await parseJsonResponse<{ ok: boolean }>(chunkRes);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < MAX_UPLOAD_RETRIES) {
              await sleep(attempt * 500);
            }
          }
        }
        if (lastErr) {
          throw lastErr;
        }
        setUploadProgress(Math.round(((idx + 1) / totalChunks) * 90));
      }

      const completeRes = await fetch(`/api/video/upload/complete/${uploadId}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      const completeData = await parseJsonResponse<{
        status: 'uploading' | 'preparing' | 'ready' | 'failed';
        asset?: VideoAsset;
        error?: string;
      }>(completeRes);

      if (completeData.status === 'ready' && completeData.asset) {
        setUploadProgress(100);
        onVideoLoaded(completeData.asset);
        return;
      }

      if (completeData.status === 'failed') {
        throw new Error(completeData.error || 'Unable to process video file.');
      }

      const pollStart = Date.now();
      let consecutivePollErrors = 0;
      while (Date.now() - pollStart < MAX_STATUS_POLL_MS) {
        await sleep(1000);
        try {
          const statusRes = await fetch(`/api/video/upload/status/${uploadId}`, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
          });
          const statusData = await parseJsonResponse<{
            status: 'uploading' | 'preparing' | 'ready' | 'failed';
            asset?: VideoAsset;
            error?: string;
          }>(statusRes);
          consecutivePollErrors = 0;

          if (statusData.status === 'ready' && statusData.asset) {
            setUploadProgress(100);
            onVideoLoaded(statusData.asset);
            return;
          }
          if (statusData.status === 'failed') {
            throw new Error(statusData.error || 'Unable to process video file.');
          }
          setUploadProgress((prev) => (prev < 98 ? prev + 1 : 98));
        } catch (pollErr) {
          consecutivePollErrors++;
          if (
            consecutivePollErrors >= 4 ||
            (pollErr instanceof Error &&
              pollErr.message &&
              !pollErr.message.includes('HTTP 5') &&
              !pollErr.message.includes('network') &&
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
      const res = await fetch('/api/video/youtube', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ url: trimmed }),
      });
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
      const res = await fetch('/api/video/demo', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
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
            You can also drop it here · MP4, MOV, MKV
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
          className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          {errorMsg}
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
