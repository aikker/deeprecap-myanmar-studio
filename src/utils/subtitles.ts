import type { SubtitleSegment } from '../types/studio.ts';

function splitGraphemes(text: string): string[] {
  const SegmenterCtor = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        opts?: { granularity: 'grapheme' }
      ) => { segment: (input: string) => Iterable<{ segment: string }> };
    }
  ).Segmenter;

  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor('my', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (item) => item.segment);
  }
  return Array.from(text);
}

function splitLongClause(clause: string, maxGraphemes: number): string[] {
  const graphemes = splitGraphemes(clause);
  if (graphemes.length <= maxGraphemes) return [clause];

  const chunkCount = Math.ceil(graphemes.length / maxGraphemes);
  const targetSize = Math.ceil(graphemes.length / chunkCount);
  const out: string[] = [];
  let cursor = 0;

  while (cursor < graphemes.length) {
    if (graphemes.length - cursor <= maxGraphemes) {
      const tail = graphemes.slice(cursor).join('').trim();
      if (tail) out.push(tail);
      break;
    }

    let cutAt = Math.min(graphemes.length, cursor + targetSize);
    // Prefer breaking on a whitespace boundary near targetSize if present
    const minSearch = Math.max(cursor + 8, cutAt - 8);
    const maxSearch = Math.min(graphemes.length - 1, cursor + maxGraphemes);
    let bestSpace = -1;
    for (let i = cutAt; i >= minSearch; i--) {
      if (graphemes[i] === ' ') {
        bestSpace = i;
        break;
      }
    }
    if (bestSpace === -1) {
      for (let i = cutAt + 1; i <= maxSearch; i++) {
        if (graphemes[i] === ' ') {
          bestSpace = i;
          break;
        }
      }
    }
    if (bestSpace !== -1) {
      cutAt = bestSpace + 1;
    }

    const piece = graphemes.slice(cursor, cutAt).join('').trim();
    if (piece) out.push(piece);
    cursor = cutAt;
  }

  return out.length > 0 ? out : [clause];
}

export function splitSubtitleTextShort(text: string, maxGraphemes = 34): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const rawClauses = clean
    .split(/(?<=[။၊.!?…—;\n]+)\s*/)
    .map((c) => c.trim())
    .filter(Boolean);

  const pieces: string[] = [];
  for (const clause of rawClauses) {
    const subPieces = splitLongClause(clause, maxGraphemes);
    for (const p of subPieces) {
      pieces.push(p);
    }
  }

  // Merge tiny trailing/leading fragments (< 8 graphemes) if combined fits comfortably
  const merged: string[] = [];
  for (const piece of pieces) {
    const gLen = splitGraphemes(piece).length;
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      const prevLen = splitGraphemes(prev).length;
      if ((gLen < 8 || prevLen < 8) && prevLen + gLen + 1 <= maxGraphemes) {
        merged[merged.length - 1] = `${prev} ${piece}`.trim();
        continue;
      }
    }
    merged.push(piece);
  }

  return merged.length > 0 ? merged : [clean];
}

export function splitSubtitleSegmentsShort(
  segments: SubtitleSegment[],
  maxGraphemes = 34
): SubtitleSegment[] {
  const result: SubtitleSegment[] = [];

  for (const seg of segments) {
    const chunks = splitSubtitleTextShort(seg.myanmarText || '', maxGraphemes);
    if (chunks.length === 0) continue;

    if (chunks.length === 1) {
      result.push({
        ...seg,
        myanmarText: chunks[0],
      });
      continue;
    }

    const totalDur = Math.max(0.8, seg.endSec - seg.startSec);
    const weights = chunks.map((c) => Math.max(4, splitGraphemes(c).length));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    let cursorSec = seg.startSec;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const chunkDur = isLast
        ? Math.max(0.4, seg.endSec - cursorSec)
        : Math.max(0.45, (weights[i] / totalWeight) * totalDur);
      const chunkEnd = isLast
        ? Math.max(cursorSec + 0.4, seg.endSec)
        : Math.min(seg.endSec - (chunks.length - 1 - i) * 0.35, cursorSec + chunkDur);

      result.push({
        ...seg,
        id: `${seg.id}_${i + 1}`,
        startSec: Number(cursorSec.toFixed(2)),
        endSec: Number(Math.max(cursorSec + 0.35, chunkEnd).toFixed(2)),
        myanmarText: chunks[i],
      });
      cursorSec = chunkEnd;
    }
  }

  return result;
}
