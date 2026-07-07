import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";
import { autoTrackUrls } from "./auto-track-urls.js";

export function registerSendMessage(server: McpServer): void {
  server.tool(
    "send_message",
    "Send a text, image, or flex message to a specific friend, or to a group/room target when targetType+targetId are given. Use messageType 'image' for standalone image messages, 'flex' for rich card layouts.",
    {
      friendId: z
        .string()
        .optional()
        .describe("The friend's ID to send the message to. Omit when using targetType+targetId."),
      targetType: z
        .enum(["group", "room"])
        .optional()
        .describe("Set together with targetId to send to a group/room instead of a friend."),
      targetId: z
        .string()
        .optional()
        .describe("Group/room target ID (from manage_targets list)."),
      content: z
        .string()
        .describe(
          "Message content. For text: plain string. For image: JSON string with originalContentUrl and previewImageUrl (both HTTPS URLs). For flex: JSON string of LINE Flex Message.",
        ),
      messageType: z
        .enum(["text", "image", "flex"])
        .default("text")
        .describe(
          "Message type: 'text' for plain text, 'image' for standalone image, 'flex' for Flex Message JSON",
        ),
      altText: z
        .string()
        .optional()
        .describe(
          "Custom notification preview text for Flex Messages (shown on lock screen). If omitted, auto-extracted from Flex content.",
        ),
      isTest: z
        .boolean()
        .default(false)
        .describe(
          "Mark as test send. Prepends 【テスト配信】 to text messages, adds test banner to flex messages.",
        ),
      senderMode: z
        .enum(["official", "self"])
        .optional()
        .describe("Sender identity mode. Omit to send as the authenticated staff. Use 'official' for the LINE official account."),
      senderStaffId: z
        .string()
        .optional()
        .describe("Staff ID to send as. Only owner credentials can select another staff member."),
    },
    async ({ friendId, targetType, targetId, content, messageType, altText, isTest, senderMode, senderStaffId }) => {
      try {
        const client = getClient();
        if (!friendId && !(targetType && targetId)) {
          throw new Error("friendId is required unless targetType and targetId are both provided");
        }

        // Add test label
        let finalContent = content;
        if (isTest) {
          if (messageType === "text") {
            finalContent = `【テスト配信】\n${content}`;
          } else if (messageType === "flex") {
            try {
              const flex = JSON.parse(content);
              // Wrap in a carousel with a test banner
              finalContent = JSON.stringify({
                type: "bubble",
                header: {
                  type: "box",
                  layout: "vertical",
                  backgroundColor: "#FFE066",
                  paddingAll: "8px",
                  contents: [{ type: "text", text: "⚠️ テスト配信", size: "sm", weight: "bold", color: "#333", align: "center" }],
                },
                ...(flex.type === "bubble" ? { body: flex.body, footer: flex.footer } : { body: { type: "box", layout: "vertical", contents: [{ type: "text", text: "テスト配信", wrap: true }] } }),
              });
            } catch {
              finalContent = content;
            }
          }
        }

        // Auto-track URLs in flex messages
        const recipientLabel = targetType && targetId
          ? `${targetType} ${targetId.slice(0, 8)}`
          : `DM to ${friendId!.slice(0, 8)}`;
        const { content: trackedContent } = await autoTrackUrls(
          client,
          finalContent,
          messageType,
          recipientLabel,
        );

        const senderSelection = senderStaffId ? { senderStaffId } : senderMode ? { senderMode } : undefined;
        const result = targetType && targetId
          ? await client.targets.sendMessage(
              targetType,
              targetId,
              trackedContent,
              messageType,
              altText,
              senderSelection,
            )
          : await client.friends.sendMessage(
              friendId!,
              trackedContent,
              messageType,
              altText,
              senderSelection,
            );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: true, messageId: result.messageId },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { success: false, error: String(error) },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
