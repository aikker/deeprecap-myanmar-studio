import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Ytdl, type FormatMetadata } from '@distube/ytdl-core';
import type {
  AspectRatioOption,
  BlurBox,
  CaptionStyleOption,
  CaptionWeightOption,
  SubtitleSegment,
  VideoFitMode,
} from '../src/types/studio.ts';
import { splitSubtitleSegmentsShort } from '../src/utils/subtitles.ts';

const execFileAsync = promisify(execFile);

export const BASE_MEDIA_DIR = '/tmp/deeprecap-studio';
export const UPLOADS_DIR = path.join(BASE_MEDIA_DIR, 'uploads');
export const WORK_DIR = path.join(BASE_MEDIA_DIR, 'work');
export const OUTPUTS_DIR = path.join(BASE_MEDIA_DIR, 'outputs');

export async function ensureMediaDirs(): Promise<void> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(WORK_DIR, { recursive: true });
  await fs.mkdir(OUTPUTS_DIR, { recursive: true });
}

export interface VideoProbeInfo {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec?: string;
  pixFmt?: string;
  audioCodec?: string;
}

export async function probeMedia(filePath: string): Promise<VideoProbeInfo> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      duration?: string;
    }>;
  };

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  const rawDuration =
    Number(parsed.format?.duration) ||
    Number(videoStream?.duration) ||
    Number(audioStream?.duration) ||
    0;

  return {
    duration: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 15,
    width: videoStream?.width || 1280,
    height: videoStream?.height || 720,
    hasAudio: Boolean(audioStream),
    videoCodec: videoStream?.codec_name,
    pixFmt: videoStream?.pix_fmt,
    audioCodec: audioStream?.codec_name,
  };
}

export async function transcodeToBrowserMp4IfNeeded(
  inputPath: string,
  outputPath: string
): Promise<string> {
  const ext = path.extname(inputPath).toLowerCase();
  let isBrowserReadyH264 = false;

  try {
    const info = await probeMedia(inputPath);
    const compatiblePixFmt =
      !info.pixFmt || info.pixFmt === 'yuv420p' || info.pixFmt === 'yuvj420p';
    const compatibleAudio = !info.hasAudio || info.audioCodec === 'aac';
    if (
      ext === '.mp4' &&
      info.videoCodec === 'h264' &&
      compatiblePixFmt &&
      compatibleAudio
    ) {
      isBrowserReadyH264 = true;
    }
  } catch {
    isBrowserReadyH264 = false;
  }

  if (isBrowserReadyH264) {
    try {
      // Faststream-optimize moov atom without re-encoding
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        outputPath,
      ]);
      return outputPath;
    } catch {
      return inputPath;
    }
  }

  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outputPath,
  ]);
  return outputPath;
}

export async function extractAudioTrack(
  videoPath: string,
  outMp3Path: string
): Promise<boolean> {
  try {
    const info = await probeMedia(videoPath);
    if (!info.hasAudio) return false;
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '48k',
      '-t',
      '600',
      outMp3Path,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function extractSampleKeyframes(
  videoPath: string,
  duration: number,
  jobWorkDir: string,
  count = 6
): Promise<string[]> {
  const frames: string[] = [];
  const safeDuration = Math.max(duration, 2);
  const actualCount = Math.min(count, Math.max(2, Math.floor(safeDuration)));

  for (let i = 0; i < actualCount; i++) {
    const ts = Math.min(
      safeDuration - 0.3,
      Math.max(0.2, ((i + 0.5) / actualCount) * safeDuration)
    );
    const framePath = path.join(jobWorkDir, `frame_${i}.jpg`);
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        ts.toFixed(2),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:-2',
        '-q:v',
        '5',
        framePath,
      ]);
      frames.push(framePath);
    } catch {
      // skip failed frame
    }
  }
  return frames;
}

