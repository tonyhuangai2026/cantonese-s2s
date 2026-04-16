export interface InferenceConfig {
  maxTokens: number;
  topP: number;
  temperature: number;
}

export type ContentType = "AUDIO" | "TEXT" | "TOOL";
export type AudioMediaType = "audio/lpcm";
export type TextMediaType = "text/plain" | "application/json";

export interface AudioConfig {
  audioType: "SPEECH";
  mediaType: AudioMediaType;
  sampleRateHertz: number;
  sampleSizeBits: number;
  channelCount: number;
  encoding: string;
  voiceId?: string;
}

export interface S2SEvent {
  event: Record<string, any>;
}

export interface CallInfo {
  callSid: string;
  streamSid: string;
  customerPhone: string;
  customerName: string;
  voiceId: string;
  startTime: string;
  projectId?: string;
}
