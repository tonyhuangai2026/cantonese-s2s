"""
WebSocket server with Nova Sonic v2 compatible protocol.

Accepts the same event format as Bedrock's invoke_model_with_bidirectional_stream.
Internally uses: Transcribe (ASR) + Nova 2 Lite (LLM) + MiniMax (TTS).

Client sends:
  sessionStart → promptStart → contentStart(SYSTEM/TEXT) → textInput → contentEnd
  → contentStart(USER/AUDIO) → audioInput... → contentEnd → promptEnd → sessionEnd

Server sends (same format as Nova Sonic v2):
  contentStart(USER/TEXT) → textOutput(USER) → contentEnd          # ASR transcription
  completionStart → contentStart(ASSISTANT/TEXT) → textOutput → contentEnd  # LLM text
  contentStart(ASSISTANT/AUDIO) → audioOutput... → contentEnd      # TTS audio
  completionEnd
  sessionEnd
"""
import asyncio
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pipeline import ConversationPipeline
from config import HOST, PORT

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
log = logging.getLogger("server")

app = FastAPI(title="Cantonese S2S (Nova Sonic Compatible)")


@app.websocket("/ws")
@app.websocket("/v1/s2s")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    log.info("Client connected")

    pipeline = None
    prompt_name = None
    system_prompt_text = None

    async def send_event(event_dict: dict):
        try:
            await ws.send_text(json.dumps(event_dict, ensure_ascii=False))
        except Exception:
            pass

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if "event" not in msg:
                continue

            evt = msg["event"]

            # --- sessionStart ---
            if "sessionStart" in evt:
                log.info("Session started")
                # Config is in evt["sessionStart"]["inferenceConfiguration"]
                # We can extract maxTokens, etc. if needed
                continue

            # --- promptStart ---
            if "promptStart" in evt:
                prompt_name = evt["promptStart"].get("promptName", "default")
                # audioOutputConfiguration tells us desired output format
                # We'll output audio/lpcm 24kHz 16bit mono to match Nova Sonic
                log.info(f"Prompt started: {prompt_name}")
                continue

            # --- contentStart ---
            if "contentStart" in evt:
                cs = evt["contentStart"]
                role = cs.get("role", "")
                content_type = cs.get("type", "")
                content_name = cs.get("contentName", "")

                if role == "SYSTEM" and content_type == "TEXT":
                    system_prompt_text = ""  # will be filled by textInput
                elif role == "USER" and content_type == "AUDIO":
                    # Start pipeline if not exists
                    if pipeline is None:
                        pipeline = ConversationPipeline(send_event, prompt_name or "default")
                        log.info("Pipeline created")
                continue

            # --- textInput ---
            if "textInput" in evt:
                text = evt["textInput"].get("content", "")
                if system_prompt_text is not None:
                    system_prompt_text = text
                    # We could override the system prompt here
                    log.info(f"System prompt received: {text[:60]}...")
                continue

            # --- audioInput ---
            if "audioInput" in evt:
                audio_b64 = evt["audioInput"].get("content", "")
                if pipeline and audio_b64:
                    await pipeline.handle_audio_chunk(audio_b64)
                continue

            # --- contentEnd ---
            if "contentEnd" in evt:
                if system_prompt_text is not None:
                    system_prompt_text = None  # done reading system prompt
                continue

            # --- promptEnd ---
            if "promptEnd" in evt:
                log.info("Prompt ended")
                continue

            # --- sessionEnd ---
            if "sessionEnd" in evt:
                log.info("Session ended by client")
                await send_event({"event": {"sessionEnd": {}}})
                break

    except WebSocketDisconnect:
        log.info("Client disconnected")
    except Exception as e:
        log.error(f"WebSocket error: {e}", exc_info=True)
    finally:
        if pipeline:
            await pipeline.close()


@app.get("/health")
async def health():
    return {"status": "ok", "service": "cantonese-s2s"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
