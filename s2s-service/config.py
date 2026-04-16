"""Configuration."""
import os

# AWS
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.amazon.nova-2-lite-v1:0")
TRANSCRIBE_LANGUAGE = os.environ.get("TRANSCRIBE_LANGUAGE", "zh-HK")

# MiniMax TTS
MINIMAX_API_KEY = os.environ.get("MINIMAX_API_KEY", "")
MINIMAX_TTS_URL = "https://api.minimax.chat/v1/t2a_v2"
MINIMAX_TTS_MODEL = os.environ.get("MINIMAX_TTS_MODEL", "speech-2.8-turbo")
MINIMAX_VOICE_ID = os.environ.get("MINIMAX_VOICE_ID", "Cantonese_ProfessionalHost（F)")
MINIMAX_LANGUAGE_BOOST = os.environ.get("MINIMAX_LANGUAGE_BOOST", "Chinese,Yue")

# Audio
INPUT_SAMPLE_RATE = 16000
OUTPUT_SAMPLE_RATE = 24000  # Match Nova Sonic output format
CHANNELS = 1
SAMPLE_WIDTH = 2

# VAD
VAD_SILENCE_MS = int(os.environ.get("VAD_SILENCE_MS", "800"))
VAD_MIN_SPEECH_MS = int(os.environ.get("VAD_MIN_SPEECH_MS", "300"))

# Barge-in
BARGE_IN_ENERGY_THRESHOLD = int(os.environ.get("BARGE_IN_ENERGY_THRESHOLD", "300"))
BARGE_IN_WINDOW_SIZE = 8
BARGE_IN_MIN_LOUD = 3

# LLM
SYSTEM_PROMPT = os.environ.get("SYSTEM_PROMPT",
    "你是一个粤语语音助手。用户会用粤语同你对话，请用地道的粤语回答。"
    "每次回答最多两句话，绝对唔好超过三句。越短越好。"
    "用口语，唔好用书面语。唔好用括号解释。"
    "唔好用 emoji 或者 markdown 格式。"
)

# Server
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8765"))
