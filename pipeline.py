"""Pipeline: VAD → ASR → LLM → TTS with barge-in."""
import asyncio
import base64
import time
import logging
import struct
import math

from vad import VoiceActivityDetector
from asr import ASRSession
from llm import LLMSession
from tts import TTSClient
from config import (
    VAD_SILENCE_MS, VAD_MIN_SPEECH_MS, INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE,
    BARGE_IN_ENERGY_THRESHOLD, BARGE_IN_WINDOW_SIZE, BARGE_IN_MIN_LOUD,
)

log = logging.getLogger("pipeline")


def pcm_rms(pcm_bytes: bytes) -> float:
    if len(pcm_bytes) < 2:
        return 0.0
    n = len(pcm_bytes) // 2
    samples = struct.unpack(f"<{n}h", pcm_bytes[:n * 2])
    return math.sqrt(sum(s * s for s in samples) / n) if samples else 0.0


class ConversationPipeline:
    """Accepts audio input, produces events compatible with Nova Sonic v2 output format."""

    def __init__(self, send_event_fn, prompt_name: str):
        """
        send_event_fn: async fn(event_dict) - sends a Nova Sonic compatible event to client.
        prompt_name: from the client's promptStart.
        """
        self.send_event = send_event_fn
        self.prompt_name = prompt_name
        self.vad = VoiceActivityDetector(
            silence_ms=VAD_SILENCE_MS,
            min_speech_ms=VAD_MIN_SPEECH_MS,
            sample_rate=INPUT_SAMPLE_RATE,
        )
        self.llm = LLMSession()
        self.tts = TTSClient()
        self.asr: ASRSession | None = None

        self.state = "idle"  # idle | listening | busy | responding
        self._barge_in_window = []
        self._barge_in_triggered = False
        self._content_counter = 0

    def _next_content_name(self):
        self._content_counter += 1
        return f"content-{self._content_counter}"

    async def handle_audio_chunk(self, audio_b64: str):
        """Handle incoming audioInput event (base64 PCM 16kHz)."""
        pcm = base64.b64decode(audio_b64)
        # Split into 512-sample (1024 byte) chunks for VAD
        chunk_size = 1024
        for i in range(0, len(pcm), chunk_size):
            chunk = pcm[i:i + chunk_size]
            if len(chunk) == chunk_size:
                await self._process_chunk(chunk)

    async def _process_chunk(self, pcm_bytes: bytes):
        if self.state in ("idle", "listening"):
            await self._handle_listening(pcm_bytes)
        elif self.state == "responding":
            self._handle_barge_in(pcm_bytes)

    async def _handle_listening(self, pcm_bytes: bytes):
        status, audio = self.vad.process_chunk(pcm_bytes)
        if status == "speaking":
            if self.state == "idle":
                self.state = "listening"
            if self.asr is None:
                self.asr = ASRSession(
                    on_partial=self._on_asr_partial,
                    on_final=self._on_asr_final,
                )
                await self.asr.start()
            await self.asr.send_audio(pcm_bytes)
        elif status == "utterance":
            if self.asr:
                await self.asr.end()
                self.asr = None

    def _handle_barge_in(self, pcm_bytes: bytes):
        rms = pcm_rms(pcm_bytes)
        self._barge_in_window.append(rms > BARGE_IN_ENERGY_THRESHOLD)
        if len(self._barge_in_window) > BARGE_IN_WINDOW_SIZE:
            self._barge_in_window.pop(0)
        if sum(self._barge_in_window) >= BARGE_IN_MIN_LOUD and not self._barge_in_triggered:
            log.info(f"Barge-in detected!")
            self._barge_in_triggered = True

    async def _on_asr_partial(self, text: str):
        """Send USER textOutput (partial transcription) - matches Nova Sonic format."""
        cn = self._next_content_name()
        await self.send_event({"event": {"contentStart": {
            "promptName": self.prompt_name, "contentName": cn,
            "type": "TEXT", "role": "USER",
        }}})
        await self.send_event({"event": {"textOutput": {
            "promptName": self.prompt_name, "contentName": cn,
            "content": text, "role": "USER",
        }}})
        await self.send_event({"event": {"contentEnd": {
            "promptName": self.prompt_name, "contentName": cn,
        }}})

    async def _on_asr_final(self, text: str):
        log.info(f"ASR final: {text}")
        # Send USER textOutput (final transcription)
        cn = self._next_content_name()
        await self.send_event({"event": {"contentStart": {
            "promptName": self.prompt_name, "contentName": cn,
            "type": "TEXT", "role": "USER",
        }}})
        await self.send_event({"event": {"textOutput": {
            "promptName": self.prompt_name, "contentName": cn,
            "content": text, "role": "USER",
        }}})
        await self.send_event({"event": {"contentEnd": {
            "promptName": self.prompt_name, "contentName": cn,
        }}})

        if not text.strip():
            self.state = "idle"
            return

        self.state = "busy"
        self.vad.reset()
        asyncio.create_task(self._process_response(text))

    async def _process_response(self, user_text: str):
        t0 = time.time()

        try:
            # --- LLM ---
            log.info(f"LLM start: '{user_text}'")
            full_response = []
            async for chunk in self.llm.generate_stream(user_text):
                full_response.append(chunk)
            response_text = "".join(full_response)
            log.info(f"LLM done ({time.time()-t0:.1f}s): '{response_text[:60]}'")

            if not response_text.strip():
                return

            # Send completionStart
            await self.send_event({"event": {"completionStart": {
                "promptName": self.prompt_name,
            }}})

            # Send ASSISTANT SPECULATIVE text (fast preview, same as Nova Sonic)
            cn_spec = self._next_content_name()
            await self.send_event({"event": {"contentStart": {
                "promptName": self.prompt_name, "contentName": cn_spec,
                "type": "TEXT", "role": "ASSISTANT",
                "additionalModelFields": '{"generationStage":"SPECULATIVE"}',
            }}})
            await self.send_event({"event": {"textOutput": {
                "promptName": self.prompt_name, "contentName": cn_spec,
                "content": response_text, "role": "ASSISTANT",
            }}})
            await self.send_event({"event": {"contentEnd": {
                "promptName": self.prompt_name, "contentName": cn_spec,
            }}})

            # Send ASSISTANT FINAL text (confirmed text, same as Nova Sonic)
            cn_final = self._next_content_name()
            await self.send_event({"event": {"contentStart": {
                "promptName": self.prompt_name, "contentName": cn_final,
                "type": "TEXT", "role": "ASSISTANT",
                "additionalModelFields": '{"generationStage":"FINAL"}',
            }}})
            await self.send_event({"event": {"textOutput": {
                "promptName": self.prompt_name, "contentName": cn_final,
                "content": response_text, "role": "ASSISTANT",
            }}})
            await self.send_event({"event": {"contentEnd": {
                "promptName": self.prompt_name, "contentName": cn_final,
            }}})

            # --- TTS ---
            log.info(f"TTS: '{response_text[:40]}...'")
            pcm_data, duration_ms = await self.tts.synthesize(response_text)
            if not pcm_data:
                log.error("TTS failed")
                return

            # Send ASSISTANT audio in chunks (matches Nova Sonic audioOutput)
            cn_audio = self._next_content_name()
            await self.send_event({"event": {"contentStart": {
                "promptName": self.prompt_name, "contentName": cn_audio,
                "type": "AUDIO", "role": "ASSISTANT",
            }}})

            # Send in ~100ms chunks (24000 * 2 * 0.1 = 4800 bytes per chunk)
            audio_chunk_size = OUTPUT_SAMPLE_RATE * 2 // 10  # 100ms
            for i in range(0, len(pcm_data), audio_chunk_size):
                chunk = pcm_data[i:i + audio_chunk_size]
                b64 = base64.b64encode(chunk).decode()
                await self.send_event({"event": {"audioOutput": {
                    "promptName": self.prompt_name, "contentName": cn_audio,
                    "content": b64,
                }}})

            await self.send_event({"event": {"contentEnd": {
                "promptName": self.prompt_name, "contentName": cn_audio,
            }}})

            audio_sent_at = time.time()
            log.info(f"Audio sent: {len(pcm_data)} bytes, {duration_ms}ms")

            # --- Wait for playback + barge-in ---
            await asyncio.sleep(0.2)
            self._barge_in_window = []
            self._barge_in_triggered = False
            self.state = "responding"

            remaining = (duration_ms / 1000.0) - (time.time() - audio_sent_at)
            elapsed = 0.0
            while elapsed < remaining:
                await asyncio.sleep(0.05)
                elapsed += 0.05
                if self._barge_in_triggered:
                    log.info("Barge-in → interrupt")
                    # Send interrupted signal (Nova Sonic format)
                    cn_int = self._next_content_name()
                    await self.send_event({"event": {"contentStart": {
                        "promptName": self.prompt_name, "contentName": cn_int,
                        "type": "TEXT", "role": "ASSISTANT",
                    }}})
                    await self.send_event({"event": {"textOutput": {
                        "promptName": self.prompt_name, "contentName": cn_int,
                        "content": '{ "interrupted" : true }', "role": "ASSISTANT",
                    }}})
                    await self.send_event({"event": {"contentEnd": {
                        "promptName": self.prompt_name, "contentName": cn_int,
                    }}})
                    break

            # Send usageEvent (approximate token counts)
            input_tokens = len(user_text) // 2  # rough estimate
            output_tokens = len(response_text) // 2
            await self.send_event({"event": {"usageEvent": {
                "promptName": self.prompt_name,
                "completionId": cn_spec,
                "totalInputTokens": input_tokens,
                "totalOutputTokens": output_tokens,
                "totalTokens": input_tokens + output_tokens,
            }}})

            await self.send_event({"event": {"completionEnd": {
                "promptName": self.prompt_name,
            }}})

            log.info(f"Pipeline complete ({time.time()-t0:.1f}s)")

        except Exception as e:
            log.error(f"Pipeline error: {e}", exc_info=True)
        finally:
            self._barge_in_triggered = False
            self._barge_in_window = []
            self.vad.reset()
            self.state = "idle"

    async def close(self):
        if self.asr:
            try:
                await self.asr.end()
            except Exception:
                pass
