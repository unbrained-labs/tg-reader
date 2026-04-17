// ---------------------------------------------------------------------------
// MCP tool definitions — static schema objects served via tools/list
// ---------------------------------------------------------------------------

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'search',
    description: 'Full-text search across the complete Telegram message archive. Ranked by recency (newest first). Use for any question about past conversations, finding specific messages, amounts, names, or topics. Always use from/to when the user mentions a time period. Multiple words in `query` are ANDed — every word must appear. If a broad search returns 0 results, retry with a single shorter token. Omit `query` to list messages by filters alone (e.g. everything from one sender, or all photos in a chat). For finding a person by name, use `senders` first; for messages from a saved contact, use `sender_username`. Response: { messages, page: { has_more, next_cursor, total } }. For more pages, pass `page.next_cursor` back as `cursor`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional. Full-text keywords; multiple words are ANDed. Omit to list messages by filters alone.' },
        chat_id: { type: 'string', description: 'Optional. Filter to one chat (get IDs from the chats tool).' },
        chat_type: { type: 'string', enum: ['user', 'group', 'supergroup', 'channel', 'bot'], description: 'Optional. Restrict to one chat type — e.g. "user" for DMs only.' },
        sender_username: { type: 'string', description: 'Optional. Exact-match sender username (without @). Use for saved contacts.' },
        sender_name: { type: 'string', description: 'Optional. Partial match (case-insensitive) across sender username/first_name/last_name. Use when you only know the display name. Pairs well with `senders` for discovery.' },
        media_type: { type: 'string', description: 'Optional. Restrict to messages containing this media type (e.g. "photo", "video", "voice", "document").' },
        forwarded_from_name: { type: 'string', description: 'Optional. Partial match on the forwarded-from name — find messages forwarded from a given source.' },
        from: { type: 'string', description: 'Optional. Start of date range. ISO 8601 or Unix epoch seconds.' },
        to: { type: 'string', description: 'Optional. End of date range. ISO 8601 or Unix epoch seconds. Defaults to tomorrow.' },
        limit: { type: 'number', description: 'Results per page (1–50, default 20).' },
        cursor: { type: 'string', description: 'Opaque pagination cursor. Pass `page.next_cursor` from the previous response to get the next page.' },
      },
    },
  },
  {
    name: 'chats',
    description: 'List all Telegram chats (groups, channels, DMs) with message counts and last activity. Use to discover chat IDs before calling history, or to find which chat a conversation happened in. Optionally filter by name, label, chat type, or who wrote last.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional. Filter chats by name (case-insensitive partial match). Example: "DevOps" matches "DevOps Team" and "devops-general".' },
        label: { type: 'string', description: 'Optional. Filter by label (e.g. "work", "personal"). Only returns chats that have that label set in chat_config.' },
        chat_type: { type: 'string', enum: ['user', 'group', 'supergroup', 'channel'], description: 'Optional. Filter by chat type: "user" for DMs, "group" for basic groups, "supergroup" for large groups, "channel" for broadcast channels.' },
        filter: { type: 'string', enum: ['unanswered'], description: 'Optional. "unanswered" returns only chats where someone else wrote the last message (you haven\'t replied). Useful for CRM-style follow-up queries.' },
        sort_by: { type: 'string', enum: ['last_activity', 'message_count'], description: 'Optional. Sort order: "last_activity" (default, newest message first) or "message_count" (most messages first, use for "most active chats").' },
      },
    },
  },
  {
    name: 'history',
    description: 'Get messages from one chat in chronological order (oldest first). Use after `chats` gives you a chat_id. For finding specific content within a chat, prefer search with chat_id filter. Response: { messages, page: { has_more, next_cursor } }. Pass `page.next_cursor` back as `cursor` to advance forward in time.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID (string, may be negative for groups/channels). Get from the chats tool.' },
        limit: { type: 'number', description: 'Messages per page (default 20, max 50).' },
        cursor: { type: 'string', description: 'Opaque pagination cursor. Pass `page.next_cursor` from the previous response to advance forward in time.' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'address_book',
    description: 'List your SAVED phone contacts (people explicitly saved in your Telegram address book) with username, name, and message count. Only ~10-15% of people you talk to are here — for finding anyone else (group members, random DMs, unsaved senders), use the `senders` tool instead. Use has_messages: true to filter out phone contacts who never messaged on Telegram.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional. Filter by name or username (case-insensitive partial match).' },
        has_messages: { type: 'boolean', description: 'Optional. If true, only return contacts who have at least one message in the archive.' },
      },
    },
  },
  {
    name: 'senders',
    description: 'Find ANYONE who has ever sent a message in your archive — not just saved contacts. Partial-match (case-insensitive) across username, first name, last name. Results include `in_address_book` flag and `top_chats` showing where that person is most active, so you can disambiguate "which Alex did you mean?" in one call. Prefer this over `address_book` whenever the user asks about a person by name or handle.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Name or handle fragment (case-insensitive). Leave empty to list recent senders across all chats.' },
        chat_id: { type: 'string', description: 'Optional. Restrict to senders active in this chat — use for "Alex in Keyring" disambiguation.' },
        limit: { type: 'number', description: 'Results per page (1–50, default 20).' },
        offset: { type: 'number', description: 'Offset for pagination.' },
        include_top_chats: { type: 'boolean', description: 'Default true. Include each sender\'s top 3 chats by message count.' },
      },
    },
  },
  {
    name: 'stats',
    description: 'Get archive statistics: total message count, date range, number of chats and contacts, sent vs received breakdown. Use this first when the user asks about the archive, or to discover what date range is available before searching.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'digest',
    description: 'Get a digest of recent messages grouped by chat, showing the latest N messages per active chat. Use this for "what happened today/this week", morning briefings, or to catch up on activity across all chats. Each chat entry includes its label (work/personal) when set.',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: 'Look-back window in hours (default 24). Use 168 for a weekly digest.' },
        per_chat: { type: 'number', description: 'Max messages per chat to return (default 5, max 20).' },
        label: { type: 'string', description: 'Optional. Filter to chats with this label (e.g. "work").' },
      },
    },
  },
  {
    name: 'thread',
    description: 'Get a message and its reply thread (parent + all direct replies). Use when you want the full context of a conversation around a specific message. Response: { chat_id, message_id, messages, page: { has_more, next_cursor } }. Pass `page.next_cursor` back as `cursor` for more replies.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID containing the message.' },
        message_id: { type: 'string', description: 'The tg_message_id of the message to reconstruct the thread around.' },
        limit: { type: 'number', description: 'Max replies to return (default 50, max 200).' },
        cursor: { type: 'string', description: 'Opaque pagination cursor. Pass `page.next_cursor` from the previous response.' },
      },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'send',
    description: 'Queue a Telegram message for immediate sending (or schedule it). For single-chat sends, provide tg_chat_id. For mass sends, provide a recipients array. GramJS picks it up within 30 seconds. Returns the outbox id.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Target chat ID for a single send. Omit for mass send.' },
        text: { type: 'string', description: 'Message text. Supports {first_name}, {last_name}, {username}, {user} placeholders for mass sends.' },
        reply_to_message_id: { type: 'number', description: 'Optional. Reply to this message ID.' },
        scheduled_at: { type: 'number', description: 'Optional. Unix epoch seconds to send at. Omit to send immediately.' },
        recipients: { type: 'array', description: 'For mass send: array of {tg_chat_id, first_name?, last_name?, username?} objects.', items: { type: 'object' } },
      },
      required: ['text'],
    },
  },
  {
    name: 'draft',
    description: 'Save a message as a draft (not queued for sending yet). Returns the outbox id. Use send tool or POST /outbox/:id/send to promote to pending/scheduled later.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Target chat ID for a single send.' },
        text: { type: 'string', description: 'Message text. Supports {first_name}, {last_name}, {username}, {user} placeholders.' },
        reply_to_message_id: { type: 'number', description: 'Optional. Reply to this message ID.' },
        recipients: { type: 'array', description: 'For mass send drafts.', items: { type: 'object' } },
      },
      required: ['text'],
    },
  },
  {
    name: 'edit_message',
    description: 'Edit an already-sent Telegram message. Queues an edit action; GramJS executes it within 30 seconds and the archive is updated automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Chat ID of the message to edit.' },
        tg_message_id: { type: 'string', description: 'Message ID to edit.' },
        text: { type: 'string', description: 'New text for the message.' },
      },
      required: ['tg_chat_id', 'tg_message_id', 'text'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete an already-sent Telegram message (revokes from both sides). Queues a delete action; GramJS executes it within 30 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Chat ID of the message to delete.' },
        tg_message_id: { type: 'string', description: 'Message ID to delete.' },
      },
      required: ['tg_chat_id', 'tg_message_id'],
    },
  },
  {
    name: 'forward_message',
    description: 'Forward an existing Telegram message to another chat. Queues a forward action; GramJS executes it within 30 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Source chat ID.' },
        tg_message_id: { type: 'string', description: 'Message ID to forward.' },
        to_chat_id: { type: 'string', description: 'Destination chat ID.' },
      },
      required: ['tg_chat_id', 'tg_message_id', 'to_chat_id'],
    },
  },
  {
    name: 'outbox_status',
    description: 'Check the delivery status of a sent or scheduled message by its outbox id. Returns status (pending/sending/sent/failed/scheduled/partial), sent_at, and any error. Use after send to confirm delivery, or to check if a scheduled message is still queued.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Outbox id returned by the send or draft tool.' },
      },
      required: ['id'],
    },
  },
  // ---------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------
  {
    name: 'whoami',
    description: 'Return the identity and permissions of the current caller. Shows whether using MASTER_TOKEN or a scoped agent token, and the associated role with read/write capabilities.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ---------------------------------------------------------------------------
  // Role management — MASTER_TOKEN only
  // ---------------------------------------------------------------------------
  {
    name: 'create_role',
    description: 'Create a new RBAC role. MASTER_TOKEN required. Roles define read scope (all/whitelist/blacklist), write permissions (can_send, can_edit, can_delete, can_forward), and optional write scope overrides.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique role name (e.g. "work-reader", "dm-assistant").' },
        read_mode: { type: 'string', enum: ['all', 'whitelist', 'blacklist'], description: 'Read scope mode. "all" = no restriction. "whitelist" = only allowed chats. "blacklist" = all except blocked chats.' },
        read_labels: { type: 'array', items: { type: 'string' }, description: 'Optional. For whitelist/blacklist: filter by chat labels (e.g. ["work", "clients"]).' },
        read_chat_ids: { type: 'array', items: { type: 'string' }, description: 'Optional. For whitelist/blacklist: filter by specific tg_chat_ids.' },
        can_send: { type: 'boolean', description: 'Allow sending messages (default false).' },
        can_edit: { type: 'boolean', description: 'Allow editing sent messages (default false).' },
        can_delete: { type: 'boolean', description: 'Allow deleting messages (default false).' },
        can_forward: { type: 'boolean', description: 'Allow forwarding messages (default false).' },
        write_chat_types: { type: 'array', items: { type: 'string' }, description: 'Optional. Restrict writes to these chat types (e.g. ["user"]). Null = inherit read scope.' },
        write_labels: { type: 'array', items: { type: 'string' }, description: 'Optional. Restrict writes to chats with these labels. Null = inherit read scope.' },
        write_chat_ids: { type: 'array', items: { type: 'string' }, description: 'Optional. Restrict writes to these specific chat IDs. Null = inherit read scope.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_roles',
    description: 'List all RBAC roles with their permissions and scope configuration. MASTER_TOKEN required.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_role',
    description: 'Update fields on an existing role by name. Only provided fields are changed. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Current name of the role to update.' },
        new_name: { type: 'string', description: 'Rename the role to this value.' },
        read_mode: { type: 'string', enum: ['all', 'whitelist', 'blacklist'] },
        read_labels: { type: 'array', items: { type: 'string' } },
        read_chat_ids: { type: 'array', items: { type: 'string' } },
        can_send: { type: 'boolean' },
        can_edit: { type: 'boolean' },
        can_delete: { type: 'boolean' },
        can_forward: { type: 'boolean' },
        write_chat_types: { type: 'array', items: { type: 'string' } },
        write_labels: { type: 'array', items: { type: 'string' } },
        write_chat_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_role',
    description: 'Delete a role by name. Fails if any token still references this role. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the role to delete.' },
      },
      required: ['name'],
    },
  },
  // ---------------------------------------------------------------------------
  // Token management — MASTER_TOKEN only
  // ---------------------------------------------------------------------------
  {
    name: 'create_token',
    description: 'Create a scoped agent token bound to a role for one or more accounts. Returns the raw token once — store it securely, it cannot be recovered. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role name to bind this token to.' },
        label: { type: 'string', description: 'Optional human-readable label (e.g. "Claude work assistant").' },
        account_id: { type: 'string', description: 'Account to bind to. Defaults to "primary".' },
        expires_at: { type: 'number', description: 'Optional. Unix epoch seconds expiry. Omit for no expiry.' },
      },
      required: ['role'],
    },
  },
  {
    name: 'list_tokens',
    description: 'List all agent tokens with their label, role, expiry, and last-used timestamp. Raw token values are never returned. MASTER_TOKEN required.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'revoke_token',
    description: 'Permanently delete an agent token by its numeric ID. The associated token_account_roles rows are cascade-deleted. Audit log rows are preserved. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        token_id: { type: 'string', description: 'Token ID (string) as returned by list_tokens.' },
      },
      required: ['token_id'],
    },
  },
  // ---------------------------------------------------------------------------
  // Observer job management — MASTER_TOKEN only
  // ---------------------------------------------------------------------------
  {
    name: 'create_job',
    description: 'Create an observer job that runs an AI agent on a schedule or trigger. Auto-creates a scoped token for the job if a role name is provided. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique job name.' },
        schedule: { type: 'string', description: 'Optional. Stored for reference only — cron expression evaluation is not yet implemented. The actual run frequency is controlled by cooldown_secs and the 15-minute cron tick. At least one of schedule or trigger_type is required.' },
        trigger_type: { type: 'string', enum: ['new_message', 'keyword', 'unanswered'], description: 'Optional. Trigger condition type.' },
        trigger_config: { type: 'object', description: 'Optional. Config for the trigger (chat_id, label, keywords, hours).' },
        model_config: { type: 'object', description: 'BYOM config: { provider, model, api_key_ref?, endpoint? }. provider="anthropic", "openai", or "cloudflare-ai". For cloudflare-ai, omit api_key_ref — uses the built-in Workers AI binding (no extra cost, no API key). Recommended free model: @cf/meta/llama-3.3-70b-instruct-fp8-fast.' },
        task_prompt: { type: 'string', description: 'Task prompt for the agent. Supports {chat_name}, {chat_id}, {sender}, {snippet}, {timestamp}, {account_id} variables.' },
        role: { type: 'string', description: 'Role name. A scoped token will be auto-created for this job.' },
        cooldown_secs: { type: 'number', description: 'Minimum seconds between runs (default 3600). Prevents repeated firing on active chats.' },
      },
      required: ['name', 'model_config', 'task_prompt'],
    },
  },
  {
    name: 'list_jobs',
    description: 'List all observer jobs with status, schedule, trigger, last run time, and token label. MASTER_TOKEN required.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'toggle_job',
    description: 'Enable or disable an observer job by name. Does not revoke its token. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name.' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable.' },
      },
      required: ['name', 'enabled'],
    },
  },
  {
    name: 'delete_job',
    description: 'Delete an observer job by name. The associated token is NOT automatically revoked — use revoke_token separately if needed. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name to delete.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_job',
    description: 'Update fields on an existing observer job. Only provided fields are changed. MASTER_TOKEN required.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Job name to update.' },
        task_prompt: { type: 'string' },
        schedule: { type: 'string' },
        trigger_type: { type: 'string' },
        trigger_config: { type: 'object' },
        model_config: { type: 'object' },
        cooldown_secs: { type: 'number' },
      },
      required: ['name'],
    },
  },
  // ---------------------------------------------------------------------------
  // AI Chat Insights tools — MASTER_TOKEN only
  // ---------------------------------------------------------------------------
  {
    name: 'get_insights',
    description: 'Return the cached AI insight for a chat. Returns null if no insight has been generated yet. Use this to display insights in the UI or check if regeneration is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Telegram chat ID to fetch insight for.' },
      },
      required: ['tg_chat_id'],
    },
  },
  {
    name: 'generate_insight',
    description: 'Check if a chat has new messages since the last insight (delta check), then call the LLM to generate a fresh insight and store it. Skips if nothing has changed. Returns { skipped: true } if no new messages, or the new insight data if regenerated. Use this in observer jobs that run nightly.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Telegram chat ID to analyse.' },
        model: { type: 'string', description: 'Model identifier used for generation (stored for audit). E.g. "claude-haiku-4-5".' },
        message_limit: { type: 'number', description: 'Max messages to pass to the LLM. Default 500. Use higher values for deep analysis of quiet chats.' },
      },
      required: ['tg_chat_id'],
    },
  },
  {
    name: 'upsert_insight',
    description: 'Directly write a structured insight for a chat. Use this when the observer job generates the insight externally and wants to store the result. The data object must match the insight schema.',
    inputSchema: {
      type: 'object',
      properties: {
        tg_chat_id: { type: 'string', description: 'Telegram chat ID.' },
        model: { type: 'string', description: 'Model used to generate this insight.' },
        data: { type: 'object', description: 'Insight data object: { tone, tone_trend?, topics, relationship_arc?, initiated_by?, avg_response_time_hrs?, unresolved_threads?, last_active_days_ago?, summary, follow_up? }' },
      },
      required: ['tg_chat_id', 'model', 'data'],
    },
  },
];
