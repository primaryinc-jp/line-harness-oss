# Staff Message Sender

## Goal

Manual LINE replies can be sent as a staff sender while keeping the sender identity tied to trusted staff records.

This feature is complete only when all of the following are true:

- The client never sends arbitrary LINE sender `name` / `iconUrl` values.
- The Worker resolves the sender from `staff_members` at send time.
- Missing sender selection defaults to the authenticated staff member.
- Non-owner staff can only send as themselves.
- Owner staff can send as themselves, the official account, or another active staff member.
- Inactive or missing staff members cannot be selected as senders.
- Sender name and icon URL are validated before calling the LINE API.
- The outgoing message log stores the sender identity used at send time.
- Chat history exposes the stored sender identity so operators can audit past manual replies.
- SDK and MCP callers use the same sender selection contract as the Web UI.

## Request Contract

Manual send endpoints accept a sender selection, not raw sender display data.

Omitting sender selection sends as the authenticated staff member resolved from the API key.
This is the normal path for API / MCP usage: call the API with the target staff member's API key, and the message is sent as that staff member.

```json
{ "senderMode": "official" }
```

```json
{ "senderMode": "self" }
```

```json
{ "senderStaffId": "staff-id" }
```

`senderStaffId` is owner-only unless it matches the authenticated staff member.

## Sender Resolution

The Worker resolves the request as follows:

- `senderMode: "official"`: send without LINE `sender`, so the official account identity is used.
- `senderMode: "self"`: load the authenticated staff member from `staff_members`.
- `senderStaffId`: load that staff member from `staff_members`.
- No sender selection: load the authenticated staff member from `staff_members`.

Resolved staff senders must have:

- non-empty `name`
- `name` of 20 characters or fewer
- optional `iconUrl` that starts with `https://`
- `is_active = 1`

Staff icons are registered ahead of time on the staff record (`staff_members.icon_url`), either from the Staff Management UI or staff API/MCP management tools. Send requests only choose the staff identity; they do not carry ad hoc image URLs.

## Audit Fields

Manual outgoing rows in `messages_log` store:

- `sender_staff_id`
- `sender_name`
- `sender_icon_url`

These fields represent the sender identity at send time. They are intentionally denormalized so later staff edits do not rewrite history.

## Release Gate

Origin releases use the fork deploy workflows, not upstream semver tags or GitHub Releases.

Required GitHub Actions settings:

- secret: `CLOUDFLARE_API_TOKEN`
- secret: `CLOUDFLARE_ACCOUNT_ID`
- secret: `D1_DATABASE_NAME`
- secret: `D1_DATABASE_ID`
- secret: `NEXT_PUBLIC_API_URL`
- variable: `LINE_HARNESS_CLOUDFLARE_DEPLOY=true`

The deploy workflows include a preflight job that reports missing settings in the GitHub Actions summary.

## Upstream Compatibility

Fork-local database migrations use the `900_primaryinc_*` prefix to avoid filename collisions with future upstream numbered migrations.

Keep future changes additive where possible:

- add nullable audit columns instead of changing existing message columns
- keep raw LINE `sender` data server-side only
- prefer new request fields over changing existing message payload shapes
