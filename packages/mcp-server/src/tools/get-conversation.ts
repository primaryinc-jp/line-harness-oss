import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";

export function registerGetConversation(server: McpServer): void {
  server.tool(
    "get_conversation",
    "Get message history for a specific friend (both incoming and outgoing), or for a group/room target when targetType+targetId are given. Each message has a `source` field (user/broadcast/scenario/auto_reply/reminder/manual) indicating origin. Group messages include senderLineUserId/senderDisplayName for the member who spoke.",
    {
      friendId: z
        .string()
        .optional()
        .describe("Friend ID (from list_friends or list_conversations). Omit when using targetType+targetId."),
      targetType: z
        .enum(["group", "room"])
        .optional()
        .describe("Set together with targetId to read a group/room conversation instead of a friend's."),
      targetId: z
        .string()
        .optional()
        .describe("Group/room target ID (from manage_targets list)."),
      limit: z
        .number()
        .default(50)
        .describe("Number of messages to return (max 200)"),
      before: z
        .string()
        .optional()
        .describe("Return messages before this timestamp (ISO8601, for pagination)"),
      beforeId: z
        .string()
        .optional()
        .describe(
          "Id of the oldest message from the previous page (pass together with its createdAt as `before`). Group/room messages can share a timestamp; the composite cursor prevents skipping ties across pages.",
        ),
      lineAccountId: z
        .string()
        .optional()
        .describe(
          "For a group/room conversation: assert the owning LINE account (409 if the target moved accounts). Defaults to LINE_HARNESS_ACCOUNT_ID.",
        ),
    },
    async ({ friendId, targetType, targetId, limit, before, beforeId, lineAccountId }) => {
      try {
        const client = getClient();
        // Same exactly-one destination contract as send_message: ambiguous or
        // partial input fails instead of silently reading another conversation.
        const hasTarget = Boolean(targetType || targetId);
        if (friendId && hasTarget) {
          throw new Error(
            "Specify exactly one conversation: either friendId OR targetType+targetId, not both",
          );
        }
        if (hasTarget && !(targetType && targetId)) {
          throw new Error("targetType and targetId must both be provided to read a group/room conversation");
        }
        if (targetType && targetId) {
          const targetResult = await client.targets.getConversation(targetType, targetId, { limit, before, beforeId, lineAccountId });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: true, ...targetResult }, null, 2),
              },
            ],
          };
        }
        if (!friendId) {
          throw new Error("A conversation is required: friendId, or targetType+targetId");
        }
        const result = await client.conversations.get({ friendId, limit, before });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, ...result }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: String(error) }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
