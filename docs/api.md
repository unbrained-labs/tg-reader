# Search API

> Machine-readable spec: [`openapi.yaml`](../openapi.yaml) — import into Postman, Insomnia, or view at [editor.swagger.io](https://editor.swagger.io).

All endpoints are on the Cloudflare Worker URL. All requests require:

```
X-Ingest-Token: <your-token>
X-Account-ID: <account-id>
```

---

## GET /search

Full-text search across all archived messages.

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search query — words are ANDed, prefix matching enabled |
| `chat_id` | string | Filter to a specific chat |
| `sender_username` | string | Filter by sender username |
| `from` | string | Start date — ISO 8601 (`2024-01-01`) or Unix timestamp |
| `to` | string | End date — ISO 8601 or Unix timestamp |
| `limit` | number | Results per page, default 20, max 100 |
| `before_id` | number | Pagination cursor — pass `next_before_id` from previous response |

### Example

```bash
curl "https://<worker>/search?q=invoice+payment&from=2024-01-01&to=2024-06-30&limit=20" \
  -H "X-Ingest-Token: <token>" \
  -H "X-Account-ID: <account_id>"
```

### Response

```json
{
  "results": [
    {
      "id": 12345,
      "tg_message_id": 98765,
      "tg_chat_id": "1234567890",
      "chat_name": "John Smith",
      "chat_type": "user",
      "sender_id": "1234567890",
      "sender_username": "johnsmith",
      "sender_first_name": "John",
      "sender_last_name": "Smith",
      "direction": "in",
      "message_type": "text",
      "text": "I sent the invoice payment yesterday",
      "media_type": null,
      "reply_to_message_id": null,
      "sent_at": 1704067200,
      "edit_date": null,
      "original_text": null,
      "is_deleted": 0
    }
  ],
  "total": 42,
  "limit": 20,
  "next_before_id": 12300
}
```

Paginate by passing `next_before_id` as `before_id` in the next request. `next_before_id` is `null` when there are no more results.

---

## GET /chats

Lists all chats with message counts and last activity.

```bash
curl "https://<worker>/chats" \
  -H "X-Ingest-Token: <token>" \
  -H "X-Account-ID: <account_id>"
```

---

## GET /contacts

Lists contacts with names, usernames, and message counts.

```bash
curl "https://<worker>/contacts" \
  -H "X-Ingest-Token: <token>" \
  -H "X-Account-ID: <account_id>"
```

---

## Data reference

### `direction`
- `"out"` — message sent by the account owner
- `"in"` — message received

### `message_type`
`text`, `photo`, `video`, `audio`, `voice`, `document`, `sticker`, `video_note`, `service`

### `chat_type`
`user` (DM), `group`, `supergroup`, `channel`, `bot`

### Timestamps
All timestamps (`sent_at`, `edit_date`, `deleted_at`) are **Unix epoch seconds**.

### Deleted messages
Soft-deleted — `is_deleted=1`, `deleted_at` set. Message content is preserved.

### Edited messages
`original_text` contains the pre-edit text. `text` is always the latest version.
