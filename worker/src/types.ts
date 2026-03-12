// Cloudflare Worker environment bindings
export interface Env {
  DB: D1Database;
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
  is_deleted?: number;
  deleted_at?: number;
}
