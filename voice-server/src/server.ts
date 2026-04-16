import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mulaw } from "alawmulaw";
import { S2SClient } from "./s2s-client";
import { CallRecordManager } from "./call-records";
import { logCall } from "./call-logger";
import { upsample8to16, downsample24to8 } from "./audio-utils";
import { MAX_CALL_DURATION_MS, FAREWELL_KEYWORDS } from "./consts";

const PORT = parseInt(process.env.PORT || "3000", 10);
const callRecords = new CallRecordManager();

// Track active calls for monitoring
const activeCalls = new Map<string, { phone: string; name: string; startTime: string; emitter: EventEmitter }>();

const app = Fastify({ logger: true });
app.register(fastifyFormBody);
app.register(fastifyWs);
app.register(cors, { origin: true });

// Health check
app.get("/health", async () => ({ status: "ok", service: "cantonese-s2s-voice-server" }));

// Active calls API (for monitoring)
app.get("/api/active-calls", async () => {
  return Array.from(activeCalls.entries()).map(([callSid, info]) => ({
    callSid, phone: info.phone, name: info.name, startTime: info.startTime,
  }));
});

// SSE live transcript (for monitoring)
app.get("/api/live-transcript/:callSid", async (req, reply) => {
  const { callSid } = req.params as { callSid: string };
  const call = activeCalls.get(callSid);
  if (!call) { reply.code(404).send({ error: "Call not found" }); return; }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const handler = (data: any) => {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  call.emitter.on("transcript", handler);
  req.raw.on("close", () => call.emitter.off("transcript", handler));
});

// Twilio incoming call webhook (TwiML)
app.post("/voice-income", async (req, reply) => {
  const body = req.body as any;
  const callSid = body.CallSid || randomUUID();
  const from = body.From || "unknown";

  console.log(`[CALL] Incoming from ${from}, callSid=${callSid}`);

  const wsUrl = `wss://${req.headers.host}/media-stream`;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="customerPhone" value="${from}" />
    </Stream>
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// Outbound call API
app.post("/api/call", async (req, reply) => {
  // Placeholder for outbound call via Twilio/Chime
  // Similar to voice-agent-platform's implementation
  reply.send({ status: "not_implemented", message: "Use voice-agent-platform for outbound calls" });
});

// WebSocket media stream handler (Twilio compatible)
app.register(async function (fastify) {
  fastify.get("/media-stream", { websocket: true }, (socket, req) => {
    console.log("[WS] Twilio media stream connected");

    let callSid = "";
    let streamSid = "";
    let s2sClient: S2SClient | null = null;
    let callTimer: NodeJS.Timeout | null = null;
    let farewell = false;
    const emitter = new EventEmitter();
    const conversationHistory: { role: string; text: string }[] = [];

    const cleanup = async (reason: string) => {
      console.log(`[CALL] Cleanup: ${reason}, callSid=${callSid}`);
      if (callTimer) clearTimeout(callTimer);
      activeCalls.delete(callSid);
      if (s2sClient) await s2sClient.close();
      if (callSid) {
        await callRecords.completeRecord(callSid, reason);
        await logCall(callSid, "info", "call-ended", reason);
      }
    };

    socket.on("close", () => cleanup("client-disconnected"));
    socket.on("error", (err) => {
      console.error("[WS] Error:", err.message);
      cleanup("ws-error");
    });

    socket.on("message", async (rawData: Buffer) => {
      try {
        const data = JSON.parse(rawData.toString());

        switch (data.event) {
          case "connected":
            console.log("[WS] Connected event");
            break;

          case "start": {
            callSid = data.start?.callSid || randomUUID();
            streamSid = data.start?.streamSid || "";
            const customerPhone = data.start?.customParameters?.customerPhone || "unknown";
            const customerName = data.start?.customParameters?.customerName || "Unknown";
            const voiceId = data.start?.customParameters?.voiceId || process.env.VOICE_ID || "Cantonese_ProfessionalHost（F)";
            const projectId = data.start?.customParameters?.projectId;

            console.log(`[CALL] Start: callSid=${callSid}, phone=${customerPhone}`);

            // Create call record
            await callRecords.createRecord({
              callSid, streamSid, customerPhone, customerName, voiceId, projectId,
            });
            await logCall(callSid, "info", "call-started", `Incoming from ${customerPhone}`);

            // Track active call
            activeCalls.set(callSid, {
              phone: customerPhone, name: customerName,
              startTime: new Date().toISOString(), emitter,
            });

            // Max call timer
            callTimer = setTimeout(() => {
              console.log(`[CALL] Max duration reached, hanging up`);
              cleanup("max-duration");
              socket.close();
            }, MAX_CALL_DURATION_MS);

            // Connect to cantonese-s2s
            s2sClient = new S2SClient({
              onUserText: (text) => {
                console.log(`[ASR] User: ${text}`);
                conversationHistory.push({ role: "USER", text });
                callRecords.appendTranscript(callSid, "USER", text);
                emitter.emit("transcript", { role: "USER", text });
                logCall(callSid, "debug", "user-utterance", text);
              },
              onAssistantText: (text, stage) => {
                if (stage === "FINAL" || stage === "") {
                  console.log(`[LLM] Assistant: ${text}`);
                  conversationHistory.push({ role: "ASSISTANT", text });
                  callRecords.appendTranscript(callSid, "ASSISTANT", text);
                  emitter.emit("transcript", { role: "ASSISTANT", text });
                  logCall(callSid, "debug", "assistant-response", text);

                  // Check farewell
                  const lower = text.toLowerCase();
                  if (FAREWELL_KEYWORDS.some((kw) => lower.includes(kw))) {
                    farewell = true;
                  }
                }
              },
              onAudioOutput: (pcm24kBase64) => {
                // Downsample 24kHz → 8kHz, encode to mulaw, send to Twilio
                const pcm24k = Buffer.from(pcm24kBase64, "base64");
                const pcm8k = downsample24to8(pcm24k);
                const pcmSamples = new Int16Array(pcm8k.buffer, pcm8k.byteOffset, pcm8k.length / 2);
                const mulawSamples = mulaw.encode(pcmSamples);
                const payload = Buffer.from(mulawSamples).toString("base64");

                if (socket.readyState === 1) {
                  socket.send(JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload },
                  }));
                }
              },
              onError: (err) => {
                console.error(`[S2S] Error: ${err.message}`);
                logCall(callSid, "error", "s2s-error", err.message);
              },
              onComplete: () => {
                console.log("[S2S] Session complete");
                if (farewell) {
                  setTimeout(() => {
                    cleanup("farewell");
                    socket.close();
                  }, 2000);
                }
              },
            });

            try {
              await s2sClient.connect();
              console.log("[S2S] Session ready");
            } catch (e: any) {
              console.error("[S2S] Connect failed:", e.message);
              await logCall(callSid, "error", "s2s-connect-failed", e.message);
              cleanup("s2s-connect-failed");
              socket.close();
              return;
            }
            break;
          }

          case "media": {
            if (!s2sClient) break;
            // Twilio sends mulaw 8kHz base64
            const audioInput = Buffer.from(data.media.payload, "base64");
            const pcmSamples = mulaw.decode(audioInput);
            const pcm8k = Buffer.from(pcmSamples.buffer);
            // Upsample 8kHz → 16kHz for cantonese-s2s
            const pcm16k = upsample8to16(pcm8k);
            const b64 = pcm16k.toString("base64");
            s2sClient.sendAudio(b64);
            break;
          }

          case "stop":
            console.log("[WS] Stop event");
            await cleanup("twilio-stop");
            break;
        }
      } catch (e: any) {
        console.error("[WS] Message error:", e.message);
      }
    });
  });
});

// Chime SIP Media Application WebSocket handler (future)
// Chime sends audio differently - can be added as another WebSocket route

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down...");
  for (const [callSid] of activeCalls) {
    await callRecords.completeRecord(callSid, "server-shutdown");
  }
  process.exit(0);
});

app.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Cantonese S2S voice-server running on port ${PORT}`);
});
