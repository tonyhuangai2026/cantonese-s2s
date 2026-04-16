/**
 * WebSocket client for cantonese-s2s service.
 * Sends/receives Nova Sonic v2 compatible events over standard WebSocket.
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  S2S_ENDPOINT, DefaultInferenceConfig, S2SInputAudioConfig,
  S2SOutputAudioConfig, SYSTEM_PROMPT,
} from "./consts";

export interface S2SSessionHandlers {
  onUserText?: (text: string) => void;
  onAssistantText?: (text: string, stage: string) => void;
  onAudioOutput?: (pcmBase64: string) => void;
  onError?: (err: Error) => void;
  onComplete?: () => void;
}

export class S2SClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private promptName: string;
  private audioContentName: string;
  private isActive = false;
  private handlers: S2SSessionHandlers;
  private currentRole = "";
  private currentStage = "";

  constructor(handlers: S2SSessionHandlers) {
    super();
    this.handlers = handlers;
    this.promptName = randomUUID();
    this.audioContentName = randomUUID();
  }

  async connect(systemPrompt?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const endpoint = S2S_ENDPOINT;
      console.log(`[S2S] Connecting to ${endpoint}`);
      this.ws = new WebSocket(endpoint);

      this.ws.on("open", async () => {
        console.log("[S2S] Connected");
        this.isActive = true;
        try {
          await this.initSession(systemPrompt || SYSTEM_PROMPT);
          resolve();
        } catch (e) {
          reject(e);
        }
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleEvent(msg);
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on("error", (err) => {
        console.error("[S2S] WebSocket error:", err.message);
        this.handlers.onError?.(err);
      });

      this.ws.on("close", () => {
        console.log("[S2S] Disconnected");
        this.isActive = false;
        this.handlers.onComplete?.();
      });

      setTimeout(() => reject(new Error("S2S connection timeout")), 10000);
    });
  }

  private async initSession(systemPrompt: string) {
    const pn = this.promptName;
    const sysCn = randomUUID();

    // 1. sessionStart
    this.send({ event: { sessionStart: { inferenceConfiguration: DefaultInferenceConfig } } });

    // 2. promptStart
    this.send({ event: { promptStart: {
      promptName: pn,
      textOutputConfiguration: { mediaType: "text/plain" },
      audioOutputConfiguration: {
        ...S2SOutputAudioConfig,
        voiceId: process.env.MINIMAX_VOICE_ID || "Cantonese_ProfessionalHost（F)",
        encoding: "base64",
      },
    }}});

    // 3. System prompt
    this.send({ event: { contentStart: {
      promptName: pn, contentName: sysCn,
      type: "TEXT", interactive: false, role: "SYSTEM",
      textInputConfiguration: { mediaType: "text/plain" },
    }}});
    this.send({ event: { textInput: {
      promptName: pn, contentName: sysCn, content: systemPrompt,
    }}});
    this.send({ event: { contentEnd: { promptName: pn, contentName: sysCn } } });

    // 4. Audio content start (stays open for streaming)
    this.send({ event: { contentStart: {
      promptName: pn, contentName: this.audioContentName,
      type: "AUDIO", interactive: true, role: "USER",
      audioInputConfiguration: { ...S2SInputAudioConfig, encoding: "base64" },
    }}});
  }

  /** Send PCM 16kHz audio chunk (already resampled) as base64 */
  sendAudio(pcm16kBase64: string) {
    if (!this.isActive) return;
    this.send({ event: { audioInput: {
      promptName: this.promptName,
      contentName: this.audioContentName,
      content: pcm16kBase64,
    }}});
  }

  private handleEvent(msg: any) {
    if (!msg.event) return;
    const evt = msg.event;
    const key = Object.keys(evt)[0];

    switch (key) {
      case "contentStart": {
        const cs = evt.contentStart;
        this.currentRole = cs.role || "";
        if (cs.additionalModelFields) {
          try {
            const fields = JSON.parse(cs.additionalModelFields);
            this.currentStage = fields.generationStage || "";
          } catch { this.currentStage = ""; }
        } else {
          this.currentStage = "";
        }
        break;
      }
      case "textOutput": {
        const text = evt.textOutput.content || "";
        const role = evt.textOutput.role || this.currentRole;
        if (role === "USER") {
          this.handlers.onUserText?.(text);
        } else if (role === "ASSISTANT") {
          this.handlers.onAssistantText?.(text, this.currentStage);
        }
        break;
      }
      case "audioOutput": {
        const content = evt.audioOutput.content || "";
        if (content) {
          this.handlers.onAudioOutput?.(content);
        }
        break;
      }
      case "completionStart":
      case "completionEnd":
      case "contentEnd":
      case "usageEvent":
        // Informational, no action needed
        break;
      case "sessionEnd":
        this.isActive = false;
        this.handlers.onComplete?.();
        break;
      default:
        console.log(`[S2S] Unknown event: ${key}`);
    }
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  async close() {
    if (!this.isActive) return;
    this.isActive = false;
    try {
      this.send({ event: { contentEnd: {
        promptName: this.promptName, contentName: this.audioContentName,
      }}});
      this.send({ event: { promptEnd: { promptName: this.promptName } } });
      this.send({ event: { sessionEnd: {} } });
      this.ws?.close();
    } catch (e) {
      // ignore close errors
    }
  }
}
