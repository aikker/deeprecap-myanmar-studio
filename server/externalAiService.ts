import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  OutputLanguage,
  StudioMode,
  SubtitleSegment,
  VoiceId,
} from '../src/types/studio.ts';

const execFileAsync = promisify(execFile);

export interface TranscriptCue {
  startSec: number;
  endSec: number;
  text: string;
}

export function isGroqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

export function isAssemblyAiConfigured(): boolean {
  return Boolean(process.env.ASSEMBLYAI_API_KEY?.trim());
}

export async function transcribeWithAssemblyAI(
  audioMp3Path: string
): Promise<TranscriptCue[]> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('ASSEMBLYAI_API_KEY is not configured in Settings > Secrets.');
  }

  const audioBuffer = await fs.readFile(audioMp3Path);
  const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/octet-stream',
    },
    body: audioBuffer,
  });
  if (!uploadRes.ok) {
    throw new Error(`AssemblyAI upload failed (${uploadRes.status}).`);
  }
  const uploadJson = (await uploadRes.json()) as { upload_url?: string };
  if (!uploadJson.upload_url) {
    throw new Error('AssemblyAI did not return an upload URL.');
  }

  const transcriptRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audio_url: uploadJson.upload_url,
      punctuate: true,
      language_detection: true,
    }),
  });
  if (!transcriptRes.ok) {
    throw new Error(`AssemblyAI transcript request failed (${transcriptRes.status}).`);
  }
  const created = (await transcriptRes.json()) as { id?: string };
  if (!created.id) {
    throw new Error('AssemblyAI transcript job ID missing.');
  }

  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(
      `https://api.assemblyai.com/v2/transcript/${created.id}`,
      { headers: { Authorization: apiKey } }
    );
    if (!pollRes.ok) {
      continue;
    }
    const statusJson = (await pollRes.json()) as {
      status?: string;
      error?: string;
      text?: string;
      words?: Array<{ text: string; start: number; end: number }>;
    };

    if (statusJson.status === 'error') {
      throw new Error(statusJson.error || 'AssemblyAI transcription failed.');
    }

    if (statusJson.status === 'completed') {
      // Try sentence endpoint first for clean timed segments
      const sentRes = await fetch(
        `https://api.assemblyai.com/v2/transcript/${created.id}/sentences`,
        { headers: { Authorization: apiKey } }
      );
      if (sentRes.ok) {
        const sentJson = (await sentRes.json()) as {
          sentences?: Array<{ text: string; start: number; end: number }>;
        };
        if (sentJson.sentences && sentJson.sentences.length > 0) {
          return sentJson.sentences.map((s) => ({
            startSec: s.start / 1000,
            endSec: s.end / 1000,
            text: s.text.trim(),
          }));
        }
      }

      if (statusJson.text?.trim()) {
        return [
          {
            startSec: 0,
            endSec:
              ((statusJson.words?.[statusJson.words.length - 1]?.end || 15000) /
                1000),
            text: statusJson.text.trim(),
          },
        ];
      }
      return [];
    }
  }

  throw new Error('AssemblyAI transcription timed out.');
}

