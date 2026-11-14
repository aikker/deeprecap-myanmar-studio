import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import {
  isAssemblyAiConfigured,
  isGroqConfigured,
  synthesizeSpeechWithGroqOrpheus,
  transcribeWithAssemblyAI,
  transcribeWithGroqWhisper,
  type TranscriptCue,
} from './server/externalAiService.ts';
import {
  generateVideoScript,
  getGeminiKeyPool,
  synthesizeMyanmarSpeech,
} from './server/geminiService.ts';
import {
  adjustAudioSpeedPitch,
  buildContinuousAudioTrack,
  buildRecapVisualTrack,
  createDemoSampleVideo,
  downloadYouTubeToFile,
  ensureMediaDirs,
  extractAudioTrack,
  extractSampleKeyframes,
  extractYouTubeId,
  fetchYouTubeOEmbed,
  fitAudioToSlot,
  OUTPUTS_DIR,
  probeMedia,
  renderFinalVideo,
  resolveTargetDimensions,
  splitBatchedWavIntoClips,
  transcodeToBrowserMp4IfNeeded,
  UPLOADS_DIR,
  WORK_DIR,
  writeAssFile,
  writeSrtFile,
} from './server/mediaProcessor.ts';
import type {
  GitHubUser,
  ProcessJobStatus,
  StudioConfig,
  SubtitleSegment,
  TelegramAccount,
  VideoAsset,
} from './src/types/studio.ts';
import { requireFirebaseUser } from './server/firebaseAuth.ts';
import {
  cleanupExpiredHistory,
  deleteHistoryItem,
  getHistoryItemById,
  getHistorySnapshot,
  getLastSavedConfig,
  initStudioStorage,
  patchHistoryItem,
  RETENTION_MS,
  saveLastConfig,
  saveRegisteredAsset,
  upsertHistoryItem,
} from './server/studioStorage.ts';
import {
  connectTelegramWithCredentials,
  detectChatIdFromBotToken,
  disconnectTelegramAccount,
  getTelegramStatus,
  pollTelegramConnect,
  sendRenderedVideoToTelegram,
  startTelegramConnect,
  syncTelegramCredentials,
} from './server/telegramService.ts';
import { splitSubtitleSegmentsShort } from './src/utils/subtitles.ts';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

const videoRegistry = new Map<
  string,
  VideoAsset & { filePath: string }
>();
const jobRegistry = new Map<string, ProcessJobStatus>();

interface GitHubSessionData {
  accessToken: string;
  scopes: string[];
  user: GitHubUser;
}

const githubSessions = new Map<string, GitHubSessionData>();
const githubOAuthStates = new Map<string, { redirectUri: string; createdAt: number }>();
const githubDeviceSessions = new Map<
  string,
  { deviceCode: string; expiresAt: number }
>();
const SESSION_SECRET =
  process.env.GITHUB_CLIENT_SECRET?.trim() || crypto.randomBytes(32).toString('hex');

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function signSessionId(sid: string): string {
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(sid)
    .digest('hex');
  return `${sid}.${sig}`;
}

function verifySignedSessionId(cookieVal: string | undefined): string | null {
  if (!cookieVal) return null;
  const dotIdx = cookieVal.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const sid = cookieVal.slice(0, dotIdx);
  const expected = signSessionId(sid);
  if (cookieVal.length !== expected.length) return null;
  const ok = crypto.timingSafeEqual(
    Buffer.from(cookieVal),
    Buffer.from(expected)
  );
  return ok ? sid : null;
}

function getSessionFromRequest(
  req: express.Request
): { sid: string; data: GitHubSessionData } | null {
  const cookies = parseCookies(req.headers.cookie);
  const headerToken =
    typeof req.headers['x-github-session'] === 'string'
      ? req.headers['x-github-session']
      : undefined;
  const sid =
    verifySignedSessionId(cookies.dr_gh_session) ||
    verifySignedSessionId(headerToken);
  if (!sid) return null;
  const data = githubSessions.get(sid);
  return data ? { sid, data } : null;
}

function resolveOAuthOrigin(clientOrigin?: string, reqHost?: string): string {
  const envUrl = (process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (clientOrigin) {
    try {
      const parsed = new URL(clientOrigin);
      const host = parsed.hostname.toLowerCase();
      if (
        (parsed.protocol === 'https:' &&
          (host.endsWith('.run.app') ||
            host.endsWith('.onrender.com') ||
            host.endsWith('.up.railway.app') ||
            host.endsWith('.koyeb.app') ||
            host.endsWith('.fly.dev') ||
            host.endsWith('.vercel.app') ||
            (reqHost && parsed.host.toLowerCase() === reqHost.toLowerCase()))) ||
        host === 'localhost' ||
        host === '127.0.0.1'
      ) {
        return parsed.origin;
      }
    } catch {
      // ignore invalid origin
    }
  }
  return envUrl || (reqHost ? `https://${reqHost}` : 'http://localhost:3000');
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIdx = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIdx < items.length) {
        const idx = nextIdx++;
        await worker(items[idx], idx);
      }
    }
  );
  await Promise.all(runners);
}

