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

const cachedBotUsernames = new Map<string, string>();
const pendingLinkCodes = new Map<string, { userId: string; createdAt: number }>();

function getEnvBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token || null;
}

async function resolveBotUsername(token: string): Promise<string | null> {
  const cached = cachedBotUsernames.get(token);
  if (cached) return cached;

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
      cachedBotUsernames.set(token, username);
      return username;
    }
    return null;
  } catch {
    return null;
  }
}

function toPublicTelegramStatus(
  token: string | null,
  botUsername: string | null,
  account: TelegramAccount | null
): TelegramAuthStatus {
  return {
    configured: Boolean(token && (botUsername || account?.botUsername)),
    botUsername: account?.botUsername || botUsername || null,
    connected: Boolean(account?.chatId && (account?.botToken || token)),
    account: account
      ? {
          chatId: account.chatId,
          botUsername: account.botUsername || botUsername || null,
          accountLabel: account.accountLabel || null,
          username: account.username || null,
          firstName: account.firstName || null,
        }
      : null,
  };
}

export async function getTelegramStatus(
  userId: string
): Promise<TelegramAuthStatus> {
  const saved = await getSavedTelegramAccount(userId);
  const activeToken = saved?.botToken?.trim() || getEnvBotToken();

  if (!activeToken) {
    return {
      configured: false,
      botUsername: null,
      connected: false,
      account: null,
    };
  }

  const botUsername =
    saved?.botUsername || (await resolveBotUsername(activeToken));
  return toPublicTelegramStatus(activeToken, botUsername, saved);
}

/**
 * Direct in-app linking using user-entered Bot Token (Bot ID) and Chat ID.
 * Validates the bot token via Telegram getMe and sends a test confirmation
 * message to chatId.
 */
export async function connectTelegramWithCredentials(
  userId: string,
  params: { botToken: string; chatId: string }
): Promise<{ status: TelegramAuthStatus; account: TelegramAccount }> {
  const botToken = params.botToken.trim();
  const chatId = params.chatId.trim();

  if (!botToken || !botToken.includes(':')) {
    throw new Error(
      'Bot Token (Bot ID) ပုံစံမမှန်ပါ။ @BotFather မှရသော Token (ဥပမာ 123456:ABC...) ကိုထည့်ပါ။'
    );
  }
  if (!chatId) {
    throw new Error('Telegram Chat ID ကိုထည့်သွင်းပေးပါ။');
  }

  const botUsername = await resolveBotUsername(botToken);
  if (!botUsername) {
    throw new Error(
      'Telegram Bot Token မှားယွင်းနေပါသည် (getMe မအောင်မြင်ပါ)။ Token ကို ပြန်စစ်ဆေးပါ။'
    );
  }

  const testRes = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✅ DeepRecap Myanmar Studio နှင့် ချိတ်ဆက်ပြီးပါပြီ!\nBot: @${botUsername}\n\nCloud ပေါ်တွင် Video Render ပြီးတိုင်း ဤ Telegram chat သို့ အလိုအလျောက် ပို့ပေးပါမည်။`,
      }),
      signal: AbortSignal.timeout(10_000),
    }
  );

  if (!testRes.ok) {
    const errText = await testRes.text();
    throw new Error(
      `Chat ID (${chatId}) သို့ Message ပို့၍မရပါ (${testRes.status})။ Bot ကို Telegram တွင် Start နှိပ်ထားပြီး Chat ID မှန်ကန်ကြောင်း စစ်ဆေးပါ။ ${errText.slice(0, 100)}`
    );
  }

  const msgJson = (await testRes.json()) as {
    ok?: boolean;
    result?: {
      chat?: {
        id?: number | string;
        username?: string;
        first_name?: string;
        title?: string;
      };
    };
  };

  const chat = msgJson.result?.chat;
  const account: TelegramAccount = {
    botToken,
    chatId: String(chat?.id ?? chatId),
    botUsername,
    username: chat?.username || null,
    firstName: chat?.first_name || chat?.title || null,
    accountLabel: chat?.username
      ? `@${chat.username}`
      : chat?.first_name || chat?.title || `Chat ${chatId}`,
  };

  await saveTelegramAccount(userId, account);
  return {
    status: toPublicTelegramStatus(botToken, botUsername, account),
    account,
  };
}

/**
 * Auto-detect Chat ID from recent messages sent to the user's Bot Token.
 */
export async function detectChatIdFromBotToken(
  botTokenRaw: string
): Promise<{ chatId: string; botUsername: string; label: string }> {
  const botToken = botTokenRaw.trim();
  if (!botToken || !botToken.includes(':')) {
    throw new Error('Bot Token ကို အရင်ထည့်သွင်းပါ။');
  }
  const botUsername = await resolveBotUsername(botToken);
  if (!botUsername) {
    throw new Error('Bot Token မမှန်ကန်ပါ။');
  }

  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/getUpdates?limit=25`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) {
    throw new Error('Telegram updates ကို ဖတ်၍မရပါ။');
  }

  const json = (await res.json()) as {
    ok?: boolean;
    result?: Array<{
      message?: {
        chat?: { id: number | string; username?: string; first_name?: string; title?: string };
      };
    }>;
  };

  const updates = json.result || [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i].message?.chat;
    if (chat?.id !== undefined && chat?.id !== null) {
      const label = chat.username
        ? `@${chat.username}`
        : chat.first_name || chat.title || String(chat.id);
      return {
        chatId: String(chat.id),
        botUsername,
        label,
      };
    }
  }

  throw new Error(
    `Chat ID မတွေ့သေးပါ။ Telegram တွင် @${botUsername} ကိုဖွင့်၍ /start (သို့) စာတစ်စောင် အရင်ပို့ပြီး ပြန်နှိပ်ပါ။`
  );
}