export async function createDemoSampleVideo(outPath: string): Promise<void> {
  // Creates a smooth 24-second multi-scene drama/story sample MP4 with subtitles at the bottom
  // so users can test blur boxes, Myanmar dubbing, and 3-5 min recap immediately.
  const filter = [
    'color=c=#18263d:s=1280x720:d=8[c1]',
    'color=c=#243b55:s=1280x720:d=8[c2]',
    'color=c=#132a2e:s=1280x720:d=8[c3]',
    '[c1]drawbox=x=120:y=100:w=1040:h=460:color=#2a4365@0.55:t=fill,drawbox=x=180:y=590:w=920:h=68:color=black@0.6:t=fill[v1]',
    '[c2]drawbox=x=120:y=100:w=1040:h=460:color=#3b4f73@0.55:t=fill,drawbox=x=180:y=590:w=920:h=68:color=black@0.6:t=fill[v2]',
    '[c3]drawbox=x=120:y=100:w=1040:h=460:color=#234e52@0.55:t=fill,drawbox=x=180:y=590:w=920:h=68:color=black@0.6:t=fill[v3]',
    '[v1][v2][v3]concat=n=3:v=1:a=0[vcat]',
    "[vcat]drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansMyanmar-Bold.ttf:text='Scene 1 - The Unexpected Confrontation':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=290:enable='between(t,0,8)',drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansMyanmar-Bold.ttf:text='Scene 2 - Hidden Truth Revealed':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=290:enable='between(t,8,16)',drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansMyanmar-Bold.ttf:text='Scene 3 - A New Beginning':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=290:enable='between(t,16,24)',drawtext=fontfile=/usr/share/fonts/truetype/noto/NotoSansMyanmar-Regular.ttf:text='Original dialogue subtitle line (test blur box here)':fontcolor=#e2e8f0:fontsize=24:x=(w-text_w)/2:y=612[vout]",
  ].join(';');

  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=44100:duration=24',
    '-filter_complex',
    filter,
    '-map',
    '[vout]',
    '-map',
    '0:a',
    '-af',
    'volume=0.05',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-movflags',
    '+faststart',
    outPath,
  ]);
}

export function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.replace('/', '').split('/')[0] || null;
    }
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const parts = u.pathname.split('/').filter(Boolean);
      const shortsIdx = parts.indexOf('shorts');
      if (shortsIdx !== -1 && parts[shortsIdx + 1]) return parts[shortsIdx + 1];
      const embedIdx = parts.indexOf('embed');
      if (embedIdx !== -1 && parts[embedIdx + 1]) return parts[embedIdx + 1];
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchYouTubeOEmbed(
  youtubeUrl: string
): Promise<{ title: string; author?: string; thumbnailUrl?: string }> {
  try {
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(youtubeUrl)}&format=json`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('oEmbed failed');
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };
    return {
      title: data.title || 'YouTube Video',
      author: data.author_name,
      thumbnailUrl: data.thumbnail_url,
    };
  } catch {
    const ytId = extractYouTubeId(youtubeUrl);
    return {
      title: 'YouTube Video',
      thumbnailUrl: ytId
        ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`
        : undefined,
    };
  }
}

export async function downloadYouTubeToFile(
  youtubeUrl: string,
  outMp4Path: string,
  thumbnailUrl?: string
): Promise<{ downloadedRealStream: boolean }> {
  // First attempt direct stream download via @distube/ytdl-core v5
  try {
    const ytdl = new Ytdl({ timeoutMs: 18000 });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ytdl timeout')), 22000);
      const stream = ytdl.download(youtubeUrl, {
        quality: 'highest',
        filter: (format: FormatMetadata) =>
          Boolean(format.hasVideo && format.hasAudio && format.container === 'mp4'),
      });
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const MAX_BYTES = 180 * 1024 * 1024;

      stream.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BYTES) {
          clearTimeout(timeout);
          stream.destroy();
          reject(new Error('Video exceeds 180MB limit'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', async () => {
        clearTimeout(timeout);
        if (chunks.length === 0) {
          reject(new Error('Empty stream'));
          return;
        }
        await fs.writeFile(outMp4Path, Buffer.concat(chunks));
        resolve();
      });
      stream.on('error', (err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const stats = await fs.stat(outMp4Path);
    if (stats.size > 10000) {
      return { downloadedRealStream: true };
    }
  } catch {
    // Fall back to thumbnail-driven HD base canvas if YouTube blocks datacenter IP
  }

  // Fallback: fetch YouTube thumbnail and build an HD base canvas video
  const thumbPath = `${outMp4Path}.jpg`;
  let hasThumb = false;
  if (thumbnailUrl) {
    try {
      const res = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(thumbPath, buf);
        hasThumb = true;
      }
    } catch {
      hasThumb = false;
    }
  }

  if (hasThumb) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-loop',
      '1',
      '-i',
      thumbPath,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=mono:sample_rate=24000',
      '-t',
      '30',
      '-vf',
      'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=#0f172a,setsar=1',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      '+faststart',
      outMp4Path,
    ]);
  } else {
    await createDemoSampleVideo(outMp4Path);
  }

  return { downloadedRealStream: false };
}

