/**
 * Audio sample rate conversion utilities.
 * Simple linear interpolation - good enough for voice.
 */

/** Resample PCM16 buffer from srcRate to dstRate */
export function resample(pcmBuf: Buffer, srcRate: number, dstRate: number): Buffer {
  if (srcRate === dstRate) return pcmBuf;

  const srcSamples = pcmBuf.length / 2;
  const dstSamples = Math.floor(srcSamples * dstRate / srcRate);
  const out = Buffer.alloc(dstSamples * 2);

  for (let i = 0; i < dstSamples; i++) {
    const srcPos = (i * srcRate) / dstRate;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;

    const s0 = pcmBuf.readInt16LE(Math.min(idx, srcSamples - 1) * 2);
    const s1 = pcmBuf.readInt16LE(Math.min(idx + 1, srcSamples - 1) * 2);
    const val = Math.round(s0 + frac * (s1 - s0));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2);
  }
  return out;
}

/** 8kHz → 16kHz */
export function upsample8to16(pcm8k: Buffer): Buffer {
  return resample(pcm8k, 8000, 16000);
}

/** 24kHz → 8kHz */
export function downsample24to8(pcm24k: Buffer): Buffer {
  return resample(pcm24k, 24000, 8000);
}