/**
 * Sync credentials restored from Firestore into current server instance without sending test message.
 */
export async function syncTelegramCredentials(
  userId: string,
  account: TelegramAccount
): Promise<TelegramAuthStatus> {
  const botToken = (account.botToken || '').trim();
  const chatId = (account.chatId || '').trim();
  if (!botToken || !chatId) {
    return getTelegramStatus(userId);
  }
  const botUsername =
    account.botUsername || (await resolveBotUsername(botToken));
  const saved: TelegramAccount = {
    ...account,
    botToken,
    chatId,
    botUsername,
  };
  await saveTelegramAccount(userId, saved);
  return toPublicTelegramStatus(botToken, botUsername, saved);
}

export async function startTelegramConnect(userId: string): Promise<{
  linkCode: string;
  deepLink: string;
  botUsername: string;
}> {
  const saved = await getSavedTelegramAccount(userId);
  const token = saved?.botToken?.trim() || getEnvBotToken();
  if (!token) {
    throw new Error('Bot Token ကို အရင်ထည့်သွင်းပါ။');
  }
  const botUsername = await resolveBotUsername(token);
  if (!botUsername) {
    throw new Error('Bot Token မမှန်ကန်ပါ။');
  }

  const now = Date.now();
  for (const [k, v] of pendingLinkCodes.entries()) {
    if (now - v.createdAt > 10 * 60 * 1000) pendingLinkCodes.delete(k);
  }

  const linkCode = `link_${crypto.randomBytes(4).toString('hex')}`;
  pendingLinkCodes.set(linkCode, { userId, createdAt: now });

  return {
    linkCode,
    deepLink: `https://t.me/${botUsername}?start=${linkCode}`,
    botUsername,
  };
}

export async function pollTelegramConnect(
  userId: string,
  linkCode: string
): Promise<{
  status: 'pending' | 'connected';
  account?: TelegramAccount;
}> {
  const saved = await getSavedTelegramAccount(userId);
  const token = saved?.botToken?.trim() || getEnvBotToken();
  if (!token) {
    throw new Error('Bot Token is not configured.');
  }

  const pending = pendingLinkCodes.get(linkCode);
  if (!pending || pending.userId !== userId) {
    throw new Error('Link code expired. Please generate a new Telegram link.');
  }

  const res = await fetch(
    `https://api.telegram.org/bot${token}/getUpdates?limit=35&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) return { status: 'pending' };

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
      const botUsername = await resolveBotUsername(token);
      const account: TelegramAccount = {
        botToken: token,
        chatId: String(msg.chat.id),
        botUsername,
        username: msg.from?.username || msg.chat.username || null,
        firstName:
          msg.from?.first_name || msg.chat.first_name || msg.chat.title || 'Telegram User',
      };
      await saveTelegramAccount(userId, account);
      pendingLinkCodes.delete(linkCode);

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

export async function disconnectTelegramAccount(userId: string): Promise<void> {
  await saveTelegramAccount(userId, null);
}

export async function sendRenderedVideoToTelegram(params: {
  userId?: string;
  telegramOverride?: { botToken?: string; chatId?: string } | null;
  mp4Path: string;
  srtPath?: string;
  title: string;
  socialCaption: string;
  publicVideoPath: string;
}): Promise<{
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
}> {
  const saved = params.userId
    ? await getSavedTelegramAccount(params.userId)
    : null;

  const token =
    params.telegramOverride?.botToken?.trim() ||
    saved?.botToken?.trim() ||
    getEnvBotToken();
  const chatId =
    params.telegramOverride?.chatId?.trim() ||
    saved?.chatId?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim();

  if (!token || !chatId) {
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
      form.append('chat_id', chatId);
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

    const appBase = (process.env.APP_URL || '').trim().replace(/\/$/, '');
    const dlLink = appBase ? `${appBase}${publicVideoPath}?download=1` : publicVideoPath;
    const msgRes = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
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
        docForm.append('chat_id', chatId);
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
