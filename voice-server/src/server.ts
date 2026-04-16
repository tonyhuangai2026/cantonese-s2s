/**
 * Cantonese S2S voice-server.
 * Chime Voice Connector (SIP/RTP) → cantonese-s2s WebSocket bridge.
 *
 * Audio path:
 *   Chime → SIP INVITE → RTP (G.711 μ-law 8kHz)
 *   → decode μ-law → PCM 8kHz → upsample → PCM 16kHz
 *   → cantonese-s2s WebSocket (Nova Sonic protocol)
 *   → PCM 24kHz → downsample → PCM 8kHz → encode μ-law → RTP → Chime
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { EventEmitter } from "node:events";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { SipServer, type IncomingCallInfo } from "./sip";
import { type RtpSession } from "./sip";
import { S2SClient } from "./s2s-client";
import { CallRecordManager } from "./call-records";
import { logCall } from "./call-logger";
import { upsample8to16, downsample24to8 } from "./audio-utils";
import { MAX_CALL_DURATION_MS, FAREWELL_KEYWORDS, SYSTEM_PROMPT } from "./consts";

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_IP = process.env.PUBLIC_IP || "0.0.0.0";
const RTP_PORT_BASE = parseInt(process.env.RTP_PORT_BASE || "10000", 10);
const RTP_PORT_COUNT = parseInt(process.env.RTP_PORT_COUNT || "10000", 10);

// DynamoDB
const ddbClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.DYNAMODB_REGION || process.env.AWS_REGION || "us-east-1" })
);
const CUSTOMERS_TABLE = process.env.CUSTOMERS_TABLE || "outbound-customers";
const PROMPTS_TABLE = process.env.PROMPTS_TABLE || "outbound-prompts";
const callRecords = new CallRecordManager();

// Active sessions for monitoring
interface ActiveSession {
  callId: string;
  phone: string;
  name: string;
  startTime: string;
  emitter: EventEmitter;
}
const activeSessions = new Map<string, ActiveSession>();

// --- Customer/Prompt lookup ---
async function lookupCustomer(phone: string) {
  try {
    const result = await ddbClient.send(new QueryCommand({
      TableName: CUSTOMERS_TABLE,
      IndexName: "phone-index",
      KeyConditionExpression: "phone_number = :phone",
      ExpressionAttributeValues: { ":phone": phone },
      Limit: 1,
    }));
    if (result.Items && result.Items.length > 0) return result.Items[0];
  } catch (_) {}
  return null;
}

async function lookupPrompt(promptId: string) {
  try {
    const result = await ddbClient.send(new GetCommand({
      TableName: PROMPTS_TABLE,
      Key: { prompt_id: promptId },
    }));
    return result.Item || null;
  } catch (_) {}
  return null;
}

// --- SIP Server ---
const sipServer = new SipServer({
  publicIp: PUBLIC_IP,
  sipPort: 5060,
  rtpPortBase: RTP_PORT_BASE,
  rtpPortCount: RTP_PORT_COUNT,
});

sipServer.onIncomingCall(async (call: IncomingCallInfo) => {
  const { callId, callerPhone, rtpSession } = call;
  console.log(`[CALL] Incoming: ${callerPhone}, callId=${callId}`);

  // Lookup customer
  const customer = await lookupCustomer(callerPhone);
  const customerName = customer?.customer_name || "Unknown";
  const promptId = customer?.prompt_id;
  const projectId = customer?.project_id;

  // Lookup prompt
  let systemPrompt = SYSTEM_PROMPT;
  if (promptId) {
    const promptConfig = await lookupPrompt(promptId);
    if (promptConfig?.prompt_content) {
      systemPrompt = promptConfig.prompt_content
        .replace(/\{\{customer_name\}\}/g, customerName)
        .replace(/\{\{notes\}\}/g, customer?.notes || "");
    }
  }

  // Create call record
  await callRecords.createRecord({
    callSid: callId,
    streamSid: callId,
    customerPhone: callerPhone,
    customerName,
    voiceId: process.env.VOICE_ID || "Cantonese_ProfessionalHost（F)",
    projectId,
  });
  await logCall(callId, "info", "call-started", `Incoming from ${callerPhone}`);

  // Track active session
  const emitter = new EventEmitter();
  activeSessions.set(callId, {
    callId, phone: callerPhone, name: customerName,
    startTime: new Date().toISOString(), emitter,
  });

  // Max call timer
  const callTimer = setTimeout(() => {
    console.log(`[CALL] Max duration reached: ${callId}`);
    endCall(callId, "max-duration");
  }, MAX_CALL_DURATION_MS);

  let farewell = false;
  let s2sClient: S2SClient;

  const endCall = async (id: string, reason: string) => {
    clearTimeout(callTimer);
    activeSessions.delete(id);
    if (s2sClient) await s2sClient.close();
    sipServer.endCall(id);
    await callRecords.completeRecord(id, reason);
    await logCall(id, "info", "call-ended", reason);
    console.log(`[CALL] Ended: ${id}, reason=${reason}`);
  };

  // Connect to cantonese-s2s
  s2sClient = new S2SClient({
    onUserText: (text) => {
      console.log(`[ASR] User: ${text}`);
      callRecords.appendTranscript(callId, "USER", text);
      emitter.emit("transcript", { role: "USER", text });
      logCall(callId, "debug", "user-utterance", text);
    },
    onAssistantText: (text, stage) => {
      if (stage === "FINAL" || stage === "") {
        console.log(`[LLM] Assistant: ${text}`);
        callRecords.appendTranscript(callId, "ASSISTANT", text);
        emitter.emit("transcript", { role: "ASSISTANT", text });
        logCall(callId, "debug", "assistant-response", text);

        if (FAREWELL_KEYWORDS.some(kw => text.toLowerCase().includes(kw))) {
          farewell = true;
        }
      }
    },
    onAudioOutput: (pcm24kBase64) => {
      // 24kHz → 8kHz → RTP
      const pcm24k = Buffer.from(pcm24kBase64, "base64");
      const pcm8k = downsample24to8(pcm24k);
      rtpSession.sendAudio(pcm8k);
    },
    onError: (err) => {
      console.error(`[S2S] Error: ${err.message}`);
      logCall(callId, "error", "s2s-error", err.message);
    },
    onComplete: () => {
      if (farewell) {
        setTimeout(() => endCall(callId, "farewell"), 2000);
      }
    },
  });

  try {
    await s2sClient.connect(systemPrompt);
    console.log(`[S2S] Connected for call ${callId}`);
  } catch (e: any) {
    console.error(`[S2S] Connect failed: ${e.message}`);
    logCall(callId, "error", "s2s-connect-failed", e.message);
    endCall(callId, "s2s-connect-failed");
    return;
  }

  // RTP audio → S2S
  rtpSession.onAudioReceived((pcm8k: Buffer) => {
    const pcm16k = upsample8to16(pcm8k);
    s2sClient.sendAudio(pcm16k.toString("base64"));
  });
  (rtpSession as any)._s2sClient = s2sClient;
});

sipServer.onCallEnded(async (callId, reason) => {
  console.log(`[SIP] Call ended: ${callId}, reason=${reason}`);
  const session = activeSessions.get(callId);
  if (session) {
    activeSessions.delete(callId);
    await callRecords.completeRecord(callId, reason);
    await logCall(callId, "info", "call-ended", reason);
  }
});

// --- HTTP API (monitoring) ---
const app = Fastify({ logger: false });
app.register(cors, { origin: true });

app.get("/health", async () => ({
  status: "ok",
  service: "cantonese-s2s-voice-server",
  activeCalls: activeSessions.size,
}));

app.get("/api/active-calls", async () =>
  Array.from(activeSessions.values()).map(s => ({
    callSid: s.callId, phone: s.phone, name: s.name, startTime: s.startTime,
  }))
);

app.get<{ Params: { callSid: string } }>("/api/live-transcript/:callSid", async (req, reply) => {
  const session = activeSessions.get(req.params.callSid);
  if (!session) { reply.code(404).send({ error: "Not found" }); return; }
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const handler = (data: any) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  session.emitter.on("transcript", handler);
  req.raw.on("close", () => session.emitter.off("transcript", handler));
});

// --- Start ---
async function main() {
  await sipServer.start();
  console.log(`[SIP] Server ready on UDP port 5060, RTP ports ${RTP_PORT_BASE}-${RTP_PORT_BASE + RTP_PORT_COUNT}`);

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[HTTP] API ready on port ${PORT}`);
}

process.on("SIGTERM", async () => {
  console.log("SIGTERM, shutting down...");
  sipServer.stop();
  for (const [id] of activeSessions) {
    await callRecords.completeRecord(id, "server-shutdown");
  }
  process.exit(0);
});

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
