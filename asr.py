"""Amazon Transcribe streaming ASR."""
import asyncio
from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler
from amazon_transcribe.model import TranscriptEvent
from config import AWS_REGION, TRANSCRIBE_LANGUAGE, INPUT_SAMPLE_RATE


class TranscribeHandler(TranscriptResultStreamHandler):
    def __init__(self, stream, on_partial, on_final):
        super().__init__(stream)
        self._on_partial = on_partial
        self._on_final = on_final

    async def handle_transcript_event(self, evt: TranscriptEvent):
        for result in evt.transcript.results:
            for alt in result.alternatives:
                text = alt.transcript.strip()
                if not text:
                    continue
                if result.is_partial:
                    await self._on_partial(text)
                else:
                    await self._on_final(text)


class ASRSession:
    def __init__(self, on_partial, on_final):
        self.on_partial = on_partial
        self.on_final = on_final
        self._stream = None
        self._handler_task = None
        self._client = TranscribeStreamingClient(region=AWS_REGION)

    async def start(self):
        self._stream = await self._client.start_stream_transcription(
            language_code=TRANSCRIBE_LANGUAGE,
            media_sample_rate_hz=INPUT_SAMPLE_RATE,
            media_encoding="pcm",
        )
        handler = TranscribeHandler(self._stream.output_stream, self.on_partial, self.on_final)
        self._handler_task = asyncio.create_task(handler.handle_events())

    async def send_audio(self, pcm_bytes: bytes):
        if self._stream:
            await self._stream.input_stream.send_audio_event(audio_chunk=pcm_bytes)

    async def end(self):
        if self._stream:
            await self._stream.input_stream.end_stream()
        if self._handler_task:
            await self._handler_task
            self._handler_task = None
        self._stream = None
