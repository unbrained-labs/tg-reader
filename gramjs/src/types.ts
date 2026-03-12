// Shared types for GramJS scripts.
// Mirrors worker/src/types.ts Message interface — kept in sync manually.

export interface Message {
  tg_message_id: string;  // TEXT in DB — Telegram IDs may exceed 32 bits
  tg_chat_id: string;
  chat_name?: string;
  chat_type?: 'user' | 'group' | 'supergroup' | 'channel' | 'bot';
  sender_id?: string;
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
  sent_at: number;
  edit_date?: number;
  original_text?: string;
  is_deleted?: number;
  deleted_at?: number;
}
