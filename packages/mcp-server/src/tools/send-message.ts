import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";

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
          "Prepend a 【テスト配信】 label to text messages / add a test banner to flex messages. NOT a dry run: the message is still actually delivered to the recipient — including every member of a group/room — with normal notifications and billing.",
        ),
      senderMode: z
        .enum(["official", "self"])
        .optional()
        .describe("Sender identity mode. Omit to send as the authenticated staff. Use 'official' for the LINE official account."),
      senderStaffId: z
        .string()
        .optional()
        .describe("Staff ID to send as. Only owner credentials can select another staff member."),
      trackLinks: z
        .boolean()
        .default(true)
        .describe(
          "Set false to disable automatic URL shortening (/t/ tracking links, created server-side per LINE account). URLs are sent as-is. Default true.",
        ),
    },
    async ({ friendId, targetType, targetId, content, messageType, altText, isTest, senderMode, senderStaffId, trackLinks }) => {
      try {
        const client = getClient();
        // Destination must be exactly one of friendId XOR (targetType+targetId).
        // Ambiguous or partial input fails BEFORE sending: an LLM leaving a
        // stale friendId alongside a target (or vice versa) must not silently
        // pick one and deliver to the wrong conversation.
        const hasTarget = Boolean(targetType || targetId);
        if (friendId && hasTarget) {
          throw new Error(
            "Specify exactly one destination: either friendId OR targetType+targetId, not both",
          );
        }
        if (hasTarget && !(targetType && targetId)) {
          throw new Error("targetType and targetId must both be provided to send to a group/room");
        }
        if (!friendId && !hasTarget) {
          throw new Error("A destination is required: friendId, or targetType+targetId");
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

        // URL の短縮 (auto-track) は worker が送信時に行う (friend/target の所属
        // アカウント付きでリンクを所有させるため、ここでは変換しない)。
        // trackLinks=false は API に渡して worker 側の短縮もスキップさせる。
        const senderSelection = senderStaffId ? { senderStaffId } : senderMode ? { senderMode } : undefined;
        const result = targetType && targetId
          ? await client.targets.sendMessage(
              targetType,
              targetId,
              finalContent,
              messageType,
              altText,
              senderSelection,
              { trackLinks },
            )
          : await client.friends.sendMessage(
              friendId!,
              finalContent,
              messageType,
              altText,
              senderSelection,
              { trackLinks },
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