async function runStudioJob(params: {
  jobId: string;
  userId: string;
  asset: VideoAsset & { filePath: string };
  config: StudioConfig;
  editedSegments?: SubtitleSegment[];
  telegramOverride?: { botToken?: string; chatId?: string } | null;
}): Promise<void> {
  const { jobId, userId, asset, config, editedSegments, telegramOverride } =
    params;
  const jobWorkDir = path.join(WORK_DIR, jobId);
  await fs.mkdir(jobWorkDir, { recursive: true });

  const updateJob = (patch: Partial<ProcessJobStatus>) => {
    const prev = jobRegistry.get(jobId);
    if (!prev) return;
    jobRegistry.set(jobId, { ...prev, ...patch });
    void patchHistoryItem(jobId, patch);
  };

  try {
    let segments: SubtitleSegment[] = [];
    let finalTitle = config.videoTitle.trim() || asset.title;
    let socialCaption = config.aiSocialCaption;

    if (editedSegments && editedSegments.length > 0) {
      segments = editedSegments;
      updateJob({
        status: 'voicing',
        progress: 45,
        stepLabel: 'Updating voiceover & subtitles...',
      });
    } else {
      updateJob({
        status: 'analyzing',
        progress: 12,
        stepLabel: 'Analyzing video frames and audio track...',
      });

      const audioMp3Path = path.join(jobWorkDir, 'source_audio.mp3');
      const hasExtractedAudio = await extractAudioTrack(
        asset.filePath,
        audioMp3Path
      );
      const keyframes = await extractSampleKeyframes(
        asset.filePath,
        asset.duration,
        jobWorkDir,
        6
      );

      let transcriptCues: TranscriptCue[] = [];
      const pref = config.transcriptionProvider || 'auto';

      if (hasExtractedAudio) {
        const useAssembly =
          pref === 'assemblyai' ||
          (pref === 'auto' && isAssemblyAiConfigured());
        const useGroq =
          pref === 'groq' ||
          (pref === 'auto' && !useAssembly && isGroqConfigured());

        if (useAssembly && isAssemblyAiConfigured()) {
          try {
            updateJob({
              status: 'analyzing',
              progress: 22,
              stepLabel: 'Transcribing speech with AssemblyAI...',
            });
            transcriptCues = await transcribeWithAssemblyAI(audioMp3Path);
          } catch (err) {
            console.warn('AssemblyAI fallback to Gemini:', err);
          }
        } else if (useGroq && isGroqConfigured()) {
          try {
            updateJob({
              status: 'analyzing',
              progress: 22,
              stepLabel: 'Transcribing speech with Groq Whisper...',
            });
            transcriptCues = await transcribeWithGroqWhisper(audioMp3Path);
          } catch (err) {
            console.warn('Groq Whisper fallback to Gemini:', err);
          }
        }
      }

      updateJob({
        status: 'translating',
        progress: 32,
        stepLabel:
          config.mode === 'recap'
            ? `Generating ${config.recapDurationMin}-minute Burmese recap script...`
            : 'Translating dialogue into natural Myanmar script...',
      });

      const generated = await generateVideoScript({
        mode: config.mode,
        recapDurationMin: config.recapDurationMin,
        outputLanguage: config.outputLanguage,
        videoTitle: finalTitle,
        videoDuration: asset.duration,
        audioMp3Path: hasExtractedAudio ? audioMp3Path : undefined,
        keyframePaths: keyframes,
        youtubeUrl:
          asset.sourceType === 'youtube' && !asset.hasDownloadableStream
            ? asset.youtubeUrl
            : undefined,
        transcriptCues,
        addFyp: config.addFyp,
      });

      segments = generated.segments;
      if (!config.videoTitle.trim() || config.videoTitle === asset.title) {
        finalTitle = generated.suggestedTitle;
      }
      if (!socialCaption.trim() || config.aiCaptionEnabled) {
        socialCaption = generated.socialCaption;
      }
    }

    const { width: targetWidth, height: targetHeight } = resolveTargetDimensions(
      config.aspectRatio,
      asset.width,
      asset.height
    );

    let dubWavPath: string | undefined;
    let finalDurationSec = asset.duration;
    let visualSourcePath = asset.filePath;
    let applyScaleInRender = true;

    if (config.mode !== 'subtitle') {
      const useGroqTts =
        config.ttsProvider === 'groq' &&
        config.outputLanguage === 'en' &&
        isGroqConfigured();
      const voiceDisplay = useGroqTts
        ? config.voiceId === 'nilar'
          ? 'Groq Hannah'
          : 'Groq Troy'
        : config.voiceId === 'nilar'
          ? 'Nilar'
          : 'Thiha';
      updateJob({
        status: 'voicing',
        progress: 54,
        stepLabel: useGroqTts
          ? `Synthesizing English speech with ${voiceDisplay} (Groq Orpheus)...`
          : `Synthesizing speech with ${voiceDisplay} voice model...`,
      });

      const voicedClips: Array<{
        index: number;
        wavPath: string;
        durationSec: number;
      }> = new Array(segments.length);

      let completedCount = 0;

      if (useGroqTts) {
        await runPool(segments, 3, async (seg, idx) => {
          const rawWav = path.join(jobWorkDir, `tts_raw_${idx}.wav`);
          const shapedWav = path.join(jobWorkDir, `tts_shaped_${idx}.wav`);

          try {
            await synthesizeSpeechWithGroqOrpheus({
              text: seg.myanmarText,
              voiceId: config.voiceId,
              outWavPath: rawWav,
            });
          } catch (groqErr) {
            console.warn('Groq TTS fallback to Gemini TTS:', groqErr);
            await synthesizeMyanmarSpeech({
              text: seg.myanmarText,
              voiceId: config.voiceId,
              emotionStyle: seg.emotionStyle,
              outWavPath: rawWav,
            });
          }

          await adjustAudioSpeedPitch(
            rawWav,
            shapedWav,
            config.speedPercent,
            config.pitchHz
          );

          let finalClipPath = shapedWav;
          if (config.mode === 'dub') {
            const slotLen = Math.max(1.2, seg.endSec - seg.startSec);
            const fittedWav = path.join(jobWorkDir, `tts_fitted_${idx}.wav`);
            const dur = await fitAudioToSlot(shapedWav, fittedWav, slotLen);
            finalClipPath = fittedWav;
            voicedClips[idx] = {
              index: idx,
              wavPath: finalClipPath,
              durationSec: dur,
            };
          } else {
            const info = await probeMedia(finalClipPath);
            voicedClips[idx] = {
              index: idx,
              wavPath: finalClipPath,
              durationSec: info.duration,
            };
          }

          completedCount++;
          const voiceProgress =
            54 + Math.round((completedCount / segments.length) * 24);
          updateJob({
            progress: voiceProgress,
            stepLabel: `Voicing segment ${completedCount} of ${segments.length} (${voiceDisplay})...`,
          });
        });
      } else {
        // Batch up to 6 segments per Gemini TTS API call to stay well within Free Tier limits
        const TTS_BATCH_SIZE = 6;
        const batches: Array<{ startIdx: number; items: SubtitleSegment[] }> =
          [];
        for (let i = 0; i < segments.length; i += TTS_BATCH_SIZE) {
          batches.push({
            startIdx: i,
            items: segments.slice(i, i + TTS_BATCH_SIZE),
          });
        }

        for (let bIdx = 0; bIdx < batches.length; bIdx++) {
          const batch = batches[bIdx];
          const batchWav = path.join(jobWorkDir, `tts_batch_${bIdx}.wav`);
          const combinedText = batch.items
            .map((s) => s.myanmarText.trim())
            .join('\n\n...\n\n');
          const primaryStyle =
            batch.items.find((s) => s.emotionStyle)?.emotionStyle ||
            'Clear engaging Burmese narrator';

          await synthesizeMyanmarSpeech({
            text: combinedText,
            voiceId: config.voiceId,
            emotionStyle: primaryStyle,
            outWavPath: batchWav,
          });

          const rawClipPaths = batch.items.map((_, localIdx) =>
            path.join(jobWorkDir, `tts_raw_${batch.startIdx + localIdx}.wav`)
          );
          await splitBatchedWavIntoClips({
            batchedWavPath: batchWav,
            segmentTexts: batch.items.map((s) => s.myanmarText),
            outWavPaths: rawClipPaths,
          });

          for (let localIdx = 0; localIdx < batch.items.length; localIdx++) {
            const idx = batch.startIdx + localIdx;
            const seg = batch.items[localIdx];
            const rawWav = rawClipPaths[localIdx];
            const shapedWav = path.join(jobWorkDir, `tts_shaped_${idx}.wav`);

            await adjustAudioSpeedPitch(
              rawWav,
              shapedWav,
              config.speedPercent,
              config.pitchHz
            );

            let finalClipPath = shapedWav;
            if (config.mode === 'dub') {
              const slotLen = Math.max(1.2, seg.endSec - seg.startSec);
              const fittedWav = path.join(jobWorkDir, `tts_fitted_${idx}.wav`);
              const dur = await fitAudioToSlot(shapedWav, fittedWav, slotLen);
              finalClipPath = fittedWav;
              voicedClips[idx] = {
                index: idx,
                wavPath: finalClipPath,
                durationSec: dur,
              };
            } else {
              const info = await probeMedia(finalClipPath);
              voicedClips[idx] = {
                index: idx,
                wavPath: finalClipPath,
                durationSec: info.duration,
              };
            }

            completedCount++;
            const voiceProgress =
              54 + Math.round((completedCount / segments.length) * 24);
            updateJob({
              progress: voiceProgress,
              stepLabel: `Voicing segment ${completedCount} of ${segments.length} (${voiceDisplay})...`,
            });
          }
        }
      }

      if (config.mode === 'recap') {
        // Align recap timestamps sequentially to actual spoken voiceover duration + 0.35s breath pause
        let cursor = 0.25;
        const timedClips: Array<{ wavPath: string; startMs: number }> = [];
        const alignedSegments: SubtitleSegment[] = [];

        for (let i = 0; i < segments.length; i++) {
          const clip = voicedClips[i];
          const seg = segments[i];
          const segStart = cursor;
          const segEnd = cursor + clip.durationSec;
          timedClips.push({
            wavPath: clip.wavPath,
            startMs: Math.round(segStart * 1000),
          });
          alignedSegments.push({
            ...seg,
            startSec: Number(segStart.toFixed(2)),
            endSec: Number(segEnd.toFixed(2)),
          });
          cursor = segEnd + 0.35;
        }

        segments = alignedSegments;
        finalDurationSec = Math.max(cursor + 0.4, 3);

        dubWavPath = path.join(OUTPUTS_DIR, `${jobId}_voice.wav`);
        await buildContinuousAudioTrack(timedClips, finalDurationSec, dubWavPath);

        updateJob({
          status: 'rendering',
          progress: 82,
          stepLabel: 'Assembling 3-5 minute recap highlight clips...',
        });

        const recapVisualPath = path.join(jobWorkDir, 'recap_visual.mp4');
        await buildRecapVisualTrack({
          sourceVideoPath: asset.filePath,
          sourceDuration: asset.duration,
          totalDurationSec: finalDurationSec,
          segments,
          targetWidth,
          targetHeight,
          fitMode: config.fitMode,
          mirrorFlip: Boolean(config.mirrorFlip),
          workDir: jobWorkDir,
          outVisualMp4Path: recapVisualPath,
        });
        visualSourcePath = recapVisualPath;
        applyScaleInRender = false;
      } else {
        // Dub mode: keep original video duration and place each dubbed line at its timestamp
        const timedClips: Array<{ wavPath: string; startMs: number }> = [];
        let lastEnd = 0;
        const adjustedSegments: SubtitleSegment[] = [];

        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          const clip = voicedClips[i];
          const start = Math.max(lastEnd + 0.05, seg.startSec);
          const end = Math.min(asset.duration, start + clip.durationSec);
          if (start >= asset.duration - 0.3) break;
          timedClips.push({
            wavPath: clip.wavPath,
            startMs: Math.round(start * 1000),
          });
          adjustedSegments.push({
            ...seg,
            startSec: Number(start.toFixed(2)),
            endSec: Number(Math.max(start + 0.8, end).toFixed(2)),
          });
          lastEnd = end;
        }

        segments = adjustedSegments;
        finalDurationSec = asset.duration;
        dubWavPath = path.join(OUTPUTS_DIR, `${jobId}_voice.wav`);
        await buildContinuousAudioTrack(timedClips, finalDurationSec, dubWavPath);
      }
    }

    updateJob({
      status: 'rendering',
      progress: 90,
      stepLabel: 'Burning Myanmar subtitles, blur boxes, and rendering MP4...',
    });

    const assPath = path.join(jobWorkDir, 'subtitles.ass');
    const srtFilename = `${jobId}_subtitles.srt`;
    const srtPath = path.join(OUTPUTS_DIR, srtFilename);
    const outMp4Filename = `${jobId}_final.mp4`;
    const outMp4Path = path.join(OUTPUTS_DIR, outMp4Filename);

    await writeSrtFile(segments, srtPath);
    await writeAssFile({
      outAssPath: assPath,
      playResX: targetWidth,
      playResY: targetHeight,
      segments,
      totalDurationSec: finalDurationSec,
      captionsEnabled: config.captionsEnabled,
      captionSize: config.captionSize,
      captionStyle: config.captionStyle,
      captionWeight: config.captionWeight || 'bold',
      captionColor: config.captionColor || '#FFD400',
      captionBgColor: config.captionBgColor || '#0F172A',
      captionBgOpacity: Number(config.captionBgOpacity ?? 0),
      fontName: config.captionFont,
      showTitleOverlay: config.showTitleOverlay,
      videoTitle: finalTitle,
      watermarkEnabled: config.watermarkEnabled,
      watermarkText: config.watermarkText,
    });

    let logoPath: string | undefined;
    if (config.logoEnabled && config.logoDataUrl?.startsWith('data:image/')) {
      const base64Part = config.logoDataUrl.split(',')[1];
      if (base64Part) {
        logoPath = path.join(jobWorkDir, 'logo.png');
        await fs.writeFile(logoPath, Buffer.from(base64Part, 'base64'));
      }
    }

    await renderFinalVideo({
      visualVideoPath: visualSourcePath,
      originalAudioSourcePath:
        config.mode === 'subtitle' || config.originalAudioMix > 0.01
          ? asset.filePath
          : undefined,
      dubAudioWavPath: dubWavPath,
      originalAudioMix:
        config.mode === 'subtitle' ? 1.0 : config.originalAudioMix,
      targetWidth,
      targetHeight,
      fitMode: config.fitMode,
      applyScaleInRender,
      mirrorFlip: Boolean(config.mirrorFlip),
      blurBoxes: config.blurBoxes,
      fullBandCover: config.fullBandCover,
      blurStrength: Number(config.blurStrength ?? 16),
      assPath,
      logoPath,
      outMp4Path,
    });

    const outInfo = await probeMedia(outMp4Path);
    const completedAt = Date.now();
    const expiresAt = completedAt + RETENTION_MS;
    const tgStatus = await getTelegramStatus(userId);
    const hasOverrideTg = Boolean(
      telegramOverride?.botToken?.trim() && telegramOverride?.chatId?.trim()
    );
    const shouldSendTelegram = tgStatus.connected || hasOverrideTg;
    const outputVideoUrl = `/api/media/outputs/${outMp4Filename}`;

    const completedResult = {
      outputVideoUrl,
      outputAudioUrl: dubWavPath
        ? `/api/media/outputs/${path.basename(dubWavPath)}`
        : undefined,
      outputSrtUrl: `/api/media/outputs/${srtFilename}`,
      finalTitle,
      socialCaption,
      durationSec: outInfo.duration,
      segments,
    };

    const donePatch: Partial<ProcessJobStatus> = {
      status: 'completed',
      progress: 100,
      stepLabel: 'Completed and ready to download',
      completedAt,
      expiresAt,
      telegramStatus: shouldSendTelegram ? 'pending' : 'skipped',
      result: completedResult,
    };
    jobRegistry.set(jobId, { ...(jobRegistry.get(jobId) || { jobId }), ...donePatch } as ProcessJobStatus);
    await patchHistoryItem(jobId, {
      ...donePatch,
      title: finalTitle,
    });

    if (shouldSendTelegram) {
      const sent = await sendRenderedVideoToTelegram({
        userId,
        telegramOverride,
        mp4Path: outMp4Path,
        srtPath,
        title: finalTitle,
        socialCaption,
        publicVideoPath: outputVideoUrl,
      });
      const tgPatch: Partial<ProcessJobStatus> = {
        telegramStatus: sent.status,
        telegramError: sent.error,
      };
      jobRegistry.set(jobId, { ...(jobRegistry.get(jobId) || { jobId }), ...tgPatch } as ProcessJobStatus);
      await patchHistoryItem(jobId, tgPatch);
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unexpected processing error.';
    const failPatch: Partial<ProcessJobStatus> = {
      status: 'failed',
      progress: 0,
      stepLabel: 'Processing failed',
      error: message,
      expiresAt: Date.now() + RETENTION_MS,
    };
    jobRegistry.set(jobId, { ...(jobRegistry.get(jobId) || { jobId }), ...failPatch } as ProcessJobStatus);
    await patchHistoryItem(jobId, failPatch);
  }
}

