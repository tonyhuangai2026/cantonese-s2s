import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.CALL_LOGS_TABLE || "call-logs";
const TTL_DAYS = 30;
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.DYNAMODB_REGION || process.env.AWS_REGION || "us-east-1" })
);

export async function logCall(
  callSid: string,
  level: "info" | "warn" | "error" | "debug",
  event: string,
  message: string,
  metadata?: Record<string, any>
) {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        callSid,
        timestamp: new Date().toISOString(),
        level,
        event,
        message,
        metadata,
        ttl: Math.floor(Date.now() / 1000) + TTL_DAYS * 86400,
      },
    }));
  } catch (e) {
    // Don't let logging failures break calls
  }
}
