import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Crop,
  Maximize2,
  Pause,
  Pencil,
  Play,
  Plus,
  X,
} from 'lucide-react';
import type {
  BlurBox,
  StudioConfig,
  SubtitleSegment,
  VideoAsset,
} from '../types/studio';
import { splitSubtitleSegmentsShort } from '../utils/subtitles';

interface VideoStudioPlayerProps {
  asset: VideoAsset;
  config: StudioConfig;
  segments: SubtitleSegment[];
  renderedVideoUrl: string | null;
  activeTool: 'edit' | 'crop' | 'done';
  onActiveToolChange: (tool: 'edit' | 'crop' | 'done') => void;
  onUpdateBlurBoxes: (boxes: BlurBox[]) => void;
  onCycleAspectRatio: () => void;
  seekToSec?: number | null;
}

function formatClock(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const VideoStudioPlayer: React.FC<VideoStudioPlayerProps> = ({
  asset,
  config,
  segments,
  renderedVideoUrl,
  activeTool,
  onActiveToolChange,
  onUpdateBlurBoxes,
  onCycleAspectRatio,
  seekToSec,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const [viewMode, setViewMode] = useState<'preview' | 'final'>('preview');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(asset.duration || 0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(
    config.blurBoxes[0]?.id || null
  );

  // Switch automatically to 'final' when a rendered MP4 becomes available
  useEffect(() => {
    setMediaError(null);
    if (renderedVideoUrl) {
      setViewMode('final');
      setIsPlaying(false);
      setCurrentTime(0);
    } else {
      setViewMode('preview');
    }
  }, [renderedVideoUrl]);

  useEffect(() => {
    if (
      typeof seekToSec === 'number' &&
      videoRef.current &&
      Number.isFinite(seekToSec)
    ) {
      videoRef.current.currentTime = seekToSec;
      setCurrentTime(seekToSec);
    }
  }, [seekToSec]);

  const dragStateRef = useRef<{
    type: 'move' | 'resize';
    boxId: string;
    startX: number;
    startY: number;
    origBox: BlurBox;
  } | null>(null);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragStateRef.current;
      const stage = stageRef.current;
      if (!drag || !stage) return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const dx = (e.clientX - drag.startX) / rect.width;
      const dy = (e.clientY - drag.startY) / rect.height;

      const updated = config.blurBoxes.map((b) => {
        if (b.id !== drag.boxId) return b;
        if (drag.type === 'move') {
          const nx = Math.max(0, Math.min(1 - b.w, drag.origBox.x + dx));
          const ny = Math.max(0, Math.min(1 - b.h, drag.origBox.y + dy));
          return { ...b, x: nx, y: ny };
        }
        const nw = Math.max(0.12, Math.min(1 - b.x, drag.origBox.w + dx));
        const nh = Math.max(0.05, Math.min(1 - b.y, drag.origBox.h + dy));
        return { ...b, w: nw, h: nh };
      });
      onUpdateBlurBoxes(updated);
    };

    const onPointerUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [config.blurBoxes, onUpdateBlurBoxes]);

  const activeSourceUrl =
    viewMode === 'final' && renderedVideoUrl ? renderedVideoUrl : asset.previewUrl;

  const shortPreviewSegments = useMemo(
    () => splitSubtitleSegmentsShort(segments, 34),
    [segments]
  );

  const activeSubtitle = useMemo(() => {
    if (!config.captionsEnabled) return '';
    if (shortPreviewSegments.length > 0) {
      const match = shortPreviewSegments.find(
        (s) => currentTime >= s.startSec && currentTime <= s.endSec
      );
      return match?.myanmarText || '';
    }
    return config.mode === 'recap'
      ? '၃–၅ မိနစ် အနှစ်ချုပ် စာတန်းထိုး'
      : 'မြန်မာဘာသာပြန် စာတန်းထိုး';
  }, [config.captionsEnabled, config.mode, currentTime, shortPreviewSegments]);

  const aspectClass = useMemo(() => {
    switch (config.aspectRatio) {
      case '9:16':
        return 'aspect-[9/16] max-h-[460px] mx-auto';
      case '1:1':
        return 'aspect-square max-h-[420px] mx-auto';
      case '4:5':
        return 'aspect-[4/5] max-h-[440px] mx-auto';
      case '16:9':
        return 'aspect-video';
      default:
        return 'aspect-video';
    }
  }, [config.aspectRatio]);

  const handleTogglePlay = async () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      try {
        setMediaError(null);
        await v.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
        setMediaError(
          'Video preview could not start playback in this browser, but AI dubbing and MP4 export still work normally.'
        );
      }
    } else {
      v.pause();
      setIsPlaying(false);
    }
  };

  const handleAddBlurBox = () => {
    const newBox: BlurBox = {
      id: `blur_${Date.now().toString(36)}`,
      x: 0.08,
      y: 0.77,
      w: 0.84,
      h: 0.12,
    };
    onUpdateBlurBoxes([...config.blurBoxes, newBox]);
    setSelectedBoxId(newBox.id);
    onActiveToolChange('edit');
  };

  const handleDeleteSelectedBox = () => {
    if (config.blurBoxes.length === 0) return;
    if (selectedBoxId) {
      const next = config.blurBoxes.filter((b) => b.id !== selectedBoxId);
      onUpdateBlurBoxes(next);
      setSelectedBoxId(next[0]?.id || null);
    } else {
      const next = config.blurBoxes.slice(0, -1);
      onUpdateBlurBoxes(next);
      setSelectedBoxId(next[0]?.id || null);
    }
  };

  const hexToRgba = (hex: string, opacityPercent: number): string => {
    const cleaned = hex.replace('#', '').trim();
    const full =
      cleaned.length === 3
        ? cleaned
            .split('')
            .map((c) => c + c)
            .join('')
        : cleaned.padEnd(6, '0').slice(0, 6);
    const r = parseInt(full.slice(0, 2), 16) || 0;
    const g = parseInt(full.slice(2, 4), 16) || 0;
    const b = parseInt(full.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, opacityPercent / 100))})`;
  };

  const blurCss = `blur(${Math.max(4, Math.min(24, Math.round(config.blurStrength * 0.75)))}px)`;

  return (
    <div className="space-y-3">
      {renderedVideoUrl && (
        <div className="flex items-center justify-between gap-2 bg-white border border-slate-200 rounded-2xl p-1.5">
          <button
            type="button"
            onClick={() => setViewMode('final')}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold transition-colors min-h-[38px] whitespace-nowrap ${
              viewMode === 'final'
                ? 'bg-[#1D6CE0] text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Final Myanmar Video
          </button>
          <button
            type="button"
            onClick={() => setViewMode('preview')}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold transition-colors min-h-[38px] whitespace-nowrap ${
              viewMode === 'preview'
                ? 'bg-[#1D6CE0] text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Original Studio Editor
          </button>
        </div>
      )}

      {/* Main Video Canvas */}
      <div className="bg-slate-950 rounded-2xl overflow-hidden shadow-sm border border-slate-200/60">
        <div
          ref={stageRef}
          className={`relative w-full bg-slate-950 overflow-hidden select-none ${aspectClass}`}
        >
          <video
            ref={videoRef}
            key={activeSourceUrl}
            src={activeSourceUrl}
            preload="metadata"
            playsInline
            onClick={() => void handleTogglePlay()}
            onLoadedMetadata={(e) => {
              setMediaError(null);
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setDuration(d);
            }}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onEnded={() => setIsPlaying(false)}
            onError={() => {
              setIsPlaying(false);
              setMediaError(
                'Unable to decode video stream in preview. You can still process and download the final MP4.'
              );
            }}
            className={`w-full h-full cursor-pointer transition-transform ${
              config.fitMode === 'cover' && viewMode === 'preview'
                ? 'object-cover'
                : 'object-contain'
            } ${
              config.mirrorFlip && viewMode === 'preview' ? '-scale-x-100' : ''
            }`}
          />
          {/* Live Studio Overlays (only in Preview mode; Final mode has everything burned into MP4!) */}
          {viewMode === 'preview' && (
            <>
              {/* Video Title Overlay */}
              {config.showTitleOverlay && config.videoTitle.trim() && (
                <div className="pointer-events-none absolute top-3 inset-x-4 flex justify-center">
                  <div className="bg-slate-950/75 backdrop-blur-xs text-white px-3.5 py-1.5 rounded-lg text-xs sm:text-sm font-semibold font-myanmar text-center max-w-[90%] shadow-sm">
                    {config.videoTitle}
                  </div>
                </div>
              )}

              {/* Watermark Text */}
              {config.watermarkEnabled && config.watermarkText.trim() && (
                <div className="pointer-events-none absolute top-3 right-3 text-white/65 text-xs font-semibold tracking-wide drop-shadow">
                  {config.watermarkText}
                </div>
              )}

              {/* Round Logo Overlay */}
              {config.logoEnabled && config.logoDataUrl && (
                <img
                  src={config.logoDataUrl}
                  alt="Channel logo"
                  referrerPolicy="no-referrer"
                  className="pointer-events-none absolute top-3 right-3 w-10 h-10 rounded-full object-cover border border-white/50 shadow-sm"
                />
              )}

              {/* Full Band Cover (for original hardcoded subtitles) */}
              {config.fullBandCover && (
                <div
                  className="pointer-events-none absolute bg-slate-900/35 border border-white/20 rounded-md"
                  style={{
                    left: '4%',
                    top: '78%',
                    width: '92%',
                    height: '14%',
                    backdropFilter: blurCss,
                    WebkitBackdropFilter: blurCss,
                  }}
                />
              )}

              {/* Interactive Draggable / Resizable Blur Boxes */}
              {config.blurBoxes.map((box) => {
                const isSelected = box.id === selectedBoxId;
                const isEditing = activeTool === 'edit';
                return (
                  <div
                    key={box.id}
                    onPointerDown={(e) => {
                      if (!isEditing) return;
                      e.stopPropagation();
                      setSelectedBoxId(box.id);
                      dragStateRef.current = {
                        type: 'move',
                        boxId: box.id,
                        startX: e.clientX,
                        startY: e.clientY,
                        origBox: box,
                      };
                    }}
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.w * 100}%`,
                      height: `${box.h * 100}%`,
                      backdropFilter: blurCss,
                      WebkitBackdropFilter: blurCss,
                    }}
                    className={`absolute bg-slate-900/25 rounded-lg transition-colors ${
                      isEditing
                        ? `cursor-move border-2 border-dashed ${
                            isSelected ? 'border-white' : 'border-white/70'
                          }`
                        : 'pointer-events-none border border-white/25'
                    }`}
                  >
                    {isEditing && (
                      <button
                        type="button"
                        aria-label="Resize blur box"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelectedBoxId(box.id);
                          dragStateRef.current = {
                            type: 'resize',
                            boxId: box.id,
                            startX: e.clientX,
                            startY: e.clientY,
                            origBox: box,
                          };
                        }}
                        className="absolute -right-2.5 -bottom-2.5 w-6 h-6 rounded-full bg-white border-2 border-[#1D6CE0] shadow-md cursor-nwse-resize"
                      />
                    )}
                  </div>
                );
              })}

              {/* Live Burmese Subtitle Preview */}
              {config.captionsEnabled && activeSubtitle && (
                <div className="pointer-events-none absolute bottom-[8%] inset-x-4 flex justify-center">
                  <p
                    className={`font-myanmar text-center leading-snug max-w-[92%] ${
                      config.captionBgOpacity === 0 ? 'myanmar-sub-outline' : 'px-3 py-1 rounded-lg'
                    }`}
                    style={{
                      color: config.captionColor || '#FFD400',
                      backgroundColor:
                        config.captionBgOpacity > 0
                          ? hexToRgba(
                              config.captionBgColor || '#0F172A',
                              config.captionBgOpacity
                            )
                          : 'transparent',
                      fontWeight: config.captionWeight === 'bold' ? 700 : 400,
                      fontStyle:
                        config.captionWeight === 'italic' ? 'italic' : 'normal',
                      fontSize: `${Math.max(12, Math.min(30, config.captionSize))}px`,
                      fontFamily: `'${config.captionFont}', 'Noto Sans Myanmar', sans-serif`,
                    }}
                  >
                    {activeSubtitle}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {mediaError && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-xs text-amber-900 flex items-center justify-between gap-3">
          <span>{mediaError}</span>
          <button
            type="button"
            onClick={() => {
              setMediaError(null);
              videoRef.current?.load();
            }}
            className="px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Circular Action Toolbar matching screenshots */}
      {viewMode === 'preview' && (
        <div className="flex items-center justify-center gap-3 sm:gap-4 pt-0.5">
          <button
            type="button"
            onClick={handleDeleteSelectedBox}
            disabled={config.blurBoxes.length === 0}
            className="flex flex-col items-center gap-1 group disabled:opacity-45"
          >
            <span className="w-11 h-11 rounded-full bg-rose-100 text-rose-600 group-hover:bg-rose-200 flex items-center justify-center transition-colors">
              <X className="w-5 h-5" />
            </span>
            <span className="text-[11px] font-medium text-slate-500">Delete</span>
          </button>

          <button
            type="button"
            onClick={handleAddBlurBox}
            className="flex flex-col items-center gap-1 group"
          >
            <span className="w-11 h-11 rounded-full bg-[#24344D] text-white group-hover:bg-slate-800 flex items-center justify-center transition-colors">
              <Plus className="w-5 h-5" />
            </span>
            <span className="text-[11px] font-medium text-slate-600">Blur</span>
          </button>

          <button
            type="button"
            onClick={() =>
              onActiveToolChange(activeTool === 'edit' ? 'done' : 'edit')
            }
            className="flex flex-col items-center gap-1 group"
          >
            <span
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-all ${
                activeTool === 'edit'
                  ? 'bg-[#24344D] text-white ring-2 ring-[#1D6CE0] ring-offset-2'
                  : 'bg-[#24344D] text-white group-hover:bg-slate-800'
              }`}
            >
              <Pencil className="w-4 h-4" />
            </span>
            <span className="text-[11px] font-medium text-slate-700">Edit</span>
          </button>

          <button
            type="button"
            onClick={onCycleAspectRatio}
            className="flex flex-col items-center gap-1 group"
          >
            <span
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-all ${
                activeTool === 'crop'
                  ? 'bg-[#24344D] text-white ring-2 ring-[#1D6CE0] ring-offset-2'
                  : 'bg-[#24344D] text-white group-hover:bg-slate-800'
              }`}
            >
              <Crop className="w-4 h-4" />
            </span>
            <span className="text-[11px] font-medium text-slate-600">Crop</span>
          </button>

          <button
            type="button"
            onClick={() => onActiveToolChange('done')}
            className="flex flex-col items-center gap-1 group"
          >
            <span className="w-11 h-11 rounded-full bg-[#1D6CE0] text-white group-hover:bg-blue-700 flex items-center justify-center transition-colors">
              <Check className="w-5 h-5" />
            </span>
            <span className="text-[11px] font-medium text-slate-600">Done</span>
          </button>
        </div>
      )}

      {/* Dark Navy Scrubber Bar */}
      <div className="flex items-center gap-3 rounded-2xl bg-[#162238] text-white px-3 py-2 shadow-xs">
        <button
          type="button"
          onClick={handleTogglePlay}
          aria-label={isPlaying ? 'Pause video' : 'Play video'}
          className="w-10 h-10 rounded-xl flex items-center justify-center hover:bg-white/10 transition-colors shrink-0"
        >
          {isPlaying ? (
            <Pause className="w-4 h-4 fill-white" />
          ) : (
            <Play className="w-4 h-4 fill-white ml-0.5" />
          )}
        </button>

        <input
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={0.1}
          value={currentTime}
          aria-label="Seek video timeline"
          onChange={(e) => {
            const t = Number(e.target.value);
            setCurrentTime(t);
            if (videoRef.current) videoRef.current.currentTime = t;
          }}
          className="scrubber-range w-full"
        />

        <span className="font-mono-tabular text-xs text-slate-200 whitespace-nowrap shrink-0">
          {formatClock(currentTime)} / {formatClock(duration)}
        </span>

        <button
          type="button"
          aria-label="Toggle fullscreen"
          onClick={() => {
            const v = videoRef.current;
            if (v && v.requestFullscreen) {
              void v.requestFullscreen();
            }
          }}
          className="w-10 h-10 rounded-xl flex items-center justify-center hover:bg-white/10 transition-colors shrink-0"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
