// Outbox recipient — one row per target for mass sends
export interface OutboxRecipient {
  id: number;
  outbox_id: number;
  tg_chat_id: string;   // always string — Telegram IDs are 64-bit
  first_name?: string;
  username?: string;
  last_name?: string;
  status: 'pending' | 'sent' | 'failed';
  sent_at?: number;
  error?: string;
}

// Outbox item — one row per message (draft / scheduled / single / mass)
export interface OutboxItem {
  id: number;
  account_id: string;
  tg_chat_id?: string;            // null for mass sends
  reply_to_message_id?: number;
  text: string;
  status: 'draft' | 'scheduled' | 'pending' | 'sending' | 'sent' | 'failed' | 'partial';
  scheduled_at?: number;          // unix epoch seconds
  error?: string;
  created_at: number;
  updated_at: number;
  sent_at?: number;
  recipients?: OutboxRecipient[]; // populated by /outbox/due
}

// Cloudflare Worker environment bindings
export interface Env {
  DATABASE_URL: string;
  BACKUP_BUCKET: R2Bucket;
  INGEST_TOKEN: string;
}

// Message row — matches schema.sql exactly
export interface Message {
  tg_message_id: string;  // TEXT in DB — Telegram IDs may exceed 32 bits
  tg_chat_id: string;           // always string — Telegram IDs are 64-bit
  chat_name?: string;
  chat_type?: 'user' | 'group' | 'supergroup' | 'channel' | 'bot';
  sender_id?: string;           // always string — Telegram IDs are 64-bit
  sender_username?: string;
  sender_first_name?: string;
  sender_last_name?: string;
  direction?: 'in' | 'out';
  message_type?: string;
  text?: string;
  media_type?: string;
  media_file_id?: string;
  reply_to_message_id?: number;
  forwarded_from_id?: string;
  forwarded_from_name?: string;
  sent_at: number;              // Unix epoch seconds — always integer, never new Date()
  edit_date?: number;
  original_text?: string;       // text before first edit; undefined/null if never edited
  is_deleted?: number;          // SMALLINT 0/1
  deleted_at?: number;
}
