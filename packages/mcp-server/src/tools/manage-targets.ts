import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";

export function registerManageTargets(server: McpServer): void {
  server.tool(
    "manage_targets",
    "Manage LINE group/room conversation targets. Actions: 'list' (all group/room targets with sales metadata), 'get' (target detail incl. observed participants), 'set_metadata' (merge metadata fields, e.g. salesCustomerPageId for CRM linking). Targets are registered automatically when the official account joins a group/room or a message occurs there.",
    {
      action: z
        .enum(["list", "get", "set_metadata"])
        .describe("Operation to perform"),
      targetType: z
        .enum(["group", "room"])
        .optional()
        .describe("Target type. Required for 'get' and 'set_metadata'; optional filter for 'list'."),
      targetId: z
        .string()
        .optional()
        .describe("Target ID (harness ID or raw LINE groupId/roomId). Required for 'get' and 'set_metadata'."),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe("Metadata fields to merge (for 'set_metadata')."),
      lineAccountId: z.string().optional().describe("Filter by LINE account (for 'list')"),
      includeInactive: z
        .boolean()
        .default(false)
        .describe("Include targets the bot has left (for 'list')"),
      limit: z.number().default(50).describe("Max targets to return (for 'list')"),
      offset: z.number().default(0).describe("Pagination offset (for 'list')"),
    },
    async ({ action, targetType, targetId, metadata, lineAccountId, includeInactive, limit, offset }) => {
      try {
        const client = getClient();

        if (action === "list") {
          const result = await client.targets.list({
            type: targetType,
            lineAccountId,
            includeInactive,
            limit,
            offset,
          });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ success: true, ...result }, null, 2) },
            ],
          };
        }

        if (!targetType || !targetId) {
          throw new Error(`targetType and targetId are required for action '${action}'`);
        }

        if (action === "get") {
          const result = await client.targets.get(targetType, targetId);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify({ success: true, target: result }, null, 2) },
            ],
          };
        }

        // set_metadata
        if (!metadata || Object.keys(metadata).length === 0) {
          throw new Error("metadata is required for action 'set_metadata'");
        }
        const updated = await client.targets.setMetadata(targetType, targetId, metadata);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: true, target: updated }, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: false, error: String(error) }, null, 2) },
          ],
          isError: true,
        };
      }
    },
  );
}