export async function adjustAudioSpeedPitch(
  inWavPath: string,
  outWavPath: string,
  speedPercent: number,
  pitchHz: number
): Promise<void> {
  const speedRatio = Math.min(1.85, Math.max(0.55, 1 + speedPercent / 100));
  const pitchFactor = Math.min(1.3, Math.max(0.75, 1 + pitchHz * 0.008));

  if (Math.abs(speedRatio - 1) < 0.02 && Math.abs(pitchFactor - 1) < 0.01) {
    await fs.copyFile(inWavPath, outWavPath);
    return;
  }

  // Adjusting pitch via asetrate + aresample, then compensating speed with atempo
  const combinedTempo = speedRatio / pitchFactor;
  const tempoFilters: string[] = [];
  let remaining = combinedTempo;
  while (remaining > 2.0) {
    tempoFilters.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    tempoFilters.push('atempo=0.5');
    remaining /= 0.5;
  }
  tempoFilters.push(`atempo=${remaining.toFixed(4)}`);

  const filterChain = [
    `asetrate=${Math.round(24000 * pitchFactor)}`,
    'aresample=24000',
    ...tempoFilters,
  ].join(',');

  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    inWavPath,
    '-af',
    filterChain,
    '-ar',
    '24000',
    '-ac',
    '1',
    outWavPath,
  ]);
}

export async function fitAudioToSlot(
  inWavPath: string,
  outWavPath: string,
  maxSlotSec: number
): Promise<number> {
  const probe = await probeMedia(inWavPath);
  if (probe.duration <= maxSlotSec || maxSlotSec <= 0.5) {
    await fs.copyFile(inWavPath, outWavPath);
    return probe.duration;
  }
  const neededTempo = Math.min(1.45, Math.max(1.0, probe.duration / maxSlotSec));
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    inWavPath,
    '-af',
    `atempo=${neededTempo.toFixed(3)}`,
    '-ar',
    '24000',
    '-ac',
    '1',
    outWavPath,
  ]);
  const updated = await probeMedia(outWavPath);
  return updated.duration;
}

export async function buildContinuousAudioTrack(
  clips: Array<{ wavPath: string; startMs: number }>,
  totalDurationSec: number,
  outWavPath: string
): Promise<void> {
  if (clips.length === 0) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=mono:sample_rate=24000',
      '-t',
      Math.max(1, totalDurationSec).toFixed(2),
      outWavPath,
    ]);
    return;
  }

  const args: string[] = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `anullsrc=channel_layout=mono:sample_rate=24000:d=${Math.max(1, totalDurationSec).toFixed(2)}`,
  ];

  const filterParts: string[] = [];
  const mixInputs: string[] = ['[0:a]'];

  clips.forEach((clip, idx) => {
    args.push('-i', clip.wavPath);
    const delayMs = Math.max(0, Math.round(clip.startMs));
    filterParts.push(`[${idx + 1}:a]adelay=${delayMs}|${delayMs},volume=1.0[d${idx}]`);
    mixInputs.push(`[d${idx}]`);
  });

  const filterComplex = [
    ...filterParts,
    `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:normalize=0[aout]`,
  ].join(';');

  args.push('-filter_complex', filterComplex, '-map', '[aout]', '-ar', '24000', '-ac', '1', outWavPath);

  await execFileAsync('ffmpeg', args);
}

function formatAssTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function formatSrtTimestamp(sec: number): string {
  const safe = Math.max(0, sec);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  const ms = Math.floor((safe % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

export async function writeSrtFile(
  segments: SubtitleSegment[],
  outSrtPath: string
): Promise<void> {
  const shortSegments = splitSubtitleSegmentsShort(segments, 34);
  const lines = shortSegments
    .map(
      (seg, i) =>
        `${i + 1}\n${formatSrtTimestamp(seg.startSec)} --> ${formatSrtTimestamp(seg.endSec)}\n${seg.myanmarText.trim()}\n`
    )
    .join('\n');
  await fs.writeFile(outSrtPath, lines, 'utf8');
}

function hexToAssColor(hex: string, opacityPercent = 100): string {
  const cleaned = hex.replace('#', '').trim();
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned.padEnd(6, '0').slice(0, 6);
  const r = full.slice(0, 2).toUpperCase();
  const g = full.slice(2, 4).toUpperCase();
  const b = full.slice(4, 6).toUpperCase();
  // In ASS alpha, 00 is opaque and FF is transparent
  const alphaByte = Math.round(
    (1 - Math.max(0, Math.min(100, opacityPercent)) / 100) * 255
  );
  const aa = alphaByte.toString(16).toUpperCase().padStart(2, '0');
  return `&H${aa}${b}${g}${r}`;
}

export async function writeAssFile(options: {
  outAssPath: string;
  playResX: number;
  playResY: number;
  segments: SubtitleSegment[];
  totalDurationSec: number;
  captionsEnabled: boolean;
  captionSize: number;
  captionStyle: CaptionStyleOption;
  captionWeight: CaptionWeightOption;
  captionColor: string;
  captionBgColor: string;
  captionBgOpacity: number;
  fontName: string;
  showTitleOverlay: boolean;
  videoTitle: string;
  watermarkEnabled: boolean;
  watermarkText: string;
}): Promise<void> {
  const {
    outAssPath,
    playResX,
    playResY,
    segments,
    totalDurationSec,
    captionsEnabled,
    captionSize,
    captionWeight,
    captionColor,
    captionBgColor,
    captionBgOpacity,
    fontName,
    showTitleOverlay,
    videoTitle,
    watermarkEnabled,
    watermarkText,
  } = options;

  // Map requested font name to guaranteed installed Myanmar font for libass
  const resolvedFont =
    fontName === 'Noto Serif Myanmar' ? 'Noto Serif Myanmar' : 'Noto Sans Myanmar';

  const primaryColour = hexToAssColor(captionColor || '#FFD400', 100);
  const hasBgBox = captionBgOpacity > 0;
  const bgAssColor = hexToAssColor(captionBgColor || '#0F172A', captionBgOpacity);

  // In libass, BorderStyle=3 uses OutlineColour as the opaque/translucent box color
  const outlineColour = hasBgBox ? bgAssColor : '&H00000000';
  const backColour = hasBgBox ? bgAssColor : '&H80000000';
  const borderStyle = hasBgBox ? 3 : 1;
  const outlineWidth = hasBgBox ? 8 : 3;
  const shadowWidth = hasBgBox ? 0 : 1.5;

  const isBold = captionWeight === 'bold' ? -1 : 0;
  const isItalic = captionWeight === 'italic' ? -1 : 0;

  const baseShortSide = Math.min(playResX, playResY);
  const scaledFontSize = Math.round((captionSize / 18) * (baseShortSide * 0.042));
  const titleFontSize = Math.max(22, Math.round(baseShortSide * 0.036));
  const watermarkFontSize = Math.max(16, Math.round(baseShortSide * 0.025));
  const marginV = Math.round(playResY * 0.075);

  const header = `[Script Info]
Title: DeepRecap Myanmar Studio
ScriptType: v4.00+
PlayResX: ${playResX}
PlayResY: ${playResY}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: MyanmarSub,${resolvedFont},${scaledFontSize},${primaryColour},&H000000FF,${outlineColour},${backColour},${isBold},${isItalic},0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadowWidth},2,56,56,${marginV},1
Style: VideoTitle,${resolvedFont},${titleFontSize},&H00FFFFFF,&H000000FF,&H000F172A,&HB00F172A,-1,0,0,0,100,100,0,0,3,8,0,8,32,32,24,1
Style: Watermark,${resolvedFont},${watermarkFontSize},&H66FFFFFF,&H000000FF,&H80000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,9,24,24,24,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const events: string[] = [];

  if (showTitleOverlay && videoTitle.trim()) {
    events.push(
      `Dialogue: 1,0:00:00.00,${formatAssTimestamp(totalDurationSec)},VideoTitle,,0,0,0,,${escapeAssText(videoTitle.trim())}`
    );
  }

  if (watermarkEnabled && watermarkText.trim()) {
    events.push(
      `Dialogue: 1,0:00:00.00,${formatAssTimestamp(totalDurationSec)},Watermark,,0,0,0,,${escapeAssText(watermarkText.trim())}`
    );
  }

  if (captionsEnabled) {
    const shortSegments = splitSubtitleSegmentsShort(segments, 34);
    for (const seg of shortSegments) {
      if (!seg.myanmarText.trim()) continue;
      events.push(
        `Dialogue: 2,${formatAssTimestamp(seg.startSec)},${formatAssTimestamp(seg.endSec)},MyanmarSub,,0,0,0,,${escapeAssText(seg.myanmarText.trim())}`
      );
    }
  }

  await fs.writeFile(outAssPath, header + events.join('\n') + '\n', 'utf8');
}

export function resolveTargetDimensions(
  aspectRatio: AspectRatioOption,
  srcWidth: number,
  srcHeight: number
): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16':
      return { width: 1080, height: 1920 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '4:5':
      return { width: 1080, height: 1350 };
    case '16:9':
      return { width: 1920, height: 1080 };
    case 'original':
    default: {
      // Scale neatly to 1080p Full HD with even pixel dimensions
      const safeW = Math.max(2, srcWidth || 1920);
      const safeH = Math.max(2, srcHeight || 1080);
      const scale = Math.min(
        1920 / Math.max(safeW, safeH),
        1080 / Math.min(safeW, safeH)
      );
      const w = Math.max(320, Math.round((safeW * scale) / 2) * 2);
      const h = Math.max(320, Math.round((safeH * scale) / 2) * 2);
      return { width: w, height: h };
    }
  }
}

export async function buildRecapVisualTrack(options: {
  sourceVideoPath: string;
  sourceDuration: number;
  segments: SubtitleSegment[];
  targetWidth: number;
  targetHeight: number;
  fitMode: VideoFitMode;
  mirrorFlip?: boolean;
  workDir: string;
  outVisualMp4Path: string;
}): Promise<void> {
  const {
    sourceVideoPath,
    sourceDuration,
    segments,
    targetWidth,
    targetHeight,
    fitMode,
    mirrorFlip,
    workDir,
    outVisualMp4Path,
  } = options;

  const flipPrefix = mirrorFlip ? 'hflip,' : '';
  const scaleFilter =
    fitMode === 'cover'
      ? `${flipPrefix}scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},setsar=1,fps=30`
      : `${flipPrefix}scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=#0b1120,setsar=1,fps=30`;

  const clipPaths: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const targetClipDuration = Math.max(0.8, seg.endSec - seg.startSec);
    const safeSrcStart = Math.max(0, Math.min(sourceDuration - 1.5, seg.sourceStartSec));
    const availableSrcLen = Math.max(
      1.0,
      Math.min(sourceDuration - safeSrcStart, seg.sourceEndSec - seg.sourceStartSec || 6)
    );

    const clipPath = path.join(workDir, `recap_clip_${i}.mp4`);

    // If target duration > available clip length, slow down or loop cleanly via stream_loop
    const loopCount = Math.ceil(targetClipDuration / availableSrcLen);
    if (loopCount > 1) {
      const subClipRaw = path.join(workDir, `recap_sub_${i}.mp4`);
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        safeSrcStart.toFixed(2),
        '-t',
        availableSrcLen.toFixed(2),
        '-i',
        sourceVideoPath,
        '-an',
        '-vf',
        scaleFilter,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        subClipRaw,
      ]);

      await execFileAsync('ffmpeg', [
        '-y',
        '-stream_loop',
        String(loopCount - 1),
        '-i',
        subClipRaw,
        '-t',
        targetClipDuration.toFixed(3),
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        clipPath,
      ]);
    } else {
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        safeSrcStart.toFixed(2),
        '-t',
        targetClipDuration.toFixed(3),
        '-i',
        sourceVideoPath,
        '-an',
        '-vf',
        scaleFilter,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        clipPath,
      ]);
    }

    clipPaths.push(clipPath);
  }

  const concatListPath = path.join(workDir, 'concat_list.txt');
  const listContent = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(concatListPath, listContent, 'utf8');

  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    outVisualMp4Path,
  ]);
}

