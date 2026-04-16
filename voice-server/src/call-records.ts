import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.CALL_RECORDS_TABLE || "outbound-call-records";
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.DYNAMODB_REGION || process.env.AWS_REGION || "us-east-1" })
);

export class CallRecordManager {
  async createRecord(info: {
    callSid: string; streamSid: string; customerPhone: string;
    customerName: string; voiceId: string; projectId?: string;
  }) {
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          callSid: info.callSid,
          streamSid: info.streamSid,
          status: "active",
          customerPhone: info.customerPhone,
          customerName: info.customerName,
          voiceId: info.voiceId,
          startTime: new Date().toISOString(),
          transcript: [],
          turnCount: 0,
          project_id: info.projectId || "cantonese-default",
          provider: "cantonese-s2s",
        },
      }));
    } catch (e) {
      console.error("Failed to create call record:", e);
    }
  }

  async appendTranscript(callSid: string, role: string, text: string) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { callSid },
        UpdateExpression: "SET transcript = list_append(if_not_exists(transcript, :empty), :turn), turnCount = if_not_exists(turnCount, :zero) + :one",
        ExpressionAttributeValues: {
          ":turn": [{ role, text, timestamp: new Date().toISOString() }],
          ":empty": [],
          ":zero": 0,
          ":one": 1,
        },
      }));
    } catch (e) {
      console.error("Failed to append transcript:", e);
    }
  }

  async completeRecord(callSid: string, endReason: string) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { callSid },
        UpdateExpression: "SET #s = :status, endTime = :endTime, endReason = :reason",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":status": "completed",
          ":endTime": new Date().toISOString(),
          ":reason": endReason,
        },
      }));
    } catch (e) {
      console.error("Failed to complete call record:", e);
    }
  }
}
