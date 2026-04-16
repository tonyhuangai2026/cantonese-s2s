export const S2S_ENDPOINT = process.env.S2S_ENDPOINT || "ws://localhost:8765/v1/s2s";

export const DefaultInferenceConfig = {
  maxTokens: parseInt(process.env.MAX_TOKENS || "1024", 10),
  topP: parseFloat(process.env.TOP_P || "0.9"),
  temperature: parseFloat(process.env.TEMPERATURE || "0.7"),
};

// Chime/Twilio audio: PCM 16bit 8kHz mono
export const PhoneAudioConfig = {
  audioType: "SPEECH" as const,
  encoding: "base64",
  mediaType: "audio/lpcm" as const,
  sampleRateHertz: 8000,
  sampleSizeBits: 16,
  channelCount: 1,
};

// S2S service input: PCM 16bit 16kHz mono
export const S2SInputAudioConfig = {
  ...PhoneAudioConfig,
  sampleRateHertz: 16000,
};

// S2S service output: PCM 16bit 24kHz mono
export const S2SOutputAudioConfig = {
  ...PhoneAudioConfig,
  sampleRateHertz: 24000,
};

export const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  "你是一个粤语语音助手。用户会用粤语同你对话，请用地道的粤语回答。" +
  "每次回答最多两句话，越短越好。用口语，唔好用书面语。唔好用括号解释。";

export const MAX_CALL_DURATION_MS = parseInt(process.env.MAX_CALL_DURATION_MS || "1200000", 10);

export const FAREWELL_KEYWORDS = ["拜拜", "再見", "再见", "唔該晒", "多謝", "bye", "goodbye"];
