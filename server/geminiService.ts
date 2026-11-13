import fs from 'node:fs/promises';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  OutputLanguage,
  StudioMode,
  SubtitleSegment,
  VoiceId,
} from '../src/types/studio.ts';
import {
  generateScriptWithGroqLlama,
  isGroqConfigured,
  type TranscriptCue,
} from './externalAiService.ts';

const keyCooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 60_000;

export function getGeminiKeyPool(): string[] {
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ];
  const unique: string[] = [];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed && !unique.includes(trimmed)) {
      unique.push(trimmed);
    }
  }
  return unique;
}

function createClientForKey(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isQuotaOrRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return /429|RESOURCE_EXHAUSTED|quota|rate.?limit|exceeded/i.test(msg);
}

function formatReadableGeminiError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err || '');
  if (isQuotaOrRateLimitError(err)) {
    const retryMatch = /retry in ([0-9a-z.]+)/i.exec(raw);
    const retryHint = retryMatch ? ` (Retry in ${retryMatch[1]})` : '';
    return new Error(
      `Gemini Free Tier daily/rate quota reached${retryHint}. Use keys from separate Google Cloud projects or enable billing in Google AI Studio.`
    );
  }
  return err instanceof Error ? err : new Error(raw);
}

async function withKeyFailover<T>(
  fn: (ai: GoogleGenAI, keyIndex: number) => Promise<T>,
  quotaBucket = 'default'
): Promise<T> {
  const keys = getGeminiKeyPool();
  if (keys.length === 0) {
    throw new Error(
      'No Google Gemini API key configured in Settings > Secrets.'
    );
  }

  const now = Date.now();
  // Prefer keys not currently in rate-limit cooldown for this model bucket
  const orderedIndices = keys
    .map((_, idx) => idx)
    .sort((a, b) => {
      const aCooling = (keyCooldownUntil.get(`${quotaBucket}:${a}`) || 0) > now ? 1 : 0;
      const bCooling = (keyCooldownUntil.get(`${quotaBucket}:${b}`) || 0) > now ? 1 : 0;
      return aCooling - bCooling;
    });

  let lastErr: unknown;
  for (const idx of orderedIndices) {
    const ai = createClientForKey(keys[idx]);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await fn(ai, idx);
      } catch (err) {
        lastErr = err;
        if (isQuotaOrRateLimitError(err)) {
          keyCooldownUntil.set(`${quotaBucket}:${idx}`, Date.now() + COOLDOWN_MS);
          console.warn(
            `Gemini key #${idx + 1} (${quotaBucket}) hit rate limit; failing over to next key.`
          );
          break; // Immediately rotate to next key in pool
        }
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
  }

  throw lastErr;
}

export interface GeneratedScriptResult {
  suggestedTitle: string;
  socialCaption: string;
  segments: SubtitleSegment[];
}

