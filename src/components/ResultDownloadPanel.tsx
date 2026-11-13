import React, { useState } from 'react';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileAudio,
  FileText,
  Github,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type {
  GitHubAuthStatus,
  ProcessJobStatus,
  SubtitleSegment,
} from '../types/studio';
import { parseJsonResponse } from '../utils/api';

interface ResultDownloadPanelProps {
  job: ProcessJobStatus | null;
  editableSegments: SubtitleSegment[];
  onEditSegment: (id: string, nextText: string) => void;
  onSeekTo: (sec: number) => void;
  onRerender: () => void;
  isProcessing: boolean;
  githubAuth?: GitHubAuthStatus;
}

function formatTime(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const ResultDownloadPanel: React.FC<ResultDownloadPanelProps> = ({
  job,
  editableSegments,
  onEditSegment,
  onSeekTo,
  onRerender,
  isProcessing,
  githubAuth,
}) => {
  const [savingGist, setSavingGist] = useState(false);
  const [gistUrl, setGistUrl] = useState<string | null>(null);
  const [gistError, setGistError] = useState<string | null>(null);

  if (!job) return null;

  if (job.status === 'failed') {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-2"
      >
        <p className="text-sm font-bold text-rose-900">Processing Error</p>
        <p className="text-sm text-rose-700">{job.error || 'Failed to render video.'}</p>
      </div>
    );
  }

  if (job.status !== 'completed') {
    return (
      <div className="rounded-2xl bg-white border border-slate-200/90 p-5 space-y-3 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Loader2 className="w-5 h-5 animate-spin text-[#1D6CE0] shrink-0" />
            <span className="text-sm font-semibold text-slate-900">
              {job.stepLabel}
            </span>
          </div>
          <span className="font-mono-tabular text-xs font-bold text-[#1D6CE0]">
            {job.progress}%
          </span>
        </div>
        <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full bg-[#1D6CE0] transition-all duration-300"
            style={{ width: `${Math.max(5, job.progress)}%` }}
          />
        </div>
      </div>
    );
  }

  if (!job.result) return null;

  const {
    outputVideoUrl,
    outputAudioUrl,
    outputSrtUrl,
    finalTitle,
    socialCaption,
    durationSec,
  } = job.result;

  const mp4DownloadHref = `${outputVideoUrl}?download=1&name=${encodeURIComponent(
    finalTitle || 'deeprecap_myanmar'
  )}`;
  const wavDownloadHref = outputAudioUrl
    ? `${outputAudioUrl}?download=1&name=${encodeURIComponent(
        `${finalTitle || 'deeprecap'}_voice`
      )}`
    : null;
  const srtDownloadHref = `${outputSrtUrl}?download=1&name=${encodeURIComponent(
    `${finalTitle || 'deeprecap'}_myanmar`
  )}`;

  const handleSaveToGist = async () => {
    setSavingGist(true);
    setGistError(null);
    try {
      const ghSession = sessionStorage.getItem('dr_gh_session_token') || '';
      const res = await fetch('/api/github/gist', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(ghSession ? { 'x-github-session': ghSession } : {}),
        },
        body: JSON.stringify({
          title: finalTitle,
          socialCaption,
          segments: editableSegments,
        }),
      });
      const data = await parseJsonResponse<{ gistUrl?: string }>(res);
      if (data.gistUrl) {
        setGistUrl(data.gistUrl);
      }
    } catch (err) {
      setGistError(
        err instanceof Error ? err.message : 'Unable to save to GitHub Gist.'
      );
    } finally {
      setSavingGist(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-white border border-emerald-200 p-5 space-y-4 shadow-xs">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-base font-bold text-slate-900 font-myanmar">
                {finalTitle}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Ready for download · <span className="font-mono-tabular">{formatTime(durationSec)}</span> · 1080p 30fps MP4 + Myanmar Subtitles
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <a
            href={mp4DownloadHref}
            download
            className="flex-1 min-w-[200px] inline-flex items-center justify-center gap-2 rounded-xl bg-[#1D6CE0] hover:bg-blue-700 text-white font-semibold text-sm py-3 px-4 transition-colors min-h-[46px]"
          >
            <Download className="w-4 h-4" />
            Download Video (.mp4)
          </a>

          {wavDownloadHref && (
            <a
              href={wavDownloadHref}
              download
              className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-800 font-semibold text-xs py-3 px-3.5 transition-colors min-h-[46px] whitespace-nowrap"
            >
              <FileAudio className="w-4 h-4 text-[#1D6CE0]" />
              Voice (.wav)
            </a>
          )}

          <a
            href={srtDownloadHref}
            download
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-800 font-semibold text-xs py-3 px-3.5 transition-colors min-h-[46px] whitespace-nowrap"
          >
            <FileText className="w-4 h-4 text-[#1D6CE0]" />
            Subtitles (.srt)
          </a>

          {githubAuth?.connected &&
            (gistUrl ? (
              <a
                href={gistUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-900 bg-slate-900 text-white font-semibold text-xs py-3 px-3.5 transition-colors min-h-[46px] whitespace-nowrap"
              >
                <Github className="w-4 h-4" />
                View Gist
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            ) : (
              <button
                type="button"
                disabled={savingGist}
                onClick={() => void handleSaveToGist()}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 disabled:opacity-60 text-slate-800 font-semibold text-xs py-3 px-3.5 transition-colors min-h-[46px] whitespace-nowrap"
              >
                {savingGist ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Github className="w-4 h-4 text-slate-800" />
                )}
                Save to GitHub
              </button>
            ))}
        </div>

        {gistError && <p className="text-xs text-rose-600">{gistError}</p>}
      </div>

      {/* Editable Burmese Script & Subtitle Timeline */}
      {editableSegments.length > 0 && (
        <div className="rounded-2xl bg-white border border-slate-200/80 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-bold text-slate-900">
                Myanmar Subtitles & Voice Script
              </h4>
              <p className="text-xs text-slate-500">
                Edit any Burmese line and click Re-render to update video
              </p>
            </div>
            <button
              type="button"
              disabled={isProcessing}
              onClick={onRerender}
              className="inline-flex items-center gap-1.5 rounded-xl bg-sky-50 hover:bg-sky-100 text-[#1D6CE0] text-xs font-bold px-3 py-2 transition-colors min-h-[38px] whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Re-render MP4
            </button>
          </div>

          <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
            {editableSegments.map((seg) => (
              <div
                key={seg.id}
                className="flex items-start gap-2.5 rounded-xl border border-slate-100 bg-slate-50/70 p-2.5"
              >
                <button
                  type="button"
                  onClick={() => onSeekTo(seg.startSec)}
                  className="font-mono-tabular text-[11px] font-semibold text-[#1D6CE0] hover:underline pt-1 shrink-0"
                >
                  {formatTime(seg.startSec)}
                </button>
                <textarea
                  rows={2}
                  value={seg.myanmarText}
                  onChange={(e) => onEditSegment(seg.id, e.target.value)}
                  className="w-full bg-white rounded-lg border border-slate-200/80 px-2.5 py-1.5 text-xs font-myanmar text-slate-900 focus:border-[#1D6CE0] focus:outline-none resize-none"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

