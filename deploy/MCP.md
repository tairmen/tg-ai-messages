# Relay MCP connection

Server URL: https://true.reserv-app.org/mcp
Transport: Streamable HTTP
Authentication: OAuth (authorization-code flow, S256 PKCE, refresh tokens)

## Connect from ChatGPT

Open https://chatgpt.com/plugins, select the plus button, then Add custom MCP server. Name it Relay Telegram, enter the server URL above, and choose OAuth. Review the warning and select Create as a plugin. Review the discovered tools, install the plugin, and select it with @ in a new chat. Account/workspace policies may restrict custom MCP connections; older interfaces may place this under Apps and Developer mode. Relay advertises OAuth metadata and dynamic client registration, so a client ID or secret normally does not need to be entered manually. Official instructions: https://developers.openai.com/plugins/deploy/connect-chatgpt

When Relay opens its authorization page, sign in on the Relay login page using the same admin username and password as the dashboard. Verify the callback shown belongs to the AI client you started connecting, review the requested permissions, and click Approve connection. Add the connected app to a chat. ChatGPT account/workspace settings control whether custom MCP connections are available; this server cannot enable that feature for your account.

Example prompts:

- List my Telegram contacts.
- Draft a Ukrainian follow-up for contacts 1 and 2. Save it as a campaign, but do not send yet.
- Preview that campaign, including the exact personalized messages and phone numbers.
- Send the campaign we just reviewed.
- Show the campaign results.
- Read this customer's conversation and draft a reply.
- Show the AI instructions and keep automatic replies disabled.

ChatGPT can write campaign copy itself; no extra OpenAI API call is needed for campaign drafting. The draft_reply tool does use the service's configured OpenAI API key and sends stored conversation history to OpenAI.

## Tools and permissions

Read scope: get_status, list_contacts, list_campaigns, preview_campaign, get_conversation, get_ai_settings.
Write scope: upsert_contacts, create_campaign, draft_reply, update_ai_settings, set_contact_preferences.
Send scope: send_campaign.

Creating a campaign saves a draft only. Sending requires confirm_send=true and the preview_hash from preview_campaign. The server checks the current draft and recipient snapshot under database locks before claiming the campaign for sending. Repeated send attempts are rejected once the campaign is claimed. A campaign has at most 10 recipients. Opted-out contacts cannot be sent messages. Client-side user confirmation is still important: the hash binds the content, but the server cannot independently prove what the user approved in a third-party chat.

## OAuth operations

- Discovery: /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource/mcp
- Authorization / consent: /authorize and /authorize/decision (protected by the admin session)
- Token exchange / refresh: /token
- Dynamic registration: /register
- Revocation: /revoke
- MCP: /mcp (OAuth bearer token required)

Access tokens last one hour; refresh tokens last 30 days and rotate on use. Tokens and authorization codes are stored hashed in the PostgreSQL oauth table. Pending consent uses a short-lived, single-use request and a secure, HTTP-only SameSite cookie. Registered client metadata lives in PostgreSQL. The audit table records client ID, tool, outcome, and time; no message bodies or credentials are written to the audit log.

The dashboard Settings page lists authorized MCP connections and can revoke them. The admin API also supports GET /api/mcp/connections and DELETE /api/mcp/connections/:grant_id with the normal dashboard session token. Revoking a grant invalidates its access and refresh tokens.

No OAuth endpoint grants workspace access without a signed-in admin approving consent. Public metadata and registration are discovery only. Do not put dashboard credentials or an API key into the MCP URL.

## Deployment

Pull main, install updated production dependencies with the pinned Node runtime, restart tg-ai-messages, and install deploy/nginx.conf after nginx -t passes. New OAuth and audit tables are created by the normal migration. The Nginx config forwards bearer tokens only on MCP/OAuth machine endpoints; the dashboard and human consent endpoints retain admin authentication.

## Direct messages and conversation control

The server now exposes 15 tools. Use send_message with either an international phone number or contact_id, the exact body, confirm_send=true, and a unique request_id. Reuse that request_id when retrying the same operation; use a new ID only for a new explicitly requested message. Telegram phone privacy and account restrictions still apply. A sent result means Telegram accepted the message, not that it was read. Uncertain delivery must be checked in the conversation before another send.

Use list_conversations to find tracked customer chats; get_conversation returns chronological messages, settings, and a next_before_id cursor for older pages. Use sync_conversation to import older history from Telegram and page with next_before_message_id. Captions and media/service-message placeholders are stored, but attachments are not downloaded by MCP. Syncing does not trigger AI replies.

set_contact_preferences accepts ai_enabled, ai_instructions, and/or opted_out. Conversation instructions supplement the global instructions; empty text clears the override. Both the global and conversation switches must be on for automatic replies.

The frontend now has a login page and logout. OAuth authorization redirects to the same login page when needed. Existing OAuth connections remain valid; refresh the tool metadata in ChatGPT to discover the added tools.

## Standard HTTPS MCP discovery

The canonical MCP origin is https://true.reserv-app.org on port 443 (MCP_ORIGIN). The dashboard stays at https://true.reserv-app.org:8443 (PUBLIC_ORIGIN). Include deploy/mcp-443.nginx.conf only in the existing domain’s TLS server block to proxy MCP/OAuth routes. Other website paths remain on their existing application. Both root and /mcp-specific protected-resource discovery URLs are published. Existing port-8443 token audiences remain accepted only for this service. OAuth browser login redirects to the dashboard origin when needed; its cookie is shared on the same host.

## Username recipients

send_message accepts exactly one of phone, username, or contact_id. For username, use a public handle such as @example. resolve_recipient looks up a phone or username and saves the matched contact without sending. Username-only contacts have phone=null; the service does not invent a phone number or assume a supplied number belongs to a username. Usernames are resolved to Telegram user IDs before sending, so a reassigned handle is not silently sent to an old cached identity. Only personal accounts are supported through this route.

Phone lookup uses Telegram's exact import mapping. An empty match does not prove the number is unregistered: privacy settings and account visibility can affect it. Explicit lookup deferrals are reported separately. The service now exposes 16 tools; refresh the ChatGPT plugin metadata after updating.
