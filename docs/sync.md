# Sync & Filtering

By default tg-reader captures everything. You can restrict what gets synced using global modes and per-chat overrides.

## Global sync mode

| Mode | Behaviour |
|------|-----------|
| `all` | Capture all chats (default) |
| `blacklist` | Capture everything except excluded chats |
| `whitelist` | Capture only explicitly included chats |
| `none` | Pause all capture |

### Get current mode

```bash
curl https://<worker>/config \
  -H "X-Ingest-Token: <token>" \
  -H "X-Account-ID: <account_id>"
```

### Change mode

```bash
curl -X POST https://<worker>/config \
  -H "X-Ingest-Token: <token>" \
  -H "X-Account-ID: <account_id>" \
  -H "Content-Type: application/json" \
  -d '{"sync_mode": "whitelist"}'
```

---

## Per-chat overrides

Works in combination with the global mode:
- In `blacklist` mode: mark specific chats as `exclude`
- In `whitelist` mode: mark specific chats as `include`

### Add override

```bash
curl -X POST https://<worker>/chats/config \
  -H "X-Ingest-Token: <token>" \
  -H "X-Account-ID: <account_id>" \
  -H "Content-Type: application/json" \
  -d '{"tg_chat_id": "12345678", "sync": "exclude"}'
```

### List overrides

```bash
curl https://<worker>/chats/config \
  -H "X-Ingest-Token: <token>" \
  -H "X-Account-ID: <account_id>"
```

### Remove override

```bash
curl -X DELETE https://<worker>/chats/config/12345678 \
  -H "X-Ingest-Token: <token>" \
  -H "X-Account-ID: <account_id>"
```

---

## Finding chat IDs

Use the `/chats` endpoint to list all chats with their IDs:

```bash
curl https://<worker>/chats \
  -H "X-Ingest-Token: <token>" \
  -H "X-Account-ID: <account_id>"
```

Or use the `chats` tool via the MCP connector — see [MCP / Agent Guide](agents.md).

---

## Notes

- Sync config changes take effect immediately for new messages
- Changing mode does not delete already-captured messages
- Overrides only apply to the account specified by `X-Account-ID`
