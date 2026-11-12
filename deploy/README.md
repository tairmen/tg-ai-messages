# Droplet deployment

Public URL: https://true.reserv-app.org:8443

Nginx terminates TLS with the existing domain certificate and uses the application’s login page and secure cookie sessions. The app listens only on loopback, port 3001. PUBLIC_ORIGIN permits browser requests from the public HTTPS origin. Never expose backend port 3001 directly: the backend itself has no remote admin login.

Source: /opt/tg-ai-messages (Git checkout).
Initial container creation: `sh deploy/start-container.sh` (requires the runtime secrets, production dependencies, and frontend build to be installed first). The startup script pins the Node image digest and mounts the application read-only.

Runtime: Docker container tg-ai-messages, node:22-bookworm-slim, host networking, non-root node user, restart unless-stopped, memory limit 256 MB. Production dependencies are installed on the droplet. Frontend dist is built on the workstation and uploaded to avoid exhausting this small droplet's RAM.

Runtime secrets: /opt/tg-ai-messages/.env and .data/telegram.session (not in Git). Admin password hash: /opt/tg-ai-messages/.data/admin.htpasswd (copied from the original Nginx credential file; same credentials). Treat the Telegram session like a password. Run a single backend instance with this session. Stop the workstation backend before starting the droplet runtime.

## Update

1. Pull main in /opt/tg-ai-messages.
2. If package-lock.json changed, install production dependencies using the same Node image: docker run --rm --network host -v /opt/tg-ai-messages:/app -w /app node:22-bookworm-slim npm ci --omit=dev --ignore-scripts.
3. On the workstation run npm ci and npm run build; upload dist to /opt/tg-ai-messages/dist. Ensure uploaded directories have mode 755 and static files mode 644 so the non-root container can read them.
4. Restore ownership of the checkout to UID/GID 1000 and restrict .env and .data/telegram.session to 600.
5. docker restart tg-ai-messages
6. Verify unauthenticated API requests return 401 and the frontend shows its login form and authenticated /api/health reports database and Telegram connected.

## Operations

- Logs: docker logs --tail 80 tg-ai-messages
- Restart: docker restart tg-ai-messages
- Stop: docker stop tg-ai-messages
- TLS certificate renewals use the existing Certbot setup.
- The dashboard is HTTPS-only on 8443; use the domain, not the IP, so TLS verification succeeds.
- To remove public access, remove the UFW 8443/tcp rule and disable only the tg-ai-messages Nginx site. Leave other applications untouched.

## Telegram login on the droplet

Create a fresh Telegram session directly on the droplet. Do not run a copied session simultaneously on hosts with different IPs: Telegram can invalidate it with AUTH_KEY_DUPLICATED. Stop tg-ai-messages, run the login command in a temporary interactive container with the application directory mounted read/write as UID 1000, then restart the production container. The production container retains its read-only mount.

The admin login verifier reads .data/admin.htpasswd as UID 1000 with mode 600. Sessions are hashed and persisted in the OAuth storage table with a 24-hour expiry. Nginx strips X-Relay-Internal from all public requests; only the in-process MCP bridge knows that private credential. The public browser cannot bypass login by supplying an admin API token.

## Standard HTTPS MCP discovery

The canonical MCP origin is https://true.reserv-app.org on port 443 (MCP_ORIGIN). The dashboard stays at https://true.reserv-app.org:8443 (PUBLIC_ORIGIN). Include deploy/mcp-443.nginx.conf only in the existing domain’s TLS server block to proxy MCP/OAuth routes. Other website paths remain on their existing application. Both root and /mcp-specific protected-resource discovery URLs are published. Existing port-8443 token audiences remain accepted only for this service. OAuth browser login redirects to the dashboard origin when needed; its cookie is shared on the same host.
