"""WebRTC VAD."""
import time
import logging
import webrtcvad

log = logging.getLogger("vad")


class VoiceActivityDetector:
    def __init__(self, silence_ms=800, min_speech_ms=300, sample_rate=16000):
        self.silence_ms = silence_ms
        self.min_speech_ms = min_speech_ms
        self.sample_rate = sample_rate
        self.vad = webrtcvad.Vad(2)
        self.reset()

    def reset(self):
        self.state = "IDLE"
        self.speech_buffer = bytearray()
        self.speech_start_time = None
        self.last_speech_time = None
        self._ring = []
        self._ring_size = 8

    def process_chunk(self, pcm_bytes: bytes):
        now = time.time()
        frame_bytes = 160 * 2
        is_speech = False

        for i in range(0, len(pcm_bytes) - frame_bytes + 1, frame_bytes):
            frame = pcm_bytes[i:i + frame_bytes]
            if len(frame) == frame_bytes:
                try:
                    result = self.vad.is_speech(frame, self.sample_rate)
                except Exception:
                    result = False
                self._ring.append(result)
                if len(self._ring) > self._ring_size:
                    self._ring.pop(0)

        if self._ring:
            is_speech = sum(self._ring) / len(self._ring) > 0.5

        if self.state == "IDLE":
            if is_speech:
                self.state = "SPEAKING"
                self.speech_buffer = bytearray(pcm_bytes)
                self.speech_start_time = now
                self.last_speech_time = now
                return ("speaking", None)
            return ("idle", None)

        elif self.state == "SPEAKING":
            self.speech_buffer.extend(pcm_bytes)
            if is_speech:
                self.last_speech_time = now
            else:
                silence_elapsed = (now - self.last_speech_time) * 1000
                if silence_elapsed >= self.silence_ms:
                    speech_duration = (now - self.speech_start_time) * 1000
                    if speech_duration >= self.min_speech_ms:
                        audio = bytes(self.speech_buffer)
                        self.reset()
                        return ("utterance", audio)
                    else:
                        self.reset()
                        return ("idle", None)
            return ("speaking", None)

        return ("idle", None)
