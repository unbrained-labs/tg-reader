# TG Reader — Dashboard Design

> API-first Telegram archive. The dashboard is a lightweight admin/monitoring UI,
> not the primary interface (agents via MCP are). Keep it minimal, functional, read-heavy.

**Design tool:** [pencil.dev](https://pencil.dev)
**Framework suggestion:** Single-page app (Astro + Preact or plain React), served from Cloudflare Pages, talks to the existing Worker API.

---

## Design Principles

1. **Read-mostly** — 90% of usage is viewing data, not mutating it
2. **Agent-aware** — surface what agents are doing (audit log, token activity)
3. **No duplication** — agents handle complex workflows; the dashboard shows state
4. **Responsive but desktop-first** — admin tool, not a mobile app
5. **Dark theme default** — matches terminal/dev aesthetic

---

## Authentication

The dashboard authenticates with `MASTER_TOKEN` (stored in an httpOnly cookie after initial login).
A simple token-entry screen — no OAuth, no user accounts.

---

## Navigation

Left sidebar, always visible. 5 sections:

```
┌──────────────────────────────────────────────────────────┐
│ [TG Reader]                                    [account] │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│  Overview  │                                             │
│  Search    │            (content area)                   │
│  Chats     │                                             │
│  Agents    │                                             │
│  Outbox    │                                             │
│            │                                             │
├────────────┤                                             │
│  Settings  │                                             │
│            │                                             │
└────────────┴─────────────────────────────────────────────┘
```

Account switcher dropdown in header (for multi-account setups).

---

## Page 1: Overview

The landing page. At-a-glance health and stats.

```
┌─────────────────────────────────────────────────────────────────┐
│  Overview                                                       │
│                                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ Messages │ │  Chats   │ │ Contacts │ │ Deleted  │          │
│  │  124,891 │ │    47    │ │   312    │ │   1,203  │          │
│  │ +342 24h │ │          │ │          │ │          │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Message Volume (30 days)              [7d] [30d] [all] │   │
│  │                                                         │   │
│  │  ▐                                                      │   │
│  │  ▐▐    ▐                          ▐                     │   │
│  │  ▐▐▐   ▐▐   ▐    ▐▐▐  ▐▐   ▐▐▐  ▐▐   ▐▐   ▐   ▐     │   │
│  │  ▐▐▐▐  ▐▐▐  ▐▐   ▐▐▐  ▐▐▐  ▐▐▐  ▐▐▐  ▐▐▐  ▐▐  ▐▐    │   │
│  │  ────────────────────────────────────────────────────    │   │
│  │  Feb 14       Feb 21       Feb 28       Mar 7   Mar 14  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌───────────────────────────┐ ┌───────────────────────────┐   │
│  │  Backfill Progress        │ │  Agent Activity (24h)     │   │
│  │                           │ │                           │   │
│  │  Complete: 42/47 chats    │ │  work-claude    23 calls  │   │
│  │  In progress: 2           │ │  scout-bot       8 calls  │   │
│  │  Failed: 1 (retry?)       │ │  digest-agent    3 calls  │   │
│  │  Pending: 2               │ │                           │   │
│  │                           │ │  Total: 34 calls          │   │
│  │  ██████████████████░░ 89% │ │  Writes: 4 (2 send,      │   │
│  │                           │ │           1 edit, 1 fwd)  │   │
│  └───────────────────────────┘ └───────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Recent Audit Log                          [view all →] │   │
│  │                                                         │   │
│  │  12:34  work-claude   send    → Design Team Chat        │   │
│  │  11:02  work-claude   edit    → Design Team Chat        │   │
│  │  09:15  scout-bot     forward → Saved Messages          │   │
│  │  08:41  work-claude   send    → @john_doe               │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Data sources
- Stats cards → `GET /stats`
- Volume chart → new endpoint needed: `GET /stats/volume?days=30` or compute client-side from search
- Backfill → `GET /backfill/pending` + count of completed
- Agent activity → `audit_log` table (RBAC feature)
- Recent audit → `audit_log` table (RBAC feature)

---

## Page 2: Search

Full-text search with filters. The core read feature.

```
┌─────────────────────────────────────────────────────────────────┐
│  Search                                                         │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 🔍  Search messages...                                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Filters:  [Chat ▼]  [Sender ▼]  [From date]  [To date]       │
│                                                                 │
│  ── 3,201 results ──────────────────────────────────────────   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Design Team Chat · @alice · Mar 14, 2026 14:32         │   │
│  │  "...the new **dashboard** mockups look great, let's    │   │
│  │  finalize the color palette before..."                   │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  @john_doe (DM) · Mar 13, 2026 09:15                    │   │
│  │  "...can you share the **dashboard** spec with the team  │   │
│  │  by Friday?"                                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Product Updates · @bot_news · Mar 12, 2026 18:44       │   │
│  │  "Release v2.3 includes a new **dashboard** widget..."   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│                      [Load more ↓]                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Interactions
- Search is debounced (300ms) — calls `GET /search?q=...`
- Filters map to existing query params: `chat_id`, `sender_username`, `from`, `to`
- "Load more" uses keyset pagination (`before_id` + `before_sent_at`)
- Clicking a result opens the chat history view (Page 3) scrolled to that message

---

## Page 3: Chats

Chat list with config management. Two sub-views: list and detail.

### 3a: Chat List

```
┌─────────────────────────────────────────────────────────────────┐
│  Chats                                   [filter ▼] [sort ▼]   │
│                                                                 │
│  Filter: [All] [Unanswered] [Groups] [DMs] [Channels]         │
│  Sort:   [Last activity ▼]                                     │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Design Team Chat          supergroup   [work]          │   │
│  │  Last: 2h ago · 4,312 msgs · Sync: include             │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  @john_doe                 user         [work][client]  │   │
│  │  Last: 5h ago · 891 msgs  · Sync: include              │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  News Channel              channel                      │   │
│  │  Last: 1d ago · 12,044 msgs · Sync: exclude            │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  Family Group 🔇           group        [personal]      │   │
│  │  Last: 3d ago · 2,100 msgs · Sync: include             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3b: Chat Detail (click into a chat)

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Chats  /  Design Team Chat                                  │
│                                                                 │
│  ┌──────────────────────┐  ┌────────────────────────────────┐  │
│  │  Config               │  │  Messages (newest first)       │  │
│  │                       │  │                                │  │
│  │  Label: [work    ▼]  │  │  @alice · 14:32                │  │
│  │  Sync:  [include ▼]  │  │  The mockups look great, let's │  │
│  │  Type:  supergroup    │  │  finalize the palette.         │  │
│  │  ID:    -100184...    │  │                                │  │
│  │                       │  │  @bob · 14:28                  │  │
│  │  [Save config]        │  │  I uploaded the v3 designs.    │  │
│  │                       │  │                                │  │
│  │  ──────────────────   │  │  @alice · 13:55                │  │
│  │  Stats                │  │  Can we review the dashboard   │  │
│  │  Messages: 4,312      │  │  before EOD?                   │  │
│  │  Members: 12          │  │                                │  │
│  │  First msg: Jan 2024  │  │         [Load older ↓]         │  │
│  │                       │  │                                │  │
│  │  ──────────────────   │  │                                │  │
│  │  Backfill             │  │                                │  │
│  │  Status: complete     │  │                                │  │
│  │  Fetched: 4,312/4,312 │  │                                │  │
│  └──────────────────────┘  └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Data sources
- Chat list → `GET /chats?sort_by=last_activity`
- Chat config → `GET /chats/config`
- Update config → `POST /chats/config`
- Messages → `GET /search?chat_id=...` (no query = all messages)
- Backfill → `GET /backfill/pending` filtered by chat

---

## Page 4: Agents (RBAC — available after merge)

Central hub for managing agent access. Three tabs.

### 4a: Tokens

```
┌─────────────────────────────────────────────────────────────────┐
│  Agents  ─  [Tokens]  [Roles]  [Audit Log]                     │
│                                                                 │
│                                            [+ Create Token]     │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Token           Role            Last Used    Expires   │   │
│  │  ─────────────────────────────────────────────────────  │   │
│  │  work-claude     work-assistant  2h ago       never     │   │
│  │  scout-bot       read-all        14h ago      Apr 30    │   │
│  │  digest-agent    read-work       3d ago       never     │   │
│  │  temp-access     full            never        Mar 20 ⚠  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ⚠ = expires within 7 days                                     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4b: Roles

```
┌─────────────────────────────────────────────────────────────────┐
│  Agents  ─  [Tokens]  [Roles]  [Audit Log]                     │
│                                                                 │
│                                              [+ Create Role]    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Role             Read       Write         Tokens       │   │
│  │  ─────────────────────────────────────────────────────  │   │
│  │  read-all         all        —             1            │   │
│  │  read-work        whitelist  —             1            │   │
│  │    └ labels: work                                       │   │
│  │  work-assistant   whitelist  send          1            │   │
│  │    └ labels: work                                       │   │
│  │  full             all        send,edit,    0            │   │
│  │                              delete,fwd                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4c: Audit Log

```
┌─────────────────────────────────────────────────────────────────┐
│  Agents  ─  [Tokens]  [Roles]  [Audit Log]                     │
│                                                                 │
│  Filter: [All actions ▼]  [All agents ▼]  [Date range]         │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Time         Agent          Action   Target             │   │
│  │  ─────────────────────────────────────────────────────  │   │
│  │  Mar 14 12:34 work-claude    send     Design Team Chat  │   │
│  │  Mar 14 11:02 work-claude    edit     Design Team Chat  │   │
│  │  Mar 14 09:15 scout-bot      forward  Saved Messages    │   │
│  │  Mar 13 08:41 work-claude    send     @john_doe         │   │
│  │  Mar 12 16:22 work-claude    send     @jane_smith       │   │
│  │  Mar 12 14:05 work-claude    delete   @john_doe         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│                      [Load more ↓]                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Create Token Modal

```
┌───────────────────────────────────────┐
│  Create Agent Token                   │
│                                       │
│  Label:    [________________________] │
│  Role:     [work-assistant        ▼] │
│  Account:  [primary               ▼] │
│  Expires:  [Never  ▼]  or  [date]    │
│                                       │
│            [Cancel]  [Create Token]   │
└───────────────────────────────────────┘

         ↓ after creation ↓

┌───────────────────────────────────────┐
│  Token Created                    ✓   │
│                                       │
│  Copy this token now — it won't be    │
│  shown again.                         │
│                                       │
│  ┌─────────────────────────────────┐ │
│  │ a1b2c3d4e5f6...              📋 │ │
│  └─────────────────────────────────┘ │
│                                       │
│                           [Done]      │
└───────────────────────────────────────┘
```

### Create Role Modal

```
┌───────────────────────────────────────────┐
│  Create Role                              │
│                                           │
│  Name:       [________________________]   │
│                                           │
│  ── Read Scope ──                         │
│  Mode:       (•) All  ( ) Whitelist       │
│              ( ) Blacklist                 │
│  Labels:     [work, clients           ]   │
│  Chat IDs:   [                        ]   │
│                                           │
│  ── Write Permissions ──                  │
│  [x] Send    [ ] Edit                     │
│  [ ] Delete  [ ] Forward                  │
│                                           │
│  ── Write Scope (empty = inherit read) ── │
│  Chat types: [ ] user [x] group           │
│              [ ] supergroup [ ] channel    │
│  Labels:     [                        ]   │
│                                           │
│          [Cancel]  [Create Role]          │
└───────────────────────────────────────────┘
```

---

## Page 5: Outbox

Manage drafts, scheduled, and sent messages. View delivery status.

```
┌─────────────────────────────────────────────────────────────────┐
│  Outbox                                                         │
│                                                                 │
│  [All] [Drafts (2)] [Scheduled (1)] [Pending] [Sent] [Failed]  │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  DRAFT · @jane_smith                       [Edit] [Del] │   │
│  │  "Hey, wanted to follow up on the proposal..."          │   │
│  │  Created: Mar 14 10:00                     [Send →]     │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  DRAFT · Design Team Chat                  [Edit] [Del] │   │
│  │  "Meeting notes from today: 1. Dashboard..."            │   │
│  │  Created: Mar 14 09:30                     [Send →]     │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  SCHEDULED · @john_doe                     [Cancel]     │   │
│  │  "Reminder: review PR #42 by EOD"                       │   │
│  │  Scheduled: Mar 15 09:00                                │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  SENT ✓ · @alice · Mar 13 14:32                         │   │
│  │  "The updated designs are ready for review"             │   │
│  ├─────────────────────────────────────────────────────────┤   │
│  │  PARTIAL ⚠ · Mass send (3/5 delivered)    [Details]     │   │
│  │  "Hi {first_name}, quick update on..."                  │   │
│  │  Sent: Mar 12 16:00                                     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Mass Send Detail (expand)

```
┌─────────────────────────────────────────────────────────────────┐
│  ← Outbox  /  Mass Send #42                                    │
│                                                                 │
│  Template: "Hi {first_name}, quick update on the project..."   │
│  Sent: Mar 12 16:00                                            │
│                                                                 │
│  Recipients:                                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  @alice        Alice Johnson     ✓ sent   16:00:02      │   │
│  │  @bob          Bob Smith         ✓ sent   16:00:05      │   │
│  │  @carol        Carol Williams    ✓ sent   16:00:09      │   │
│  │  @dave         Dave Brown        ✗ failed FLOOD_WAIT    │   │
│  │  @eve          Eve Davis         ✗ failed FLOOD_WAIT    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│                                           [Retry failed (2)]    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Page 6: Settings

```
┌─────────────────────────────────────────────────────────────────┐
│  Settings                                                       │
│                                                                 │
│  ── Sync Mode ──                                               │
│  Global default:  (•) All  ( ) Whitelist  ( ) Blacklist        │
│                   ( ) None                                      │
│                                           [Save]                │
│                                                                 │
│  ── Accounts ──                                                │
│  Active account: primary (7926042351)                           │
│                                                                 │
│  ── Audit Log Retention ──                                     │
│  Keep audit entries for: [90] days  (0 = disabled)             │
│                                           [Save]                │
│                                                                 │
│  ── API Info ──                                                │
│  Worker URL: https://tg-reader.ddohne.workers.dev              │
│  MCP endpoint: /mcp                                            │
│  OpenAPI spec: /openapi.yaml                                   │
│                                                                 │
│  ── Backfill ──                                                │
│  [Trigger full re-seed]  (re-fetches dialog list)              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Color Palette & Typography

```
Background:       #0f1117  (near-black)
Surface:          #1a1d27  (cards, sidebar)
Surface hover:    #242836
Border:           #2a2e3a
Text primary:     #e4e4e7  (zinc-200)
Text secondary:   #a1a1aa  (zinc-400)
Accent:           #3b82f6  (blue-500)
Success:          #22c55e  (green-500)
Warning:          #eab308  (yellow-500)
Error:            #ef4444  (red-500)

Font:             Inter (UI), JetBrains Mono (IDs, tokens, code)
```

---

## Responsive Breakpoints

| Breakpoint | Behavior |
|------------|----------|
| ≥1024px    | Full sidebar + content |
| 768–1023px | Collapsed sidebar (icons only), full content |
| <768px     | Bottom nav bar, stacked cards |

---

## API Endpoints Needed (New)

The existing API covers most needs. New endpoints for the dashboard:

| Endpoint | Purpose | Notes |
|----------|---------|-------|
| `GET /stats/volume` | Message volume over time | `?days=30&bucket=day` — returns `[{date, count}]` |
| `GET /audit` | Paginated audit log | `?action=&token_label=&limit=&offset=` (RBAC feature) |

Everything else (search, chats, config, outbox, backfill, roles, tokens) already exists.

---

## Implementation Priority

| Phase | Pages | Effort |
|-------|-------|--------|
| 1     | Overview + Search | Core value — read the archive |
| 2     | Chats (list + detail + config) | Chat management |
| 3     | Agents (tokens + roles + audit) | After RBAC merge |
| 4     | Outbox + Settings | Write features |

---

## Component Inventory (for Pencil.dev)

Build these reusable components in Pencil.dev:

1. **StatCard** — icon, label, big number, optional delta badge
2. **DataTable** — sortable columns, row click, optional actions column
3. **SearchBar** — input + filter dropdowns + debounce
4. **MessageCard** — chat name, sender, timestamp, text snippet, highlight match
5. **ChatRow** — name, type badge, label chips, last activity, message count
6. **TokenRow** — label, role, last used, expiry with warning
7. **AuditRow** — timestamp, agent, action icon, target
8. **OutboxItem** — status badge, recipient, text preview, action buttons
9. **Modal** — header, form content, cancel/confirm buttons
10. **FilterBar** — pill toggles for status/type filtering
11. **Sidebar** — nav items with icons, collapsible
12. **PageHeader** — title, breadcrumb, action button(s)

---

## Pencil.dev Project Setup

### Screens to create (in order)

1. `01-overview` — Stats + chart + backfill + agent activity + audit preview
2. `02-search` — Search bar + filters + result cards
3. `03-chats-list` — Chat list with filters and sort
4. `04-chat-detail` — Split view: config panel + message history
5. `05-agents-tokens` — Token table + create modal
6. `06-agents-roles` — Role table + create modal
7. `07-agents-audit` — Audit log with filters
8. `08-outbox` — Outbox list with status tabs
9. `09-outbox-mass-detail` — Mass send recipient breakdown
10. `10-settings` — Config forms
11. `11-login` — Token entry screen

### Prototype flows to wire up

- Login → Overview
- Overview "view all" → Audit Log
- Search result click → Chat Detail (scrolled to message)
- Chat list row click → Chat Detail
- "Create Token" button → Modal → Token created confirmation
- "Create Role" button → Modal
- Outbox "Details" → Mass send detail
- Sidebar navigation between all pages

---

## Notes

- The dashboard is optional — the system works fully without it via MCP/API
- No message composition UI needed — agents handle writing via MCP tools
- The outbox page is read/manage only (edit drafts, cancel scheduled) — not a compose interface
- All timestamps display in user's local timezone (store as Unix seconds, convert on render)
- Token values are never displayed after creation — only labels and metadata
