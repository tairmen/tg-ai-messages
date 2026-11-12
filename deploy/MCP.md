# Relay MCP connection

Server URL: https://true.reserv-app.org:8443/mcp
Transport: Streamable HTTP
Authentication: OAuth (authorization-code flow, S256 PKCE, refresh tokens)

## Connect from ChatGPT

Open https://chatgpt.com/plugins, select the plus button, then Add custom MCP server. Name it Relay Telegram, enter the server URL above, and choose OAuth. Review the warning and select Create as a plugin. Review the discovered tools, install the plugin, and select it with @ in a new chat. Account/workspace policies may restrict custom MCP connections; older interfaces may place this under Apps and Developer mode. Relay advertises OAuth metadata and dynamic client registration, so a client ID or secret normally does not need to be entered manually. Official instructions: https://developers.openai.com/plugins/deploy/connect-chatgpt

When Relay opens its authorization page, sign in with the same admin username and password as the dashboard. Verify the callback shown belongs to the AI client you started connecting, review the requested permissions, and click Approve connection. Add the connected app to a chat. ChatGPT account/workspace settings control whether custom MCP connections are available; this server cannot enable that feature for your account.

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
- Authorization / consent: /authorize and /authorize/decision (protected by Nginx admin login)
- Token exchange / refresh: /token
- Dynamic registration: /register
- Revocation: /revoke
- MCP: /mcp (OAuth bearer token required)

Access tokens last one hour; refresh tokens last 30 days and rotate on use. Tokens and authorization codes are stored hashed in the PostgreSQL oauth table. Pending consent uses a short-lived, single-use request and a secure, HTTP-only SameSite cookie. Registered client metadata lives in PostgreSQL. The audit table records client ID, tool, outcome, and time; no message bodies or credentials are written to the audit log.

The dashboard Settings page lists authorized MCP connections and can revoke them. The admin API also supports GET /api/mcp/connections and DELETE /api/mcp/connections/:grant_id with the normal dashboard session token. Revoking a grant invalidates its access and refresh tokens.

No OAuth endpoint grants workspace access without a signed-in admin approving consent. Public metadata and registration are discovery only. Do not put dashboard credentials or an API key into the MCP URL.

## Deployment

Pull main, install updated production dependencies with the pinned Node runtime, restart tg-ai-messages, and install deploy/nginx.conf after nginx -t passes. New OAuth and audit tables are created by the normal migration. The Nginx config forwards bearer tokens only on MCP/OAuth machine endpoints; the dashboard and human consent endpoints retain admin authentication.
