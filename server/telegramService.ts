import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
  TelegramAccount,
  TelegramAuthStatus,
} from '../src/types/studio.ts';
import {
  getSavedTelegramAccount,
  saveTelegramAccount,
} from './studioStorage.ts';

const execFileAsync = promisify(execFile);

let cachedBotInfo: { token: string; username: string } | null = null;
const pendingLinkCodes = new Map<string, { createdAt: number }>();

function getBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token || null;
}

async function resolveBotUsername(token: string): Promise<string | null> {
  if (cachedBotInfo && cachedBotInfo.token === token) {
    return cachedBotInfo.username;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      ok?: boolean;
      result?: { username?: string };
    };
    const username = json.result?.username;
    if (json.ok && username) {
      cachedBotInfo = { token, username };
      return username;
    }
    return null;
  } catch {
    return null;
  }
}

export async function getTelegramStatus(): Promise<TelegramAuthStatus> {
  const token = getBotToken();
  if (!token) {
    return {
      configured: false,
      botUsername: null,
      connected: false,
      account: null,
    };
  }
  const [botUsername, account] = await Promise.all([
    resolveBotUsername(token),
    getSavedTelegramAccount(),
  ]);
  return {
    configured: Boolean(botUsername),
    botUsername,
    connected: Boolean(account?.chatId),
    account,
  };
}

export async function startTelegramConnect(): Promise<{
  linkCode: string;
  deepLink: string;
  botUsername: string;
}> {
  const token = getBotToken();
  if (!token) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN is not configured in Settings > Secrets.'
    );
  }
  const botUsername = await resolveBotUsername(token);
  if (!botUsername) {
    throw new Error(
      'Invalid TELEGRAM_BOT_TOKEN — unable to reach Telegram Bot API.'
    );
  }

  const now = Date.now();
  for (const [k, v] of pendingLinkCodes.entries()) {
    if (now - v.createdAt > 10 * 60 * 1000) pendingLinkCodes.delete(k);
  }

  const linkCode = `link_${crypto.randomBytes(4).toString('hex')}`;
  pendingLinkCodes.set(linkCode, { createdAt: now });

  return {
    linkCode,
    deepLink: `https://t.me/${botUsername}?start=${linkCode}`,
    botUsername,
  };
}

export async function pollTelegramConnect(linkCode: string): Promise<{
  status: 'pending' | 'connected';
  account?: TelegramAccount;
}> {
  const token = getBotToken();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }

  const pending = pendingLinkCodes.get(linkCode);
  if (!pending) {
    throw new Error('Link code expired. Please generate a new Telegram link.');
  }

  const res = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?limit=35&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) {
    return { status: 'pending' };
  }

  const json = (await res.json()) as {
    ok?: boolean;
    result?: Array<{
      message?: {
        text?: string;
        chat?: { id: number | string; title?: string; username?: string; first_name?: string };
        from?: { username?: string; first_name?: string };
      };
    }>;
  };

  const updates = json.result || [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i].message;
    const text = (msg?.text || '').trim();
    if (!msg?.chat?.id) continue;
    if (text === `/start ${linkCode}` || text === linkCode) {
      const account: TelegramAccount = {
        chatId: String(msg.chat.id),
        username: msg.from?.username || msg.chat.username || null,
        firstName:
          msg.from?.first_name || msg.chat.first_name || msg.chat.title || 'Telegram User',
      };
      await saveTelegramAccount(account);
      pendingLinkCodes.delete(linkCode);

      // Send welcome confirmation to Telegram
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: account.chatId,
          text: '✅ DeepRecap Myanmar Studio နှင့် ချိတ်ဆက်ပြီးပါပြီ!\n\nCloud ပေါ်တွင် Video Render ပြီးတိုင်း ဤ Telegram chat သို့ အလိုအလျောက် ပို့ပေးပါမည်။',
        }),
      }).catch(() => {});

      return { status: 'connected', account };
    }
  }

  return { status: 'pending' };
}

export async function disconnectTelegramAccount(): Promise<void> {
  await saveTelegramAccount(null);
}

export async function sendRenderedVideoToTelegram(params: {
  mp4Path: string;
  srtPath?: string;
  title: string;
  socialCaption: string;
  publicVideoPath: string;
}): Promise<{
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
}> {
  const token = getBotToken();
  const account = await getSavedTelegramAccount();
  if (!token || !account?.chatId) {
    return { status: 'skipped' };
  }

  const { mp4Path, srtPath, title, socialCaption, publicVideoPath } = params;
  const caption = `🎬 ${title}\n\n${socialCaption}`.trim().slice(0, 1000);
  const MAX_TG_BYTES = 48 * 1024 * 1024;

  try {
    const stat = await fs.stat(mp4Path);
    let uploadPath = mp4Path;
    let compressedPath: string | null = null;

    if (stat.size > MAX_TG_BYTES) {
      // Compress a Telegram-friendly 720p copy if 1080p exceeds Telegram Bot 50MB limit
      compressedPath = mp4Path.replace(/_final\.mp4$/, '_telegram.mp4');
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-i',
          mp4Path,
          '-vf',
          "scale='min(1280,iw)':-2",
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '27',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          compressedPath,
        ]);
        const cStat = await fs.stat(compressedPath);
        if (cStat.size <= MAX_TG_BYTES) {
          uploadPath = compressedPath;
        }
      } catch {
        compressedPath = null;
      }
    }

    const finalStat = await fs.stat(uploadPath);
    if (finalStat.size <= MAX_TG_BYTES) {
      const videoBytes = await fs.readFile(uploadPath);
      const form = new FormData();
      form.append('chat_id', account.chatId);
      form.append('caption', caption);
      form.append('supports_streaming', 'true');
      form.append(
        'video',
        new Blob([videoBytes], { type: 'video/mp4' }),
        `${title.replace(/[^a-zA-Z0-9_\-\u1000-\u109F ]/g, '_').slice(0, 40) || 'deeprecap'}.mp4`
      );

      const tgRes = await fetch(
        `https://api.telegram.org/bot${token}/sendVideo`,
        {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(120_000),
        }
      );
      if (compressedPath) {
        await fs.rm(compressedPath, { force: true }).catch(() => {});
      }
      if (!tgRes.ok) {
        const errTxt = await tgRes.text();
        throw new Error(`Telegram sendVideo failed (${tgRes.status}): ${errTxt.slice(0, 140)}`);
      }
      return { status: 'sent' };
    }

    // If still > 48MB, send direct download link + SRT subtitle file
    const appBase = (process.env.APP_URL || '').trim().replace(/\/$/, '');
    const dlLink = appBase ? `${appBase}${publicVideoPath}?download=1` : publicVideoPath;
    const msgRes = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: account.chatId,
          text: `${caption}\n\n📦 1080p MP4 File is over Telegram 50MB Bot limit.\nDownload (valid for 4 hours): ${dlLink}`,
        }),
      }
    );
    if (!msgRes.ok) {
      const errTxt = await msgRes.text();
      throw new Error(`Telegram sendMessage failed (${msgRes.status}): ${errTxt.slice(0, 140)}`);
    }

    if (srtPath) {
      try {
        const srtBytes = await fs.readFile(srtPath);
        const docForm = new FormData();
        docForm.append('chat_id', account.chatId);
        docForm.append(
          'document',
          new Blob([srtBytes], { type: 'text/plain' }),
          'subtitles_myanmar.srt'
        );
        await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
          method: 'POST',
          body: docForm,
        });
      } catch {
        // ignore optional srt attachment failure
      }
    }

    return { status: 'sent' };
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : 'Telegram delivery failed.',
    };
  }
}
