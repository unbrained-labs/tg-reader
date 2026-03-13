# Overview

tg-reader captures every Telegram message you send and receive into a searchable database. It runs entirely on your own infrastructure — no third-party services have access to your messages.

## Architecture

```
┌──────────────────────────────────────────┐
│              Telegram                    │
│   (your DMs, groups, channels)           │
└───────────────┬──────────────────────────┘
                │ MTProto (real-time)
                ▼
┌──────────────────────────────────────────┐
│           Fly.io  (~$4/mo)               │
│                                          │
│  GramJS listener  (Node.js)              │
│  • Captures new messages in real-time    │
│  • Gap recovery on restart               │
│  • Polls outbox + actions every 30s      │
│  • Backfill scripts (one-time)           │
└───────────────┬──────────────────────────┘
                │ REST API (HTTPS)
                ▼
┌──────────────────────────────────────────┐
│       Cloudflare Worker  ($5/mo)         │
│                                          │
│  REST API — ingest, search, write,       │
│  config, MCP server                      │
└──────────┬───────────────────────────────┘
           │                     │
           ▼                     ▼
┌─────────────────┐   ┌──────────────────┐
│  Neon PostgreSQL│   │  Cloudflare R2   │
│  (serverless)   │   │  Daily backups   │
│  $0–19/mo       │   │  (~$0/mo)        │
└─────────────────┘   └──────────────────┘
```

## What gets captured

- Every message sent and received across all chats
- Message text, media type, sender info, timestamps
- Edit history (original text preserved on edit)
- Deleted messages (soft-deleted, not removed)
- Forwarded message metadata
- Reply context

## What you can send

- Replies, scheduled messages, and drafts via the outbox
- Mass messages to multiple chats with `{user}` / `{first_name}` placeholders
- Edit, delete (revoke), and forward already-sent messages
- All writes go through the Worker outbox — GramJS picks them up within 30 seconds

## What does NOT get stored

- Media files (photos, videos, documents) — only the type and Telegram file ID are stored, not the binary
- Message reactions
- Voice/video call records

## Cost

| Component | Service | Cost |
|-----------|---------|------|
| Message listener + writer | Fly.io (shared VM) | ~$4/mo |
| API + MCP server | Cloudflare Workers Paid | $5/mo |
| Database | Neon PostgreSQL (serverless) | $0–19/mo |
| Backups | Cloudflare R2 | ~$0/mo |
| **Total** | | **~$9–28/mo** |

## Multi-account support

Multiple Telegram accounts can be connected to the same Worker and Neon database. Each account's data is isolated by `account_id`.