export async function generateVideoScript(params: {
  mode: StudioMode;
  recapDurationMin: 3 | 4 | 5;
  outputLanguage: OutputLanguage;
  videoTitle: string;
  videoDuration: number;
  audioMp3Path?: string;
  keyframePaths: string[];
  youtubeUrl?: string;
  transcriptCues?: TranscriptCue[];
  addFyp: boolean;
}): Promise<GeneratedScriptResult> {
  const {
    mode,
    recapDurationMin,
    outputLanguage,
    videoTitle,
    videoDuration,
    audioMp3Path,
    keyframePaths,
    youtubeUrl,
    transcriptCues = [],
    addFyp,
  } = params;

  const targetLangName =
    outputLanguage === 'en'
      ? 'English'
      : outputLanguage === 'th'
        ? 'Thai (ภาษาไทย)'
        : 'Burmese (မြန်မာဘာသာ - natural spoken Myanmar)';

  const targetRecapSec = recapDurationMin * 60;
  const fypHint = addFyp ? 'Include #fyp at the end of hashtags.' : '';

  const modeInstructions =
    mode === 'recap'
      ? `MODE: AI VIDEO RECAP (${recapDurationMin} minutes / ~${targetRecapSec} seconds total narration).
Summarize the entire video story from beginning to climax and ending into an engaging ${recapDurationMin}-minute storytelling recap in ${targetLangName}.
- Generate 12 to 18 cohesive narrative segments.
- Each segment's text should be 2–3 natural spoken sentences (around 25–40 words in Burmese) so the complete spoken voiceover lasts between 3 and 5 minutes (targeting ~${targetRecapSec} seconds).
- For each segment, set startSec and endSec sequentially covering 0 to ${targetRecapSec}s.
- Also set sourceStartSec and sourceEndSec (within 0 to ${Math.max(1, videoDuration).toFixed(1)}s) pointing to the matching visual scene from the source video.`
      : mode === 'dub'
        ? `MODE: FULL AUDIO DUBBING.
Translate and adapt all dialogue and narration across the video (total duration ${Math.max(1, videoDuration).toFixed(1)}s) into natural, expressive ${targetLangName} suitable for voice dubbing by narrator Thiha.
- Group adjacent short lines into 6 to 12 cohesive spoken turns covering 0 to ${Math.max(1, videoDuration).toFixed(1)}s.
- Keep each segment concise enough to be spoken within its startSec..endSec slot.
- Set sourceStartSec = startSec and sourceEndSec = endSec.`
        : `MODE: SUBTITLE TRANSLATION.
Transcribe and translate all dialogue across the video (total duration ${Math.max(1, videoDuration).toFixed(1)}s) into short, bite-sized ${targetLangName} subtitle cues.
- Split long dialogue into short 1.5–3 second cues (max 5–10 words or ~32 characters per segment) covering 0 to ${Math.max(1, videoDuration).toFixed(1)}s.
- Set sourceStartSec = startSec and sourceEndSec = endSec.`;

  const transcriptSection =
    transcriptCues.length > 0
      ? `\nVERIFIED TIMESTAMPED SPEECH TRANSCRIPT (use these exact timings and spoken lines):\n${transcriptCues
          .map(
            (c) =>
              `[${c.startSec.toFixed(1)}s - ${c.endSec.toFixed(1)}s] ${c.text}`
          )
          .join('\n')}\n`
      : '';

  const promptText = `You are an expert Myanmar video dubbing & movie/drama recap scriptwriter for DeepRecap Myanmar Studio.
Source title: "${videoTitle}"
Source video duration: ${videoDuration.toFixed(1)} seconds.
${youtubeUrl ? `Source YouTube URL: ${youtubeUrl}` : ''}
${transcriptSection}
${modeInstructions}

CRITICAL OUTPUT REQUIREMENTS:
1. All dialogue/narration/subtitle text in "myanmarText" MUST be written in fluent, natural ${targetLangName} (avoid robotic literal translation; use authentic Myanmar storytelling cadence).
2. Keep sentences short and punchy with clear punctuation (။ / ၊) so subtitles appear in short, crisp single-line chunks (never giant paragraphs).
3. "suggestedTitle": If the source title is generic (like "video.mp4"), craft an engaging Burmese + English title; otherwise refine or keep "${videoTitle}" cleanly in Burmese/English.
4. "socialCaption": Write an engaging short TikTok/Reels caption in Burmese with 4–6 relevant hashtags like #shortdramareview #myanmartiktok #ဘာသာပြန်ဇာတ်လမ်းများ. ${fypHint}`;

  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [];

  if (audioMp3Path && transcriptCues.length === 0) {
    try {
      const audioBytes = await fs.readFile(audioMp3Path);
      if (audioBytes.length > 0 && audioBytes.length < 15 * 1024 * 1024) {
        parts.push({
          inlineData: {
            mimeType: 'audio/mp3',
            data: audioBytes.toString('base64'),
          },
        });
      }
    } catch {
      // ignore audio attach error
    }
  }

  for (const framePath of keyframePaths.slice(0, 6)) {
    try {
      const imgBytes = await fs.readFile(framePath);
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: imgBytes.toString('base64'),
        },
      });
    } catch {
      // ignore frame error
    }
  }

  parts.push({ text: promptText });

  const useUrlTools = Boolean(youtubeUrl && !audioMp3Path);

  try {
    const response = await withKeyFailover(
      async (ai) =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: { parts },
          config: {
            systemInstruction:
              'You are a master Burmese film narrator and video translator. Always output strictly valid JSON matching the requested schema.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            ...(useUrlTools
              ? { tools: [{ urlContext: {} }, { googleSearch: {} }] }
              : {}),
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                suggestedTitle: {
                  type: Type.STRING,
                  description: 'Catchy video title in Burmese/English.',
                },
                socialCaption: {
                  type: Type.STRING,
                  description: 'TikTok/Reels caption and hashtags.',
                },
                segments: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      startSec: { type: Type.NUMBER },
                      endSec: { type: Type.NUMBER },
                      sourceStartSec: { type: Type.NUMBER },
                      sourceEndSec: { type: Type.NUMBER },
                      myanmarText: {
                        type: Type.STRING,
                        description: 'Spoken Burmese narration and subtitle text.',
                      },
                      emotionStyle: {
                        type: Type.STRING,
                        description: 'Vocal delivery tone e.g. dramatic, calm, urgent.',
                      },
                    },
                    required: [
                      'startSec',
                      'endSec',
                      'sourceStartSec',
                      'sourceEndSec',
                      'myanmarText',
                    ],
                  },
                },
              },
              required: ['suggestedTitle', 'socialCaption', 'segments'],
            },
          },
        }),
      'script'
    );

    const rawJson = (response.text ?? '{}').trim();
    const parsed = JSON.parse(rawJson) as {
      suggestedTitle?: string;
      socialCaption?: string;
      segments?: Array<{
        startSec?: number;
        endSec?: number;
        sourceStartSec?: number;
        sourceEndSec?: number;
        myanmarText?: string;
        emotionStyle?: string;
      }>;
    };

    const segments: SubtitleSegment[] = (parsed.segments || [])
      .filter((s) => Boolean(s.myanmarText && s.myanmarText.trim()))
      .map((s, idx) => {
        const start = Math.max(0, Number(s.startSec) || idx * 5);
        const end = Math.max(start + 1.5, Number(s.endSec) || start + 5);
        const srcStart = Math.max(
          0,
          Math.min(videoDuration - 1, Number(s.sourceStartSec) || 0)
        );
        const srcEnd = Math.max(
          srcStart + 1,
          Math.min(videoDuration, Number(s.sourceEndSec) || videoDuration)
        );
        return {
          id: `seg_${idx + 1}`,
          startSec: start,
          endSec: end,
          sourceStartSec: srcStart,
          sourceEndSec: srcEnd,
          myanmarText: (s.myanmarText || '').trim(),
          emotionStyle: s.emotionStyle || 'Clear engaging Burmese narrator',
        };
      });

    if (segments.length === 0) {
      throw new Error('Could not generate Myanmar script segments for this video.');
    }

    return {
      suggestedTitle: parsed.suggestedTitle?.trim() || videoTitle,
      socialCaption:
        parsed.socialCaption?.trim() ||
        `#shortdramareview #myanmartiktok #ဘာသာပြန်ဇာတ်လမ်းများ${addFyp ? ' #fyp' : ''}`,
      segments,
    };
  } catch (err) {
    // If all Gemini keys are quota-limited and Groq is configured, fall back cleanly to Groq Llama
    if (isGroqConfigured() && isQuotaOrRateLimitError(err)) {
      return generateScriptWithGroqLlama({
        mode,
        recapDurationMin,
        outputLanguage,
        videoTitle,
        videoDuration,
        transcriptCues,
        addFyp,
      });
    }
    throw err;
  }
}

