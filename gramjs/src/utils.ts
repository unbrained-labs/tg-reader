import { Api } from 'telegram';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Peer / sender ID resolution
// ---------------------------------------------------------------------------

export function resolveSenderId(fromId: Api.TypePeer | null | undefined): string | undefined {
  if (!fromId) return undefined;
  if (fromId instanceof Api.PeerUser) return String(fromId.userId);
  if (fromId instanceof Api.PeerChat) return String(fromId.chatId);
  if (fromId instanceof Api.PeerChannel) return String(fromId.channelId);
  return undefined;
}

// ---------------------------------------------------------------------------
// Media / message type resolution
// ---------------------------------------------------------------------------

export function resolveMediaType(media: Api.TypeMessageMedia | null | undefined): string | undefined {
  if (!media) return undefined;
  if (media instanceof Api.MessageMediaPhoto) return 'photo';
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document;
    if (doc instanceof Api.Document) {
      for (const attr of doc.attributes) {
        if (attr instanceof Api.DocumentAttributeVideo) return 'video';
        if (attr instanceof Api.DocumentAttributeAudio) {
          return (attr as Api.DocumentAttributeAudio).voice ? 'voice' : 'audio';
        }
        if (attr instanceof Api.DocumentAttributeSticker) return 'sticker';
        if (attr instanceof Api.DocumentAttributeAnimated) return 'gif';
      }
    }
    return 'document';
  }
  if (media instanceof Api.MessageMediaGeo) return 'location';
  if (media instanceof Api.MessageMediaContact) return 'contact';
  if (media instanceof Api.MessageMediaPoll) return 'poll';
  if (media instanceof Api.MessageMediaDice) return 'dice';
  return 'other';
}

export function resolveMessageType(msg: Api.Message): string {
  if (msg.media) return resolveMediaType(msg.media) ?? 'media';
  if (msg.message) return 'text';
  return 'service';
}
