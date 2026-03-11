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
│  • Backfill scripts (one-time)           │
└───────────────┬──────────────────────────┘
                │ POST /ingest (HTTPS)
                ▼
┌──────────────────────────────────────────┐
│       Cloudflare Worker  ($5/mo)         │
│                                          │
│  REST API — ingest, search, config       │
└──────────┬───────────────────────────────┘
           │                     │
           ▼                     ▼
┌─────────────────┐   ┌──────────────────┐
│  Cloudflare D1  │   │  Cloudflare R2   │
│  SQLite + FTS5  │   │  Daily backups   │
│  (included)     │   │  (~$0/mo)        │
└─────────────────┘   └──────────────────┘
```

## What gets captured

- Every message sent and received across all chats
- Message text, media type, sender info, timestamps
- Edit history (original text preserved on edit)
- Deleted messages (soft-deleted, not removed)
- Forwarded message metadata
- Reply context

## What does NOT get stored

- Media files (photos, videos, documents) — only the type and Telegram file ID are stored, not the binary
- Message reactions
- Voice/video call records

## Cost

| Component | Service | Cost |
|-----------|---------|------|
| Message listener | Fly.io (shared VM) | ~$4/mo |
| API + database | Cloudflare Workers Paid + D1 | $5/mo |
| Backups | Cloudflare R2 | ~$0/mo |
| **Total** | | **~$9/mo** |

## Multi-account support

Multiple Telegram accounts can be connected to the same Worker and D1 database. Each account's data is isolated by `account_id`.