export async function transcribeWithGroqWhisper(
  audioMp3Path: string
): Promise<TranscriptCue[]> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured in Settings > Secrets.');
  }

  const audioBytes = await fs.readFile(audioMp3Path);
  const form = new FormData();
  form.append(
    'file',
    new Blob([audioBytes], { type: 'audio/mpeg' }),
    'source_audio.mp3'
  );
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  const res = await fetch(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq Whisper error (${res.status}): ${errText.slice(0, 180)}`);
  }

  const json = (await res.json()) as {
    text?: string;
    segments?: Array<{ start: number; end: number; text: string }>;
  };

  if (json.segments && json.segments.length > 0) {
    return json.segments
      .filter((s) => Boolean(s.text?.trim()))
      .map((s) => ({
        startSec: Number(s.start) || 0,
        endSec: Number(s.end) || (Number(s.start) || 0) + 4,
        text: s.text.trim(),
      }));
  }

  if (json.text?.trim()) {
    return [{ startSec: 0, endSec: 20, text: json.text.trim() }];
  }
  return [];
}

export async function generateScriptWithGroqLlama(params: {
  mode: StudioMode;
  recapDurationMin: 3 | 4 | 5;
  outputLanguage: OutputLanguage;
  videoTitle: string;
  videoDuration: number;
  transcriptCues: TranscriptCue[];
  addFyp: boolean;
}): Promise<{
  suggestedTitle: string;
  socialCaption: string;
  segments: SubtitleSegment[];
}> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured.');
  }

  const {
    mode,
    recapDurationMin,
    outputLanguage,
    videoTitle,
    videoDuration,
    transcriptCues,
    addFyp,
  } = params;

  const targetLangName =
    outputLanguage === 'en'
      ? 'English'
      : outputLanguage === 'th'
        ? 'Thai'
        : 'Burmese (မြန်မာဘာသာ - natural spoken Myanmar Unicode)';

  const transcriptBlock =
    transcriptCues.length > 0
      ? transcriptCues
          .map(
            (c) =>
              `[${c.startSec.toFixed(1)}s - ${c.endSec.toFixed(1)}s] ${c.text}`
          )
          .join('\n')
      : `Title: ${videoTitle}, Duration: ${videoDuration.toFixed(1)}s`;

  const systemPrompt =
    'You are an expert Myanmar movie/drama translator and recap scriptwriter. Return ONLY valid JSON with keys: suggestedTitle (string), socialCaption (string), segments (array of {startSec, endSec, sourceStartSec, sourceEndSec, myanmarText, emotionStyle}).';

  const userPrompt = `Source title: "${videoTitle}"
Duration: ${videoDuration.toFixed(1)}s
Mode: ${mode} ${mode === 'recap' ? `(${recapDurationMin} minute summary targeting ~${recapDurationMin * 60}s across 16-22 narrative segments)` : mode === 'subtitle' ? '(short 1.5-3s subtitle cues, max 32 chars each)' : ''}
Target language: ${targetLangName}
Keep sentences short and punchy with clear Burmese punctuation (။ / ၊) so on-screen subtitles stay short (one short line per cue).
${addFyp ? 'Include #fyp in socialCaption hashtags.' : ''}

Transcript with timestamps:
${transcriptBlock}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq Llama error (${res.status}): ${errText.slice(0, 180)}`);
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content) as {
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
    .filter((s) => Boolean(s.myanmarText?.trim()))
    .map((s, idx) => {
      const start = Math.max(0, Number(s.startSec) || idx * 5);
      const end = Math.max(start + 1.5, Number(s.endSec) || start + 5);
      return {
        id: `seg_${idx + 1}`,
        startSec: start,
        endSec: end,
        sourceStartSec: Math.max(
          0,
          Math.min(videoDuration - 1, Number(s.sourceStartSec) || 0)
        ),
        sourceEndSec: Math.max(
          1,
          Math.min(videoDuration, Number(s.sourceEndSec) || videoDuration)
        ),
        myanmarText: (s.myanmarText || '').trim(),
        emotionStyle: s.emotionStyle || 'Clear engaging Burmese narrator',
      };
    });

  if (segments.length === 0) {
    throw new Error('Groq Llama returned empty script segments.');
  }

  return {
    suggestedTitle: parsed.suggestedTitle?.trim() || videoTitle,
    socialCaption:
      parsed.socialCaption?.trim() ||
      `#shortdramareview #myanmartiktok #ဘာသာပြန်ဇာတ်လမ်းများ${addFyp ? ' #fyp' : ''}`,
    segments,
  };
}

function splitTextIntoTtsChunks(text: string, maxLen = 190): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const chunks: string[] = [];
  let remaining = clean;
  while (remaining.length > maxLen) {
    let sliceIdx = remaining.lastIndexOf('. ', maxLen);
    if (sliceIdx < 40) sliceIdx = remaining.lastIndexOf(' ', maxLen);
    if (sliceIdx < 20) sliceIdx = maxLen;
    chunks.push(remaining.slice(0, sliceIdx + 1).trim());
    remaining = remaining.slice(sliceIdx + 1).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function synthesizeSpeechWithGroqOrpheus(params: {
  text: string;
  voiceId: VoiceId;
  outWavPath: string;
}): Promise<void> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured in Settings > Secrets.');
  }

  const { text, voiceId, outWavPath } = params;
  const groqVoice = voiceId === 'nilar' ? 'hannah' : 'troy';
  const chunks = splitTextIntoTtsChunks(text, 190);
  if (chunks.length === 0) {
    throw new Error('Empty text for Groq TTS.');
  }

  const synthesizeChunk = async (chunkText: string): Promise<Buffer> => {
    const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'canopylabs/orpheus-v1-english',
        voice: groqVoice,
        input: chunkText,
        response_format: 'wav',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Groq Orpheus TTS error (${res.status}): ${errText.slice(0, 180)}`
      );
    }

    return Buffer.from(await res.arrayBuffer());
  };

  if (chunks.length === 1) {
    const wavBuf = await synthesizeChunk(chunks[0]);
    await fs.writeFile(outWavPath, wavBuf);
    return;
  }

  const partPaths: string[] = [];
  const dir = path.dirname(outWavPath);
  const base = path.basename(outWavPath, path.extname(outWavPath));
  try {
    for (let i = 0; i < chunks.length; i++) {
      const partPath = path.join(dir, `${base}_gpart_${i}.wav`);
      const buf = await synthesizeChunk(chunks[i]);
      await fs.writeFile(partPath, buf);
      partPaths.push(partPath);
    }

    const listPath = path.join(dir, `${base}_gconcat.txt`);
    const listBody = partPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join('\n');
    await fs.writeFile(listPath, listBody, 'utf8');

    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-ar',
      '24000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      outWavPath,
    ]);
    await fs.unlink(listPath).catch(() => {});
  } finally {
    await Promise.all(partPaths.map((p) => fs.unlink(p).catch(() => {})));
  }
}