export async function renderFinalVideo(options: {
  visualVideoPath: string;
  originalAudioSourcePath?: string;
  dubAudioWavPath?: string;
  originalAudioMix: number;
  targetWidth: number;
  targetHeight: number;
  fitMode: VideoFitMode;
  applyScaleInRender: boolean;
  mirrorFlip?: boolean;
  blurBoxes: BlurBox[];
  fullBandCover: boolean;
  blurStrength: number;
  assPath: string;
  logoPath?: string;
  outMp4Path: string;
}): Promise<void> {
  const {
    visualVideoPath,
    originalAudioSourcePath,
    dubAudioWavPath,
    originalAudioMix,
    targetWidth,
    targetHeight,
    fitMode,
    applyScaleInRender,
    mirrorFlip,
    blurBoxes,
    fullBandCover,
    blurStrength,
    assPath,
    logoPath,
    outMp4Path,
  } = options;

  const args: string[] = ['-y', '-i', visualVideoPath];
  let dubInputIdx = -1;
  let origAudioIdx = -1;
  let logoInputIdx = -1;
  let nextIdx = 1;

  if (dubAudioWavPath) {
    args.push('-i', dubAudioWavPath);
    dubInputIdx = nextIdx++;
  }
  if (originalAudioSourcePath && originalAudioMix > 0.01) {
    const origProbe = await probeMedia(originalAudioSourcePath);
    if (origProbe.hasAudio) {
      args.push('-i', originalAudioSourcePath);
      origAudioIdx = nextIdx++;
    }
  }
  if (logoPath) {
    args.push('-i', logoPath);
    logoInputIdx = nextIdx++;
  }

  const vFilters: string[] = [];
  let currentV = '[0:v]';

  if (applyScaleInRender) {
    const flipPrefix = mirrorFlip ? 'hflip,' : '';
    const scaleExpr =
      fitMode === 'cover'
        ? `${flipPrefix}scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight},setsar=1,fps=30`
        : `${flipPrefix}scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=#0b1120,setsar=1,fps=30`;
    vFilters.push(`${currentV}${scaleExpr}[vscaled]`);
    currentV = '[vscaled]';
  }

  // Combine explicit blur boxes + optional full band cover
  const allBoxes: Array<{ x: number; y: number; w: number; h: number }> = [
    ...blurBoxes.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
  ];
  if (fullBandCover) {
    allBoxes.push({ x: 0.04, y: 0.78, w: 0.92, h: 0.14 });
  }

  allBoxes.forEach((box, idx) => {
    const bx = Math.max(0, Math.min(targetWidth - 16, Math.round(box.x * targetWidth)));
    const by = Math.max(0, Math.min(targetHeight - 16, Math.round(box.y * targetHeight)));
    const bw = Math.max(16, Math.min(targetWidth - bx, Math.round(box.w * targetWidth)));
    const bh = Math.max(16, Math.min(targetHeight - by, Math.round(box.h * targetHeight)));
    const baseTag = `[vbase_${idx}]`;
    const cropTag = `[vcrop_${idx}]`;
    const blurTag = `[vblur_${idx}]`;
    const outTag = `[vblurout_${idx}]`;
    const desiredRadius = Math.max(4, Math.min(28, Math.round(blurStrength || 16)));
    const blurRadius = Math.max(2, Math.min(desiredRadius, Math.floor(Math.min(bw, bh) / 3)));
    vFilters.push(`${currentV}split=2${baseTag}${cropTag}`);
    vFilters.push(`${cropTag}crop=${bw}:${bh}:${bx}:${by},boxblur=${blurRadius}:2${blurTag}`);
    vFilters.push(`${baseTag}${blurTag}overlay=${bx}:${by}${outTag}`);
    currentV = outTag;
  });

  if (logoInputIdx !== -1) {
    const logoSize = Math.max(48, Math.round(Math.min(targetWidth, targetHeight) * 0.1));
    vFilters.push(`[${logoInputIdx}:v]scale=${logoSize}:${logoSize}[vlogo]`);
    vFilters.push(`${currentV}[vlogo]overlay=W-w-24:24[vlogod]`);
    currentV = '[vlogod]';
  }

  const escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  vFilters.push(`${currentV}ass='${escapedAss}'[vfinal]`);

  // Audio mix
  const aFilters: string[] = [];
  let audioMap = '';

  if (dubInputIdx !== -1 && origAudioIdx !== -1) {
    aFilters.push(
      `[${dubInputIdx}:a]volume=1.0[adub];[${origAudioIdx}:a]volume=${originalAudioMix.toFixed(2)}[aorig];[adub][aorig]amix=inputs=2:duration=first:normalize=0[afinal]`
    );
    audioMap = '[afinal]';
  } else if (dubInputIdx !== -1) {
    audioMap = `${dubInputIdx}:a`;
  } else if (origAudioIdx !== -1) {
    audioMap = `${origAudioIdx}:a`;
  }

  const fullFilter = [...vFilters, ...aFilters].join(';');
  args.push('-filter_complex', fullFilter, '-map', '[vfinal]');
  if (audioMap) {
    args.push('-map', audioMap, '-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v',
    'libx264',
    '-r',
    '30',
    '-preset',
    'veryfast',
    '-crf',
    '22',
    '-pix_fmt',
    'yuv420p',
    '-shortest',
    '-movflags',
    '+faststart',
    outMp4Path
  );

  await execFileAsync('ffmpeg', args);
}

export async function splitBatchedWavIntoClips(params: {
  batchedWavPath: string;
  segmentTexts: string[];
  outWavPaths: string[];
}): Promise<void> {
  const { batchedWavPath, segmentTexts, outWavPaths } = params;
  const count = outWavPaths.length;
  if (count === 0) return;

  if (count === 1) {
    await fs.copyFile(batchedWavPath, outWavPaths[0]);
    return;
  }

  const info = await probeMedia(batchedWavPath);
  const totalDur = Math.max(1.5, info.duration);

  // Detect natural sentence pauses inserted between batched lines
  const silenceMids: number[] = [];
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-i',
      batchedWavPath,
      '-af',
      'silencedetect=noise=-32dB:d=0.32',
      '-f',
      'null',
      '-',
    ]);
    let pendingStart: number | null = null;
    for (const line of stderr.split('\n')) {
      const startMatch = /silence_start:\s*([0-9.]+)/.exec(line);
      if (startMatch) {
        pendingStart = Number(startMatch[1]);
      }
      const endMatch = /silence_end:\s*([0-9.]+)/.exec(line);
      if (endMatch && pendingStart !== null) {
        const sEnd = Number(endMatch[1]);
        const mid = (pendingStart + sEnd) / 2;
        if (mid > 0.35 && mid < totalDur - 0.35) {
          silenceMids.push(mid);
        }
        pendingStart = null;
      }
    }
  } catch {
    // fallback cleanly to proportional timing
  }

  const weights = segmentTexts.map((t) => Math.max(8, t.trim().length));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const cutPoints: number[] = [0];
  let cumWeight = 0;
  for (let i = 0; i < count - 1; i++) {
    cumWeight += weights[i];
    const target = (cumWeight / totalWeight) * totalDur;
    const minAllowed = cutPoints[cutPoints.length - 1] + 0.45;
    const maxAllowed = totalDur - (count - 1 - i) * 0.45;

    let bestMid: number | null = null;
    let bestDist = 2.6;
    for (const mid of silenceMids) {
      if (mid >= minAllowed && mid <= maxAllowed) {
        const dist = Math.abs(mid - target);
        if (dist < bestDist) {
          bestDist = dist;
          bestMid = mid;
        }
      }
    }

    const chosen =
      bestMid !== null
        ? bestMid
        : Math.max(minAllowed, Math.min(maxAllowed, target));
    cutPoints.push(chosen);
  }
  cutPoints.push(totalDur);

  for (let i = 0; i < count; i++) {
    const startSec = cutPoints[i];
    const endSec = Math.max(startSec + 0.35, cutPoints[i + 1]);
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      startSec.toFixed(3),
      '-to',
      endSec.toFixed(3),
      '-i',
      batchedWavPath,
      '-ar',
      '24000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      outWavPaths[i],
    ]);
  }
}

