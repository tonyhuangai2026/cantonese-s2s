"""MiniMax TTS client."""
import asyncio
import logging
import struct
import requests
from config import (
    MINIMAX_API_KEY, MINIMAX_TTS_URL, MINIMAX_TTS_MODEL,
    MINIMAX_VOICE_ID, MINIMAX_LANGUAGE_BOOST, OUTPUT_SAMPLE_RATE,
)

log = logging.getLogger("tts")


def mp3_to_pcm_24k(mp3_bytes: bytes) -> bytes:
    """Convert MP3 bytes to PCM16 mono 24kHz using ffmpeg subprocess."""
    import subprocess, tempfile, os
    tmp_in = tempfile.mktemp(suffix=".mp3")
    tmp_out = tempfile.mktemp(suffix=".raw")
    try:
        with open(tmp_in, "wb") as f:
            f.write(mp3_bytes)
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_in, "-ar", str(OUTPUT_SAMPLE_RATE),
             "-ac", "1", "-f", "s16le", tmp_out],
            capture_output=True, check=True,
        )
        with open(tmp_out, "rb") as f:
            return f.read()
    except Exception as e:
        log.error(f"MP3→PCM conversion failed: {e}")
        return b""
    finally:
        for p in (tmp_in, tmp_out):
            try:
                os.unlink(p)
            except OSError:
                pass


class TTSClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {MINIMAX_API_KEY}",
            "Content-Type": "application/json",
        })

    async def synthesize(self, text: str) -> tuple[bytes, float]:
        """Returns (pcm_24k_bytes, duration_ms). PCM format matches Nova Sonic output."""
        if not text.strip():
            return b"", 0.0

        payload = {
            "model": MINIMAX_TTS_MODEL,
            "text": text,
            "voice_setting": {
                "voice_id": MINIMAX_VOICE_ID,
                "language_boost": MINIMAX_LANGUAGE_BOOST,
            },
        }

        loop = asyncio.get_event_loop()
        for attempt in range(3):
            try:
                resp = await loop.run_in_executor(
                    None,
                    lambda: self.session.post(MINIMAX_TTS_URL, json=payload, timeout=30),
                )
                data = resp.json()
                status_code = data.get("base_resp", {}).get("status_code", -1)
                if status_code == 1002:
                    wait = 2 ** attempt
                    log.warning(f"Rate limit, retry in {wait}s")
                    await asyncio.sleep(wait)
                    continue
                if status_code != 0:
                    log.error(f"TTS error: {data.get('base_resp', {}).get('status_msg', '')}")
                    return b"", 0.0
                audio_hex = data.get("data", {}).get("audio", "")
                duration_ms = data.get("extra_info", {}).get("audio_length", 0)
                if audio_hex:
                    mp3_bytes = bytes.fromhex(audio_hex)
                    # Convert to PCM 24kHz to match Nova Sonic output format
                    pcm = await loop.run_in_executor(None, mp3_to_pcm_24k, mp3_bytes)
                    return pcm, float(duration_ms)
                return b"", 0.0
            except Exception as e:
                log.error(f"TTS exception: {e}")
                if attempt < 2:
                    await asyncio.sleep(1)

        return b"", 0.0
