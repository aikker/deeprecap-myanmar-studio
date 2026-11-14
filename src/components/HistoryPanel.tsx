import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  Cloud,
  Download,
  FileAudio,
  FileText,
  History,
  Loader2,
  Play,
  RefreshCw,
  Send,
  Trash2,
  AlertCircle,
} from 'lucide-react';
import type { VideoHistoryItem } from '../types/studio';

interface HistoryPanelProps {
  items: VideoHistoryItem[];
  activeJobId?: string | null;
  telegramConnected: boolean;
  onOpenItem: (item: VideoHistoryItem) => void;
  onDeleteItem: (jobId: string) => Promise<void> | void;
  onSendToTelegram: (jobId: string) => Promise<void>;
  onRefresh: () => void;
}

function formatRemaining(expiresAt: number, now: number): string {
  const diffMs = Math.max(0, expiresAt - now);
  if (diffMs <= 60_000) return '< 1m ကျန်';
  const totalMins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) return `${hours}h ${mins}m ကျန်`;
  return `${mins}m ကျန်`;
}

function formatClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function modeLabel(mode: VideoHistoryItem['mode']): string {
  if (mode === 'recap') return 'AI Recap';
  if (mode === 'dub') return 'Audio Dub';
  return 'Subtitle';
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  items,
  activeJobId,
  telegramConnected,
  onOpenItem,
  onDeleteItem,
  onSendToTelegram,
  onRefresh,
}) => {
  const [now, setNow] = useState(() => Date.now());
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleSendTg = async (jobId: string) => {
    setSendingId(jobId);
    try {
      await onSendToTelegram(jobId);
    } finally {
      setSendingId(null);
    }
  };

  const handleDelete = async (jobId: string) => {
    setDeletingId(jobId);
    try {
      await onDeleteItem(jobId);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200/90 bg-white p-4 sm:p-5 space-y-4 shadow-xs">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-sky-50 border border-sky-100 flex items-center justify-center shrink-0">
            <History className="w-4 h-4 text-[#1D6CE0]" />
          </div>
          <div>
            <h2 className="text-sm sm:text-base font-bold text-slate-900">
              Video History ({items.length})
            </h2>
            <p className="text-xs text-slate-500 font-myanmar mt-0.5">
              Render ပြီးသော Video များကို ၄ နာရီကြာ သိမ်းထားပေးပြီး ၄ နာရီကျော်ပါက အလိုအလျောက် ဖျက်ချပေးပါမည်။
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold px-3 py-2 transition-colors min-h-[36px]"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-7 text-center space-y-1">
          <p className="text-xs font-semibold text-slate-600">
            No saved videos yet
          </p>
          <p className="text-xs text-slate-500 font-myanmar">
            Video တစ်ပုဒ် Start နှိပ်ထုတ်လိုက်ပါက ဤနေရာတွင် ၄ နာရီကြာ သိမ်းပေးထားပါမည်။
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const isRunning =
              item.status !== 'completed' && item.status !== 'failed';
            const isFailed = item.status === 'failed';
            const isCompleted = item.status === 'completed' && Boolean(item.result);
            const isCurrent = activeJobId === item.jobId;
            const title = item.result?.finalTitle || item.title || 'DeepRecap Video';
            const mp4Href = item.result
              ? `${item.result.outputVideoUrl}?download=1&name=${encodeURIComponent(title)}`
              : undefined;
            const wavHref = item.result?.outputAudioUrl
              ? `${item.result.outputAudioUrl}?download=1&name=${encodeURIComponent(`${title}_voice`)}`
              : undefined;
            const srtHref = item.result
              ? `${item.result.outputSrtUrl}?download=1&name=${encodeURIComponent(`${title}_myanmar`)}`
              : undefined;

            return (
              <div
                key={item.jobId}
                className={`rounded-xl border p-3.5 space-y-2.5 transition-colors ${
                  isCurrent
                    ? 'border-[#1D6CE0]/50 bg-sky-50/30'
                    : isFailed
                      ? 'border-rose-200 bg-rose-50/30'
                      : 'border-slate-200/80 bg-slate-50/40'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {isRunning ? (
                        <Cloud className="w-4 h-4 text-[#1D6CE0] shrink-0" />
                      ) : isFailed ? (
                        <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      )}
                      <h3 className="text-sm font-bold text-slate-900 font-myanmar truncate">
                        {title}
                      </h3>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
                      <span className="font-semibold text-slate-700">
                        {modeLabel(item.mode)}
                      </span>
                      <span>· {item.aspectRatio} · 1080p 30fps</span>
                      {item.mirrorFlip && <span>· Mirror</span>}
                      <span>· {formatClock(item.createdAt)}</span>
                      <span className="inline-flex items-center gap-1 text-amber-700 font-medium font-myanmar">
                        <Clock className="w-3 h-3" />
                        {formatRemaining(item.expiresAt, now)}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={deletingId === item.jobId}
                    onClick={() => void handleDelete(item.jobId)}
                    aria-label="Delete from history"
                    title="Delete video"
                    className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0 disabled:opacity-50"
                  >
                    {deletingId === item.jobId ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </div>

                {isRunning && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-[#1D6CE0] font-medium flex items-center gap-1.5 font-myanmar">
                        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                        Cloud ပေါ်တွင် ဆက်လက်လုပ်ဆောင်နေသည် ({item.stepLabel})
                      </span>
                      <span className="font-mono-tabular font-bold text-slate-700">
                        {item.progress}%
                      </span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-slate-200 overflow-hidden">
                      <div
                        className="h-full bg-[#1D6CE0] transition-all duration-300"
                        style={{ width: `${Math.max(5, item.progress)}%` }}
                      />
                    </div>
                  </div>
                )}

                {isFailed && (
                  <p className="text-xs text-rose-700">
                    {item.error || 'Processing failed.'}
                  </p>
                )}

                {isCompleted && item.result && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => onOpenItem(item)}
                        className="inline-flex items-center gap-1 rounded-lg bg-white border border-slate-200 hover:border-[#1D6CE0] text-slate-800 text-xs font-semibold px-2.5 py-1.5 min-h-[34px]"
                      >
                        <Play className="w-3.5 h-3.5 text-[#1D6CE0]" />
                        Open
                      </button>

                      {mp4Href && (
                        <a
                          href={mp4Href}
                          download
                          className="inline-flex items-center gap-1 rounded-lg bg-[#1D6CE0] hover:bg-blue-700 text-white text-xs font-semibold px-3 py-1.5 min-h-[34px]"
                        >
                          <Download className="w-3.5 h-3.5" />
                          MP4
                        </a>
                      )}

                      {wavHref && (
                        <a
                          href={wavHref}
                          download
                          className="inline-flex items-center gap-1 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold px-2.5 py-1.5 min-h-[34px]"
                        >
                          <FileAudio className="w-3.5 h-3.5 text-[#1D6CE0]" />
                          Voice
                        </a>
                      )}

                      {srtHref && (
                        <a
                          href={srtHref}
                          download
                          className="inline-flex items-center gap-1 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold px-2.5 py-1.5 min-h-[34px]"
                        >
                          <FileText className="w-3.5 h-3.5 text-[#1D6CE0]" />
                          SRT
                        </a>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {item.telegramStatus === 'sent' && (
                        <span className="text-[11px] font-semibold text-emerald-700 font-myanmar">
                          ✓ Telegram ပို့ပြီး
                        </span>
                      )}
                      {item.telegramStatus === 'pending' && (
                        <span className="text-[11px] font-semibold text-sky-700 font-myanmar flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Telegram ပို့နေသည်...
                        </span>
                      )}
                      {item.telegramStatus === 'failed' && (
                        <span
                          title={item.telegramError}
                          className="text-[11px] font-semibold text-rose-600 font-myanmar"
                        >
                          Telegram ပို့မရ
                        </span>
                      )}
                      {telegramConnected && (
                        <button
                          type="button"
                          disabled={sendingId === item.jobId}
                          onClick={() => void handleSendTg(item.jobId)}
                          className="inline-flex items-center gap-1 rounded-lg border border-sky-200 bg-sky-50 hover:bg-sky-100 disabled:opacity-50 text-[#1D6CE0] text-xs font-semibold px-2.5 py-1.5 min-h-[34px]"
                        >
                          {sendingId === item.jobId ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          {item.telegramStatus === 'sent' ? 'Resend' : 'Telegram'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
