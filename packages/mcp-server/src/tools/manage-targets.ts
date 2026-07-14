import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";

export function registerManageTargets(server: McpServer): void {
  server.tool(
    "manage_targets",
    "Manage LINE group/room conversation targets. Actions: 'list' (all group/room targets with sales metadata), 'get' (target detail incl. observed participants), 'set_metadata' (merge metadata fields, e.g. salesCustomerPageId for CRM linking). Overwriting or clearing an existing sales link (salesCustomerPageId / salesDealPageId) to a different value is rejected unless force=true — a target is linked to exactly one primary customer/deal and silent relinking is unsafe. Targets are registered automatically when the official account joins a group/room or a message occurs there.",
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
      metadataFilter: z
        .record(z.string())
        .optional()
        .describe(
          "Exact-match metadata filters (for 'list'). E.g. { salesCustomerPageId: '...' } to find every target linked to a customer.",
        ),
      lineAccountId: z.string().optional().describe("LINE account scope. For 'list' it filters; for 'get'/'set_metadata' it asserts the owning account (409 if the target moved accounts). Defaults to LINE_HARNESS_ACCOUNT_ID."),
      includeInactive: z
        .boolean()
        .default(false)
        .describe("Include targets the bot has left (for 'list')"),
      limit: z.number().default(50).describe("Max targets to return (for 'list')"),
      offset: z.number().default(0).describe("Pagination offset (for 'list')"),
      force: z
        .boolean()
        .default(false)
        .describe(
          "Required to overwrite or clear an existing sales link (salesCustomerPageId / salesDealPageId) with a different value (for 'set_metadata'). Confirm the relink with the user before setting this.",
        ),
    },
    async ({ action, targetType, targetId, metadata, metadataFilter, lineAccountId, includeInactive, limit, offset, force }) => {
      try {
        const client = getClient();

        if (action === "list") {
          const result = await client.targets.list({
            type: targetType,
            lineAccountId,
            includeInactive,
            metadata: metadataFilter,
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
          const result = await client.targets.get(targetType, targetId, { lineAccountId });
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

        // Sales links bind a target to exactly one primary customer/deal
        // (P0 requirement). Changing or clearing an established link must be
        // an explicit, forced operation — never a side effect of a routine
        // metadata merge.
        const PROTECTED_LINK_KEYS = ["salesCustomerPageId", "salesDealPageId"] as const;
        const touchedLinkKeys = PROTECTED_LINK_KEYS.filter((k) => k in metadata);
        if (touchedLinkKeys.length > 0 && !force) {
          const current = await client.targets.get(targetType, targetId, { lineAccountId });
          const conflicts = touchedLinkKeys.filter((k) => {
            const existing = current.metadata?.[k];
            return existing != null && existing !== "" && existing !== metadata[k];
          });
          if (conflicts.length > 0) {
            throw new Error(
              `Refusing to overwrite existing sales link(s) without force=true: ` +
                conflicts
                  .map((k) => `${k}: ${JSON.stringify(current.metadata?.[k])} -> ${JSON.stringify(metadata[k])}`)
                  .join(", ") +
                ". Confirm the relink with the user, then retry with force=true.",
            );
          }
        }

        const updated = await client.targets.setMetadata(targetType, targetId, metadata, { lineAccountId });
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
