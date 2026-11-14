import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

function isExecutable(binPath: string | null | undefined): binPath is string {
  if (!binPath) return false;
  try {
    if (!fsSync.existsSync(binPath)) return false;
    try {
      fsSync.accessSync(binPath, fsSync.constants.X_OK);
    } catch {
      fsSync.chmodSync(binPath, 0o755);
    }
    return true;
  } catch {
    return false;
  }
}

function hasSystemBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const FFMPEG_BIN: string = isExecutable(ffmpegStatic)
  ? ffmpegStatic
  : hasSystemBinary('ffmpeg')
    ? 'ffmpeg'
    : 'ffmpeg';

export const FFPROBE_BIN: string = isExecutable(ffprobeStatic?.path)
  ? ffprobeStatic.path
  : hasSystemBinary('ffprobe')
    ? 'ffprobe'
    : 'ffprobe';

export const BUNDLED_FONTS_DIR: string = path.resolve(
  process.cwd(),
  'server',
  'fonts'
);
