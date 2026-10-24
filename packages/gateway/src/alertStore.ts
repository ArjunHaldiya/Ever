import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AlertKey, AlertStore } from "./alerts";

/** DynamoDB-backed AlertStore. Alerts table key: alertId + phoneHash. */

const SENT_TTL_S = 7 * 24 * 60 * 60;

function isConditionFailure(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

export function makeAlertStore(ddb: DynamoDBDocumentClient, prefix: string): AlertStore {
  const alerts = `${prefix}Alerts`;
  const processed = `${prefix}Processed`;
  const sentKey = (messageId: string) => `sent:${messageId}`;

  /** SET a timestamp field only if it is empty, so the first observation wins. */
  const setOnce = async (key: AlertKey, field: "deliveredAt" | "readAt", at: Date) => {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: alerts,
          Key: key,
          UpdateExpression: `SET ${field} = :t`,
          ConditionExpression: `attribute_exists(alertId) AND (attribute_not_exists(${field}) OR ${field} = :nul)`,
          ExpressionAttributeValues: { ":t": at.toISOString(), ":nul": null },
        }),
      );
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
    }
  };

  return {
    markSent: async (key, messageId, at) => {
      await ddb.send(
        new UpdateCommand({
          TableName: alerts,
          Key: key,
          UpdateExpression: "SET sentAt = :t, messageId = :m, #e = :nul",
          ExpressionAttributeNames: { "#e": "error" },
          ExpressionAttributeValues: { ":t": at.toISOString(), ":m": messageId, ":nul": null },
        }),
      );
      await ddb.send(
        new PutCommand({
          TableName: processed,
          Item: {
            messageId: sentKey(messageId),
            alertId: key.alertId,
            phoneHash: key.phoneHash,
            ttl: Math.floor(Date.now() / 1000) + SENT_TTL_S,
          },
        }),
      );
    },
    markDelivered: (key, at) => setOnce(key, "deliveredAt", at),
    markRead: async (key, at) => {
      await setOnce(key, "readAt", at);
      await setOnce(key, "deliveredAt", at); // a message that was read was delivered
    },
    markError: async (key, error) => {
      await ddb.send(
        new UpdateCommand({
          TableName: alerts,
          Key: key,
          UpdateExpression: "SET #e = :e",
          ConditionExpression: "attribute_exists(alertId)",
          ExpressionAttributeNames: { "#e": "error" },
          ExpressionAttributeValues: { ":e": error },
        }),
      ).catch((err) => {
        if (!isConditionFailure(err)) throw err;
      });
    },
    lookupSent: async (messageId) => {
      const out = await ddb.send(new GetCommand({ TableName: processed, Key: { messageId: sentKey(messageId) } }));
      return out.Item?.alertId && out.Item?.phoneHash
        ? { alertId: String(out.Item.alertId), phoneHash: String(out.Item.phoneHash) }
        : null;
    },
  };
}