export async function synthesizeMyanmarSpeech(params: {
  text: string;
  voiceId: VoiceId;
  emotionStyle?: string;
  outWavPath: string;
}): Promise<void> {
  const { text, voiceId, emotionStyle, outWavPath } = params;

  const prebuiltVoiceName = voiceId === 'nilar' ? 'Kore' : 'Charon';
  const basePersona =
    voiceId === 'nilar'
      ? 'Warm, expressive female Myanmar narrator speaking natural fluent Burmese'
      : 'Thiha voice: confident, warm, clear male Myanmar storyteller speaking fluent Burmese';

  const styleDirective = emotionStyle
    ? `${basePersona}. Delivery tone: ${emotionStyle}`
    : basePersona;

  const ttsModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];
  let lastErr: unknown;

  for (const ttsModel of ttsModels) {
    try {
      const response = await withKeyFailover(
        async (ai) =>
          ai.models.generateContent({
            model: ttsModel,
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text,
                    speechMetadata: {
                      style: styleDirective,
                    },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: prebuiltVoiceName,
                  },
                },
              },
            },
          }),
        ttsModel
      );

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!base64Audio) {
        throw new Error('TTS service did not return audio data.');
      }

      const wavBuffer = Buffer.from(base64Audio, 'base64');
      await fs.writeFile(outWavPath, wavBuffer);
      return;
    } catch (err) {
      lastErr = err;
      if (!isQuotaOrRateLimitError(err)) {
        throw err;
      }
      console.warn(`${ttsModel} exhausted quota; trying next TTS model...`);
    }
  }

  throw formatReadableGeminiError(lastErr);
}