async function startServer() {
  await ensureMediaDirs();
  const restored = await initStudioStorage();
  for (const asset of restored.assets) {
    videoRegistry.set(asset.videoId, asset);
  }
  for (const h of restored.history) {
    jobRegistry.set(h.jobId, {
      jobId: h.jobId,
      userId: h.userId,
      status: h.status,
      progress: h.progress,
      stepLabel: h.stepLabel,
      error: h.error,
      telegramStatus: h.telegramStatus,
      telegramError: h.telegramError,
      createdAt: h.createdAt,
      completedAt: h.completedAt,
      expiresAt: h.expiresAt,
      result: h.result,
    });
  }

  // Auto-delete expired videos (> 4 hours) every 2 minutes
  setInterval(() => {
    void cleanupExpiredHistory();
  }, 2 * 60 * 1000);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '15mb' }));

  const upload = multer({
    dest: UPLOADS_DIR,
    limits: { fileSize: 300 * 1024 * 1024 },
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/providers/status', (_req, res) => {
    res.json({
      geminiKeyCount: getGeminiKeyPool().length,
      groqConfigured: isGroqConfigured(),
      assemblyAiConfigured: isAssemblyAiConfigured(),
    });
  });

  // GitHub OAuth Routes (iframe-safe popup + Device Flow + SameSite=None; Secure cookies)
  app.get('/api/auth/github/status', (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID?.trim();
    const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
    const configured = Boolean(clientId && clientSecret);
    const active = getSessionFromRequest(req);
    const hasRepoScope = Boolean(
      active &&
        (active.data.scopes.includes('repo') ||
          active.data.scopes.includes('public_repo'))
    );

    res.json({
      configured,
      connected: Boolean(active),
      hasRepoScope,
      user: active?.data.user || null,
    });
  });

  app.get('/api/auth/github/url', (req, res) => {
    const clientId = process.env.GITHUB_CLIENT_ID?.trim();
    const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      res.status(400).json({
        error:
          'GitHub OAuth credentials (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET) are not set in Settings > Secrets.',
      });
      return;
    }

    const origin = resolveOAuthOrigin(
      typeof req.query.origin === 'string' ? req.query.origin : undefined,
      req.get('host')
    );
    const redirectUri = `${origin}/auth/github/callback`;
    const state = crypto.randomBytes(20).toString('hex');
    githubOAuthStates.set(state, { redirectUri, createdAt: Date.now() });

    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of githubOAuthStates.entries()) {
      if (v.createdAt < cutoff) githubOAuthStates.delete(k);
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'read:user gist repo',
      state,
    });

    res.json({
      url: `https://github.com/login/oauth/authorize?${params.toString()}`,
    });
  });

  app.post('/api/auth/github/device/start', async (_req, res) => {
    try {
      const clientId = process.env.GITHUB_CLIENT_ID?.trim();
      if (!clientId) {
        res.status(400).json({
          error: 'GITHUB_CLIENT_ID is not configured in Settings > Secrets.',
        });
        return;
      }

      const ghRes = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'DeepRecap-Myanmar-Studio',
        },
        body: JSON.stringify({
          client_id: clientId,
          scope: 'read:user gist repo',
        }),
      });

      const data = (await ghRes.json()) as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        expires_in?: number;
        interval?: number;
        error?: string;
        error_description?: string;
      };

      if (!ghRes.ok || !data.device_code || !data.user_code) {
        const rawErr =
          data.error_description ||
          data.error ||
          'Device Flow is not enabled on this GitHub OAuth App.';
        const errMsg = /device flow/i.test(rawErr)
          ? 'GitHub OAuth App settings (github.com/settings/developers) ထဲဝင်ပြီး "Enable Device Flow" checkbox ကို အမှန်ခြစ်၍ Update application နှိပ်ပေးပါ။'
          : rawErr;
        res.status(400).json({ error: errMsg });
        return;
      }

      const flowId = crypto.randomUUID();
      githubDeviceSessions.set(flowId, {
        deviceCode: data.device_code,
        expiresAt: Date.now() + (data.expires_in || 900) * 1000,
      });

      res.json({
        flowId,
        userCode: data.user_code,
        verificationUri: data.verification_uri || 'https://github.com/login/device',
        interval: data.interval || 5,
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Unable to start GitHub Device Flow.';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/auth/github/device/poll', async (req, res) => {
    try {
      const flowId = String(req.body?.flowId || '');
      const flow = githubDeviceSessions.get(flowId);
      if (!flow || flow.expiresAt < Date.now()) {
        githubDeviceSessions.delete(flowId);
        res.status(400).json({ error: 'Device code expired. Please generate a new code.' });
        return;
      }

      const clientId = process.env.GITHUB_CLIENT_ID?.trim() || '';
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'DeepRecap-Myanmar-Studio',
        },
        body: JSON.stringify({
          client_id: clientId,
          device_code: flow.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (
        tokenJson.error === 'authorization_pending' ||
        tokenJson.error === 'slow_down'
      ) {
        res.json({ status: 'pending', error: tokenJson.error });
        return;
      }

      if (!tokenJson.access_token) {
        githubDeviceSessions.delete(flowId);
        res.status(400).json({
          error:
            tokenJson.error_description ||
            tokenJson.error ||
            'GitHub authorization failed.',
        });
        return;
      }

      githubDeviceSessions.delete(flowId);

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenJson.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'DeepRecap-Myanmar-Studio',
        },
      });
      if (!userRes.ok) {
        throw new Error('Failed to fetch GitHub profile.');
      }
      const headerScopes = userRes.headers.get('x-oauth-scopes') || tokenJson.scope || '';
      const scopes = headerScopes
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const ghUser = (await userRes.json()) as {
        login: string;
        name: string | null;
        avatar_url: string;
        html_url: string;
      };

      const sid = crypto.randomUUID();
      const signedSid = signSessionId(sid);
      const userObj: GitHubUser = {
        login: ghUser.login,
        name: ghUser.name,
        avatarUrl: ghUser.avatar_url,
        htmlUrl: ghUser.html_url,
      };
      githubSessions.set(sid, {
        accessToken: tokenJson.access_token,
        scopes,
        user: userObj,
      });

      res.cookie('dr_gh_session', signedSid, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.json({
        status: 'connected',
        user: userObj,
        sessionToken: signedSid,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'GitHub polling failed.';
      res.status(500).json({ error: msg });
    }
  });

  const handleGitHubCallback = async (
    req: express.Request,
    res: express.Response
  ) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const errorParam =
      typeof req.query.error_description === 'string'
        ? req.query.error_description
        : typeof req.query.error === 'string'
          ? req.query.error
          : '';

    if (errorParam) {
      res.status(400).send(`
        <html><body style="font-family:sans-serif;padding:24px;">
          <p>GitHub authentication cancelled: ${errorParam.replace(/</g, '&lt;')}</p>
          <script>setTimeout(() => window.close(), 1800);</script>
        </body></html>
      `);
      return;
    }

    const savedState = githubOAuthStates.get(state);
    githubOAuthStates.delete(state);
    if (!code || !savedState) {
      res.status(400).send(`
        <html><body style="font-family:sans-serif;padding:24px;">
          <p>Invalid or expired GitHub OAuth session. Please close this window and try again.</p>
        </body></html>
      `);
      return;
    }

    try {
      const clientId = process.env.GITHUB_CLIENT_ID?.trim() || '';
      const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim() || '';

      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'DeepRecap-Myanmar-Studio',
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: savedState.redirectUri,
        }),
      });
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        scope?: string;
        error_description?: string;
      };
      if (!tokenJson.access_token) {
        throw new Error(
          tokenJson.error_description || 'Failed to exchange GitHub OAuth code.'
        );
      }

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenJson.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'DeepRecap-Myanmar-Studio',
        },
      });
      if (!userRes.ok) {
        throw new Error('Failed to fetch GitHub profile.');
      }
      const headerScopes = userRes.headers.get('x-oauth-scopes') || tokenJson.scope || '';
      const scopes = headerScopes
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const ghUser = (await userRes.json()) as {
        login: string;
        name: string | null;
        avatar_url: string;
        html_url: string;
      };

      const sid = crypto.randomUUID();
      const signedSid = signSessionId(sid);
      githubSessions.set(sid, {
        accessToken: tokenJson.access_token,
        scopes,
        user: {
          login: ghUser.login,
          name: ghUser.name,
          avatarUrl: ghUser.avatar_url,
          htmlUrl: ghUser.html_url,
        },
      });

      res.cookie('dr_gh_session', signedSid, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.send(`
        <html>
          <body style="font-family:sans-serif;padding:24px;text-align:center;">
            <p>GitHub connected as <strong>@${ghUser.login.replace(/</g, '&lt;')}</strong>. Closing window...</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', provider: 'github', sessionToken: ${JSON.stringify(signedSid)} }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'GitHub sign-in failed.';
      res.status(500).send(`
        <html><body style="font-family:sans-serif;padding:24px;">
          <p>GitHub login error: ${msg.replace(/</g, '&lt;')}</p>
        </body></html>
      `);
    }
  };

  app.get(['/auth/github/callback', '/auth/github/callback/'], (req, res) => {
    void handleGitHubCallback(req, res);
  });

  app.post('/api/auth/github/logout', (req, res) => {
    const active = getSessionFromRequest(req);
    if (active) githubSessions.delete(active.sid);
    res.clearCookie('dr_gh_session', {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      path: '/',
    });
    res.json({ ok: true });
  });

  app.post('/api/github/gist', async (req, res) => {
    try {
      const active = getSessionFromRequest(req);
      if (!active) {
        res.status(401).json({ error: 'Please connect your GitHub account first.' });
        return;
      }
      const session = active.data;

      const title = String(req.body?.title || 'DeepRecap Myanmar Export').trim();
      const socialCaption = String(req.body?.socialCaption || '').trim();
      const segments = (req.body?.segments || []) as SubtitleSegment[];

      const shortSrtSegments = splitSubtitleSegmentsShort(segments, 34);
      const srtLines = shortSrtSegments
        .map((s, idx) => {
          const fmt = (sec: number) => {
            const safe = Math.max(0, sec);
            const h = Math.floor(safe / 3600);
            const m = Math.floor((safe % 3600) / 60);
            const ss = Math.floor(safe % 60);
            const ms = Math.round((safe - Math.floor(safe)) * 1000);
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
          };
          return `${idx + 1}\n${fmt(s.startSec)} --> ${fmt(s.endSec)}\n${s.myanmarText}\n`;
        })
        .join('\n');

      const mdContent = [
        `# ${title}`,
        '',
        socialCaption ? `**Caption & Hashtags:**\n${socialCaption}\n` : '',
        '## Myanmar Narration Script',
        ...segments.map(
          (s) => `- **[${s.startSec.toFixed(1)}s - ${s.endSec.toFixed(1)}s]** ${s.myanmarText}`
        ),
      ]
        .filter(Boolean)
        .join('\n');

      const gistRes = await fetch('https://api.github.com/gists', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'DeepRecap-Myanmar-Studio',
        },
        body: JSON.stringify({
          description: `DeepRecap Myanmar Studio: ${title}`,
          public: false,
          files: {
            'recap_script.md': { content: mdContent || `# ${title}` },
            'subtitles_myanmar.srt': { content: srtLines || '1\n00:00:00,000 --> 00:00:05,000\nDeepRecap\n' },
          },
        }),
      });

      if (!gistRes.ok) {
        const errText = await gistRes.text();
        throw new Error(`GitHub Gist API failed (${gistRes.status}): ${errText.slice(0, 140)}`);
      }
      const gistJson = (await gistRes.json()) as { html_url?: string };
      res.json({ gistUrl: gistJson.html_url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save to GitHub Gist.';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/github/push-repo', async (req, res) => {
    try {
      const active = getSessionFromRequest(req);
      if (!active) {
        res.status(401).json({ error: 'Please connect your GitHub account first.' });
        return;
      }

      const { accessToken, user, scopes } = active.data;
      if (!scopes.includes('repo') && !scopes.includes('public_repo')) {
        res.status(403).json({
          error:
            'GitHub Repo push ခွင့်ပြုချက် (repo scope) မပါသေးပါ။ Disconnect နှိပ်ပြီး GitHub ကို ပြန်ချိတ်ပေးပါ။',
          needsReconnect: true,
        });
        return;
      }

      const rawName = String(req.body?.repoName || 'deeprecap-myanmar-studio').trim();
      const repoName =
        rawName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') ||
        'deeprecap-myanmar-studio';
      const isPrivate = Boolean(req.body?.isPrivate);
      const commitMessage =
        String(req.body?.commitMessage || '').trim() ||
        'Sync working DeepRecap Myanmar Studio files from AI Studio';

      const ghHeaders = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'DeepRecap-Myanmar-Studio',
      };

      const owner = user.login;
      let defaultBranch = 'main';
      let repoHtmlUrl = `https://github.com/${owner}/${repoName}`;

      const checkRepoRes = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}`,
        { headers: ghHeaders }
      );

      if (checkRepoRes.status === 404) {
        const createRes = await fetch('https://api.github.com/user/repos', {
          method: 'POST',
          headers: ghHeaders,
          body: JSON.stringify({
            name: repoName,
            private: isPrivate,
            description:
              'DeepRecap Myanmar Studio — AI Burmese Video Dubbing, 3-5 Min Recap & Subtitles',
            auto_init: true,
          }),
        });
        if (!createRes.ok) {
          const errTxt = await createRes.text();
          throw new Error(
            `Unable to create repository (${createRes.status}): ${errTxt.slice(0, 160)}`
          );
        }
        const created = (await createRes.json()) as {
          default_branch?: string;
          html_url?: string;
        };
        defaultBranch = created.default_branch || 'main';
        repoHtmlUrl = created.html_url || repoHtmlUrl;
      } else if (checkRepoRes.ok) {
        const existing = (await checkRepoRes.json()) as {
          default_branch?: string;
          html_url?: string;
        };
        defaultBranch = existing.default_branch || 'main';
        repoHtmlUrl = existing.html_url || repoHtmlUrl;
      } else {
        const errTxt = await checkRepoRes.text();
        throw new Error(
          `GitHub repo lookup failed (${checkRepoRes.status}): ${errTxt.slice(0, 140)}`
        );
      }

      // Resolve current HEAD commit SHA (or initialize empty repo if needed)
      let headSha: string | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const refRes = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/git/ref/heads/${defaultBranch}`,
          { headers: ghHeaders }
        );
        if (refRes.ok) {
          const refData = (await refRes.json()) as { object?: { sha?: string } };
          if (refData.object?.sha) {
            headSha = refData.object.sha;
            break;
          }
        } else if (refRes.status === 409) {
          // Empty repo with 0 commits: seed initial commit via Contents API
          await fetch(
            `https://api.github.com/repos/${owner}/${repoName}/contents/README.md`,
            {
              method: 'PUT',
              headers: ghHeaders,
              body: JSON.stringify({
                message: 'Initial commit',
                content: Buffer.from(`# ${repoName}\n`).toString('base64'),
                branch: defaultBranch,
              }),
            }
          );
        }
        await new Promise((r) => setTimeout(r, 800));
      }

      if (!headSha) {
        throw new Error(
          'Repository default branch could not be initialized on GitHub. Please retry in a few seconds.'
        );
      }

      // Collect all working project files while strictly excluding secrets, dependencies, and temp assets
      const rootDir = process.cwd();
      const skipDirs = new Set([
        'node_modules',
        'dist',
        'build',
        '.git',
        'coverage',
        '.aistudio',
      ]);
      const collectedFiles: Array<{ relPath: string; contentBase64: string }> = [];

      const walkDir = async (dirPath: string) => {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');

          if (entry.isDirectory()) {
            if (skipDirs.has(entry.name) || relPath === 'public/assets/aistudio') {
              continue;
            }
            await walkDir(fullPath);
            continue;
          }

          if (!entry.isFile()) continue;
          if (
            entry.name === '.DS_Store' ||
            entry.name.endsWith('.log') ||
            (entry.name.startsWith('.env') && entry.name !== '.env.example')
          ) {
            continue;
          }

          const stat = await fs.stat(fullPath);
          if (stat.size > 2 * 1024 * 1024) continue;

          const buf = await fs.readFile(fullPath);
          collectedFiles.push({
            relPath,
            contentBase64: buf.toString('base64'),
          });
        }
      };

      await walkDir(rootDir);

      if (collectedFiles.length === 0) {
        throw new Error('No project files found to push.');
      }

      const treeEntries: Array<{
        path: string;
        mode: '100644';
        type: 'blob';
        sha: string;
      }> = new Array(collectedFiles.length);

      await runPool(collectedFiles, 6, async (file, idx) => {
        const blobRes = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/git/blobs`,
          {
            method: 'POST',
            headers: ghHeaders,
            body: JSON.stringify({
              content: file.contentBase64,
              encoding: 'base64',
            }),
          }
        );
        if (!blobRes.ok) {
          const errTxt = await blobRes.text();
          throw new Error(
            `Failed uploading ${file.relPath} (${blobRes.status}): ${errTxt.slice(0, 120)}`
          );
        }
        const blobData = (await blobRes.json()) as { sha: string };
        treeEntries[idx] = {
          path: file.relPath,
          mode: '100644',
          type: 'blob',
          sha: blobData.sha,
        };
      });

      const treeRes = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/git/trees`,
        {
          method: 'POST',
          headers: ghHeaders,
          body: JSON.stringify({ tree: treeEntries }),
        }
      );
      if (!treeRes.ok) {
        const errTxt = await treeRes.text();
        throw new Error(`Failed creating Git tree (${treeRes.status}): ${errTxt.slice(0, 140)}`);
      }
      const treeData = (await treeRes.json()) as { sha: string };

      const commitRes = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/git/commits`,
        {
          method: 'POST',
          headers: ghHeaders,
          body: JSON.stringify({
            message: commitMessage,
            tree: treeData.sha,
            parents: [headSha],
          }),
        }
      );
      if (!commitRes.ok) {
        const errTxt = await commitRes.text();
        throw new Error(`Failed creating Git commit (${commitRes.status}): ${errTxt.slice(0, 140)}`);
      }
      const commitData = (await commitRes.json()) as {
        sha: string;
        html_url?: string;
      };

      const updateRefRes = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/${defaultBranch}`,
        {
          method: 'PATCH',
          headers: ghHeaders,
          body: JSON.stringify({
            sha: commitData.sha,
            force: true,
          }),
        }
      );
      if (!updateRefRes.ok) {
        const errTxt = await updateRefRes.text();
        throw new Error(
          `Failed updating branch ${defaultBranch} (${updateRefRes.status}): ${errTxt.slice(0, 140)}`
        );
      }

      res.json({
        ok: true,
        repoUrl: repoHtmlUrl,
        branch: defaultBranch,
        commitUrl: commitData.html_url || `${repoHtmlUrl}/commit/${commitData.sha}`,
        filesCount: collectedFiles.length,
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to push files to GitHub.';
      res.status(500).json({ error: msg });
    }
  });

  interface UploadSessionMeta {
    rawPath: string;
    filename: string;
    status?: 'uploading' | 'preparing' | 'ready' | 'failed';
    asset?: VideoAsset;
    error?: string;
  }

  const chunkUploadSessions = new Map<string, UploadSessionMeta>();
  const chunkMulter = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 16 * 1024 * 1024 },
  });

  async function loadUploadSession(
    uploadId: string
  ): Promise<UploadSessionMeta | null> {
    const cached = chunkUploadSessions.get(uploadId);
    if (cached) return cached;
    try {
      const metaPath = path.join(UPLOADS_DIR, `${uploadId}.upload.json`);
      const raw = await fs.readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as UploadSessionMeta;
      chunkUploadSessions.set(uploadId, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  async function saveUploadSession(
    uploadId: string,
    session: UploadSessionMeta
  ): Promise<void> {
    chunkUploadSessions.set(uploadId, session);
    const metaPath = path.join(UPLOADS_DIR, `${uploadId}.upload.json`);
    await fs.writeFile(metaPath, JSON.stringify(session), 'utf8').catch(() => {});
  }

  async function prepareUploadedVideo(
    uploadId: string,
    session: UploadSessionMeta
  ): Promise<void> {
    try {
      const origExt = path.extname(session.filename).toLowerCase() || '.mp4';
      const playableMp4 = path.join(UPLOADS_DIR, `${uploadId}.mp4`);
      const finalPath = await transcodeToBrowserMp4IfNeeded(
        session.rawPath,
        playableMp4
      );
      if (finalPath !== playableMp4) {
        await fs.rename(finalPath, playableMp4);
      }

      const info = await probeMedia(playableMp4);
      const baseTitle = path.basename(session.filename, origExt);

      const asset: VideoAsset & { filePath: string } = {
        videoId: uploadId,
        title: baseTitle || 'Uploaded Video',
        duration: info.duration,
        width: info.width,
        height: info.height,
        previewUrl: `/api/media/uploads/${uploadId}.mp4`,
        sourceType: 'file',
        hasDownloadableStream: true,
        filePath: playableMp4,
      };

      videoRegistry.set(uploadId, asset);
      await saveRegisteredAsset(asset);
      const { filePath: _omit, ...publicAsset } = asset;
      await saveUploadSession(uploadId, {
        ...session,
        status: 'ready',
        asset: publicAsset,
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to finalize uploaded video.';
      await saveUploadSession(uploadId, {
        ...session,
        status: 'failed',
        error: msg,
      });
    }
  }

  app.post('/api/video/upload/init', async (req, res) => {
    try {
      const filename = String(req.body?.filename || 'video.mp4');
      const uploadId = crypto.randomUUID().slice(0, 12);
      const origExt = path.extname(filename).toLowerCase() || '.mp4';
      const rawPath = path.join(UPLOADS_DIR, `${uploadId}_raw${origExt}`);
      await fs.writeFile(rawPath, Buffer.alloc(0));
      await saveUploadSession(uploadId, {
        rawPath,
        filename,
        status: 'uploading',
      });
      res.json({ uploadId });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to initialize upload.';
      res.status(500).json({ error: msg });
    }
  });

  app.post(
    '/api/video/upload/chunk/:uploadId',
    chunkMulter.single('chunk'),
    express.raw({ type: 'application/octet-stream', limit: '16mb' }),
    async (req, res) => {
      try {
        const session = await loadUploadSession(req.params.uploadId);
        if (!session) {
          res.status(404).json({ error: 'Upload session not found.' });
          return;
        }
        const chunk = req.file?.buffer || (Buffer.isBuffer(req.body) ? req.body : null);
        if (!chunk || chunk.length === 0) {
          res.status(400).json({ error: 'Empty upload chunk.' });
          return;
        }
        const rawOffset =
          req.query.offset ?? req.headers['x-chunk-offset'] ?? undefined;
        const parsedOffset =
          rawOffset !== undefined ? Number(rawOffset) : Number.NaN;
        if (Number.isInteger(parsedOffset) && parsedOffset >= 0) {
          const fh = await fs.open(session.rawPath, 'r+');
          try {
            await fh.write(chunk, 0, chunk.length, parsedOffset);
          } finally {
            await fh.close();
          }
        } else {
          await fs.appendFile(session.rawPath, chunk);
        }
        res.json({ ok: true, bytes: chunk.length });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Failed to write upload chunk.';
        res.status(500).json({ error: msg });
      }
    }
  );

  app.post('/api/video/upload/complete/:uploadId', async (req, res) => {
    try {
      const uploadId = req.params.uploadId;
      const session = await loadUploadSession(uploadId);
      if (!session) {
        res.status(404).json({ error: 'Upload session expired.' });
        return;
      }

      if (session.status === 'ready' && session.asset) {
        res.json({ status: 'ready', uploadId, asset: session.asset });
        return;
      }

      if (session.status !== 'preparing') {
        const nextSession: UploadSessionMeta = {
          ...session,
          status: 'preparing',
        };
        await saveUploadSession(uploadId, nextSession);
        void prepareUploadedVideo(uploadId, nextSession);
      }

      res.json({ status: 'preparing', uploadId });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to finalize uploaded video.';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/video/upload/status/:uploadId', async (req, res) => {
    const session = await loadUploadSession(req.params.uploadId);
    if (!session) {
      res.status(404).json({ error: 'Upload session not found.' });
      return;
    }
    let uploadedBytes = 0;
    try {
      const st = await fs.stat(session.rawPath);
      uploadedBytes = st.size;
    } catch {
      if (session.status === 'uploading') {
        res.status(404).json({ error: 'Upload session file missing.' });
        return;
      }
    }
    res.json({
      status: session.status || 'preparing',
      uploadedBytes,
      asset: session.asset,
      error: session.error,
    });
  });

  app.post('/api/video/upload', upload.single('video'), async (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'No video file uploaded.' });
        return;
      }

      const videoId = crypto.randomUUID().slice(0, 12);
      const origExt = path.extname(req.file.originalname).toLowerCase() || '.mp4';
      const rawDest = path.join(UPLOADS_DIR, `${videoId}_raw${origExt}`);
      await fs.rename(req.file.path, rawDest);

      const playableMp4 = path.join(UPLOADS_DIR, `${videoId}.mp4`);
      const finalPath = await transcodeToBrowserMp4IfNeeded(
        rawDest,
        playableMp4
      );
      if (finalPath !== playableMp4) {
        await fs.rename(finalPath, playableMp4);
      }

      const info = await probeMedia(playableMp4);
      const baseTitle = path.basename(req.file.originalname, origExt);

      const asset: VideoAsset & { filePath: string } = {
        videoId,
        title: baseTitle || 'Uploaded Video',
        duration: info.duration,
        width: info.width,
        height: info.height,
        previewUrl: `/api/media/uploads/${videoId}.mp4`,
        sourceType: 'file',
        hasDownloadableStream: true,
        filePath: playableMp4,
      };

      videoRegistry.set(videoId, asset);
      await saveRegisteredAsset(asset);
      const { filePath: _omit, ...publicAsset } = asset;
      res.json(publicAsset);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to process uploaded video.';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/video/youtube', async (req, res) => {
    try {
      const url = String(req.body?.url || '').trim();
      if (!url) {
        res.status(400).json({ error: 'Please provide a valid YouTube link.' });
        return;
      }

      const ytId = extractYouTubeId(url);
      if (!ytId) {
        res.status(400).json({
          error: 'Could not recognize YouTube video ID from this link.',
        });
        return;
      }

      const videoId = `yt_${crypto.randomUUID().slice(0, 10)}`;
      const meta = await fetchYouTubeOEmbed(url);
      const mp4Path = path.join(UPLOADS_DIR, `${videoId}.mp4`);

      const { downloadedRealStream } = await downloadYouTubeToFile(
        url,
        mp4Path,
        meta.thumbnailUrl
      );
      const info = await probeMedia(mp4Path);

      const asset: VideoAsset & { filePath: string } = {
        videoId,
        title: meta.title,
        duration: info.duration,
        width: info.width,
        height: info.height,
        previewUrl: `/api/media/uploads/${videoId}.mp4`,
        thumbnailUrl: meta.thumbnailUrl,
        sourceType: 'youtube',
        youtubeUrl: url,
        hasDownloadableStream: downloadedRealStream,
        filePath: mp4Path,
      };

      videoRegistry.set(videoId, asset);
      await saveRegisteredAsset(asset);
      const { filePath: _omit, ...publicAsset } = asset;
      res.json(publicAsset);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load YouTube video.';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/video/demo', async (_req, res) => {
    try {
      const videoId = `demo_${crypto.randomUUID().slice(0, 8)}`;
      const mp4Path = path.join(UPLOADS_DIR, `${videoId}.mp4`);
      await createDemoSampleVideo(mp4Path);
      const info = await probeMedia(mp4Path);

      const asset: VideoAsset & { filePath: string } = {
        videoId,
        title: 'မမျှော်လင့်ထားတဲ့ အမှန်တရား (Sample Drama)',
        duration: info.duration,
        width: info.width,
        height: info.height,
        previewUrl: `/api/media/uploads/${videoId}.mp4`,
        sourceType: 'demo',
        hasDownloadableStream: true,
        filePath: mp4Path,
      };

      videoRegistry.set(videoId, asset);
      await saveRegisteredAsset(asset);
      const { filePath: _omit, ...publicAsset } = asset;
      res.json(publicAsset);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create sample clip.';
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/voice/preview', async (req, res) => {
    try {
      const voiceId = req.body?.voiceId === 'nilar' ? 'nilar' : 'thiha';
      const ttsProvider = req.body?.ttsProvider === 'groq' ? 'groq' : 'gemini';
      const outputLanguage = req.body?.outputLanguage || 'my';
      const useGroqTts =
        ttsProvider === 'groq' && outputLanguage === 'en' && isGroqConfigured();
      const speedPercent = Number(req.body?.speedPercent) || 0;
      const pitchHz = Number(req.body?.pitchHz) || 0;
      const sampleText =
        typeof req.body?.text === 'string' && req.body.text.trim()
          ? req.body.text.trim()
          : useGroqTts
            ? voiceId === 'thiha'
              ? 'Hello! This is the Groq Orpheus English narrator voice preview for your video.'
              : 'Hello! This is the Groq Orpheus female English narrator voice preview for your video.'
            : voiceId === 'thiha'
              ? 'မင်္ဂလာပါခင်ဗျာ။ ကျွန်တော်ကတော့ သီဟ ဖြစ်ပါတယ်။ ဒီဗီဒီယိုလေးကို မြန်မာဘာသာဖြင့် အသံထွက်ပြောကြားပေးသွားမှာ ဖြစ်ပါတယ်။'
              : 'မင်္ဂလာပါရှင်။ ကျွန်မကတော့ နီလာ ဖြစ်ပါတယ်။ ဒီဇာတ်လမ်းလေးကို မြန်မာလို အနှစ်ချုပ်တင်ဆက်ပေးသွားပါမယ်ရှင်။';

      const id = crypto.randomUUID().slice(0, 10);
      const rawWav = path.join(WORK_DIR, `preview_raw_${id}.wav`);
      const shapedWav = path.join(WORK_DIR, `preview_shaped_${id}.wav`);

      if (useGroqTts) {
        await synthesizeSpeechWithGroqOrpheus({
          text: sampleText,
          voiceId,
          outWavPath: rawWav,
        });
      } else {
        await synthesizeMyanmarSpeech({
          text: sampleText,
          voiceId,
          outWavPath: rawWav,
        });
      }

      await adjustAudioSpeedPitch(rawWav, shapedWav, speedPercent, pitchHz);
      const wavBytes = await fs.readFile(shapedWav);

      // Cleanup temp preview files asynchronously
      fs.unlink(rawWav).catch(() => {});
      fs.unlink(shapedWav).catch(() => {});

      res.json({
        audioBase64: wavBytes.toString('base64'),
        mimeType: 'audio/wav',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Voice preview failed.';
      res.status(500).json({ error: msg });
    }
  });

  // Telegram Bot Account Linking & Cloud Delivery Routes (Per Verified Google User)
  app.get('/api/telegram/status', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    try {
      res.json(await getTelegramStatus(user.uid));
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to check Telegram status.',
      });
    }
  });

  app.post('/api/telegram/connect', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    try {
      const botToken = String(req.body?.botToken || '').trim();
      const chatId = String(req.body?.chatId || '').trim();
      res.json(await connectTelegramWithCredentials(user.uid, { botToken, chatId }));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to link Telegram Bot Token & Chat ID.',
      });
    }
  });

  app.post('/api/telegram/detect-chat', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    try {
      const botToken = String(req.body?.botToken || '').trim();
      res.json(await detectChatIdFromBotToken(botToken));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Unable to auto-detect Chat ID.',
      });
    }
  });

  app.post('/api/telegram/sync', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    try {
      const account = req.body?.account as TelegramAccount | undefined;
      if (!account?.botToken || !account?.chatId) {
        res.status(400).json({ error: 'Missing Telegram credentials to sync.' });
        return;
      }
      res.json(await syncTelegramCredentials(user.uid, account));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Unable to sync Telegram settings.',
      });
    }
  });

  app.post('/api/telegram/connect/start', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    try {
      res.json(await startTelegramConnect(user.uid));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to start Telegram connection.',
      });
    }
  });

  app.post('/api/telegram/connect/poll', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    try {
      const linkCode = String(req.body?.linkCode || '').trim();
      if (!linkCode) {
        res.status(400).json({ error: 'Missing Telegram linkCode.' });
        return;
      }
      res.json(await pollTelegramConnect(user.uid, linkCode));
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to verify Telegram connection.',
      });
    }
  });

  app.post('/api/telegram/disconnect', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    await disconnectTelegramAccount(user.uid);
    res.json({ ok: true });
  });

  app.post('/api/telegram/send/:jobId', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    try {
      const jobId = req.params.jobId;
      const item = getHistoryItemById(jobId, user.uid);
      const rawJob = jobRegistry.get(jobId);
      const job =
        rawJob && (!rawJob.userId || rawJob.userId === user.uid)
          ? rawJob
          : undefined;
      const result = item?.result || job?.result;
      if (!result) {
        res.status(404).json({ error: 'Completed video not found or expired.' });
        return;
      }
      const telegramOverride = req.body?.telegramOverride as
        | { botToken?: string; chatId?: string }
        | undefined;
      const mp4Path = path.join(
        OUTPUTS_DIR,
        path.basename(result.outputVideoUrl)
      );
      const srtPath = path.join(OUTPUTS_DIR, path.basename(result.outputSrtUrl));
      const sent = await sendRenderedVideoToTelegram({
        userId: user.uid,
        telegramOverride,
        mp4Path,
        srtPath,
        title: result.finalTitle,
        socialCaption: result.socialCaption,
        publicVideoPath: result.outputVideoUrl,
      });
      if (sent.status !== 'sent') {
        throw new Error(
          sent.error ||
            'Telegram Bot Token နှင့် Chat ID ချိတ်ဆက်ထားခြင်း မရှိသေးပါ။'
        );
      }
      const tgPatch: Partial<ProcessJobStatus> = {
        telegramStatus: 'sent',
        telegramError: undefined,
      };
      if (job) jobRegistry.set(jobId, { ...job, ...tgPatch });
      await patchHistoryItem(jobId, tgPatch);
      res.json({ ok: true, status: 'sent' });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Failed to send video to Telegram.',
      });
    }
  });

  // Saved Studio Config & 4-Hour Video History Routes (Per Verified Google User)
  app.get('/api/studio/config', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    const config = await getLastSavedConfig(user.uid);
    res.json({ config });
  });

  app.post('/api/studio/config', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    if (req.body?.config) {
      await saveLastConfig(user.uid, req.body.config as StudioConfig);
    }
    res.json({ ok: true });
  });

  app.get('/api/studio/asset/:videoId', (req, res) => {
    const asset = videoRegistry.get(req.params.videoId);
    if (!asset) {
      res.status(404).json({ error: 'Source video expired or not found.' });
      return;
    }
    const { filePath: _omit, ...publicAsset } = asset;
    res.json(publicAsset);
  });

  app.get('/api/studio/history', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    await cleanupExpiredHistory();
    res.json({ items: getHistorySnapshot(user.uid) });
  });

  app.delete('/api/studio/history/:jobId', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    const jobId = req.params.jobId;
    const existingJob = jobRegistry.get(jobId);
    if (existingJob && (!existingJob.userId || existingJob.userId === user.uid)) {
      jobRegistry.delete(jobId);
    }
    const removed = await deleteHistoryItem(jobId, user.uid);
    res.json({ ok: removed });
  });

  app.post('/api/studio/process', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    try {
      const videoId = String(req.body?.videoId || '');
      const config = req.body?.config as StudioConfig | undefined;
      const editedSegments = req.body?.editedSegments as
        | SubtitleSegment[]
        | undefined;
      const telegramOverride = req.body?.telegramOverride as
        | { botToken?: string; chatId?: string }
        | undefined;

      const asset = videoRegistry.get(videoId);
      if (!asset) {
        res.status(404).json({
          error: 'Source video session expired. Please upload or load the video again.',
        });
        return;
      }

      if (!config) {
        res.status(400).json({ error: 'Missing studio configuration.' });
        return;
      }

      // Persist last-used settings for this user
      await saveLastConfig(user.uid, config);

      const jobId = `job_${crypto.randomUUID().slice(0, 10)}`;
      const now = Date.now();
      const initialJob: ProcessJobStatus = {
        jobId,
        userId: user.uid,
        status: 'queued',
        progress: 5,
        stepLabel: 'Preparing studio pipeline on cloud...',
        createdAt: now,
        expiresAt: now + RETENTION_MS,
      };
      jobRegistry.set(jobId, initialJob);
      await upsertHistoryItem({
        jobId,
        userId: user.uid,
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
        expiresAt: now + RETENTION_MS,
      });

      void runStudioJob({
        jobId,
        userId: user.uid,
        asset,
        config,
        editedSegments,
        telegramOverride,
      });
      res.json({ jobId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start studio job.';
      res.status(500).json({ error: msg });
    }
  });

  app.get('/api/studio/job/:jobId', async (req, res) => {
    const user = await requireFirebaseUser(req, res);
    if (!user) return;
    const job = jobRegistry.get(req.params.jobId);
    if (job && (!job.userId || job.userId === user.uid)) {
      res.json(job);
      return;
    }
    const hist = getHistoryItemById(req.params.jobId, user.uid);
    if (hist) {
      res.json(hist);
      return;
    }
    res.status(404).json({ error: 'Job not found or expired after 4 hours.' });
  });

  app.get('/api/media/:bucket/:filename', async (req, res) => {
    const { bucket, filename } = req.params;
    const safeName = path.basename(filename);
    const dir =
      bucket === 'uploads'
        ? UPLOADS_DIR
        : bucket === 'outputs'
          ? OUTPUTS_DIR
          : null;

    if (!dir) {
      res.status(400).json({ error: 'Invalid media bucket.' });
      return;
    }

    const fullPath = path.join(dir, safeName);
    let fileSize = 0;
    try {
      const stat = await fs.stat(fullPath);
      fileSize = stat.size;
    } catch {
      res.status(404).json({ error: 'Media file not found.' });
      return;
    }

    const ext = path.extname(safeName).toLowerCase();
    const contentType =
      ext === '.mp4'
        ? 'video/mp4'
        : ext === '.webm'
          ? 'video/webm'
          : ext === '.wav'
            ? 'audio/wav'
            : ext === '.srt'
              ? 'text/plain; charset=utf-8'
              : 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (req.query.download === '1') {
      const customName =
        typeof req.query.name === 'string' && req.query.name.trim()
          ? req.query.name.trim().replace(/[^a-zA-Z0-9_\-\u1000-\u109F ]/g, '_')
          : safeName;
      const finalDownloadName = customName.endsWith(ext)
        ? customName
        : `${customName}${ext}`;
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(finalDownloadName)}`
      );
      res.setHeader('Content-Length', String(fileSize));
      const dlStream = fsSync.createReadStream(fullPath);
      res.on('close', () => dlStream.destroy());
      dlStream.pipe(res);
      return;
    }

    const MAX_RANGE_CHUNK = 4 * 1024 * 1024; // 4MB slices stay well under proxy caps
    const rangeHeader = req.headers.range;
    if (rangeHeader && fileSize > 0) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (!match) {
        res
          .status(416)
          .setHeader('Content-Range', `bytes */${fileSize}`)
          .end();
        return;
      }
      const start = Number(match[1]);
      if (Number.isNaN(start) || start < 0 || start >= fileSize) {
        res
          .status(416)
          .setHeader('Content-Range', `bytes */${fileSize}`)
          .end();
        return;
      }
      const requestedEnd = match[2]
        ? Math.min(Number(match[2]), fileSize - 1)
        : fileSize - 1;
      const end = Math.max(
        start,
        Math.min(requestedEnd, start + MAX_RANGE_CHUNK - 1)
      );
      const chunkLen = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', String(chunkLen));
      const stream = fsSync.createReadStream(fullPath, { start, end });
      stream.on('error', () => {
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    if (fileSize <= MAX_RANGE_CHUNK * 4) {
      res.setHeader('Content-Length', String(fileSize));
    }
    const stream = fsSync.createReadStream(fullPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });

  // Never fall through unmatched /api/* routes to HTML SPA fallback
  app.use('/api', (req, res) => {
    console.warn(`[API 404] ${req.method} ${req.originalUrl}`);
    res.status(404).json({
      error: `API endpoint not found: ${req.method} ${req.originalUrl}`,
    });
  });

  // Ensure API errors always return JSON instead of HTML error pages
  app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Server API error.';
    res.status(500).json({ error: message });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DeepRecap Myanmar Studio running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
