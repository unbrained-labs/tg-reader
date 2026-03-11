/**
 * tg — CLI for the Telegram Personal Archive
 *
 * Usage:
 *   tg init
 *   tg search <query> [--chat <id>] [--from <date>] [--to <date>] [--limit N]
 *   tg chats
 *   tg history <chat_id> [--before <message_id>] [--limit N]
 *   tg contacts [--search <name>]
 *   tg recent [--limit N]
 *
 * Connection config saved to ~/.tg-reader.json by `tg init`.
 * Env vars (WORKER_URL, INGEST_TOKEN, ACCOUNT_ID) override the config file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

// ---------------------------------------------------------------------------
// Config file (~/.tg-reader.json)
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(os.homedir(), '.tg-reader.json');

interface Config {
  workerUrl?: string;
  ingestToken?: string;
  accountId?: string;
}

function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch {
    return {};
  }
}

function saveConfig(cfg: Config): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

const _cfg = loadConfig();
const WORKER_URL = (process.env.WORKER_URL ?? _cfg.workerUrl)?.replace(/\/$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? _cfg.ingestToken;
const ACCOUNT_ID = process.env.ACCOUNT_ID ?? _cfg.accountId;

// ---------------------------------------------------------------------------
// ANSI colors (no deps)
// ---------------------------------------------------------------------------

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  blue:   '\x1b[34m',
  gray:   '\x1b[90m',
};

function c(color: keyof typeof C, text: string): string {
  return C[color] + text + C.reset;
}

// ---------------------------------------------------------------------------
// Error & exit
// ---------------------------------------------------------------------------

function die(msg: string): never {
  process.stderr.write(c('red', 'Error: ') + msg + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [, , command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function flag(flags: Record<string, string | true>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

function flagInt(flags: Record<string, string | true>, name: string, fallback: number): number {
  const v = flag(flags, name);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function toEpoch(input: string): number {
  // Already an epoch integer
  if (/^\d{10,}$/.test(input)) return parseInt(input, 10);
  const d = new Date(input);
  if (isNaN(d.getTime())) die(`Invalid date: "${input}". Use ISO format (2024-01-15) or epoch seconds.`);
  return Math.floor(d.getTime() / 1000);
}

function formatDate(epochSec: number | null | undefined): string {
  if (!epochSec) return c('gray', '—');
  const now = Math.floor(Date.now() / 1000);
  const diff = now - epochSec;

  if (diff < 60)          return c('green', 'just now');
  if (diff < 3600)        return c('green', `${Math.floor(diff / 60)}m ago`);
  if (diff < 86400)       return c('yellow', `${Math.floor(diff / 3600)}h ago`);
  if (diff < 7 * 86400)   return c('yellow', `${Math.floor(diff / 86400)}d ago`);

  const d = new Date(epochSec * 1000);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const thisYear = new Date().getFullYear();
  if (d.getFullYear() === thisYear) {
    return `${months[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

function pad(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function apiGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!WORKER_URL) die('WORKER_URL is not set.');
  if (!INGEST_TOKEN) die('INGEST_TOKEN is not set.');
  if (!ACCOUNT_ID) die('ACCOUNT_ID is not set. Set it to your Telegram user ID (shown in fly logs on startup).');

  const url = new URL(WORKER_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: {
        'X-Ingest-Token': INGEST_TOKEN,
        'X-Account-ID': ACCOUNT_ID,
      },
    });
  } catch (err) {
    die(`Network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const body = await res.json() as unknown;

  if (!res.ok) {
    const errMsg = (body as Record<string, unknown>)?.error;
    die(`API error ${res.status}: ${errMsg ?? res.statusText}`);
  }

  return body as T;
}

// ---------------------------------------------------------------------------
// Table renderer (plain ASCII, no libs)
// ---------------------------------------------------------------------------

type Row = (string | number | null | undefined)[];

function renderTable(headers: string[], rows: Row[]): void {
  const colCount = headers.length;
  const widths = headers.map((h) => h.length);

  // Measure visible widths (strip ANSI escape codes for width calc)
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  const stringified = rows.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return c('gray', '—');
      return String(cell);
    })
  );

  for (const row of stringified) {
    for (let i = 0; i < colCount; i++) {
      const visible = stripAnsi(row[i] ?? '').length;
      if (visible > widths[i]) widths[i] = visible;
    }
  }

  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const renderRow = (cells: string[]) =>
    '| ' + cells.map((cell, i) => {
      const visible = stripAnsi(cell).length;
      return cell + ' '.repeat(widths[i] - visible);
    }).join(' | ') + ' |';

  console.log(sep);
  console.log(renderRow(headers.map((h) => c('bold', h))));
  console.log(sep);

  if (rows.length === 0) {
    const totalWidth = widths.reduce((a, b) => a + b + 3, 1);
    console.log('|' + c('gray', ' (no results)').padEnd(totalWidth - 1) + '|');
  } else {
    for (const row of stringified) {
      console.log(renderRow(row));
    }
  }

  console.log(sep);
}

// ---------------------------------------------------------------------------
// Message formatter (for search / history / recent)
// ---------------------------------------------------------------------------

interface Message {
  tg_message_id: number;
  tg_chat_id: string;
  chat_name: string | null;
  sender_first_name: string | null;
  sender_last_name: string | null;
  sender_username: string | null;
  direction: 'in' | 'out' | null;
  text: string | null;
  media_type: string | null;
  message_type: string | null;
  sent_at: number;
}

function senderLabel(msg: Message): string {
  if (msg.direction === 'out') return c('blue', 'You');
  const name = [msg.sender_first_name, msg.sender_last_name].filter(Boolean).join(' ');
  if (name) return c('cyan', name);
  if (msg.sender_username) return c('cyan', '@' + msg.sender_username);
  return c('gray', 'Unknown');
}

function textPreview(msg: Message, maxLen = 80): string {
  if (msg.text) {
    const t = msg.text.replace(/\n/g, ' ');
    return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t;
  }
  if (msg.media_type) return c('gray', `[${msg.media_type}]`);
  if (msg.message_type) return c('gray', `[${msg.message_type}]`);
  return c('gray', '[empty]');
}

function printMessages(messages: Message[], showChat = true): void {
  if (messages.length === 0) {
    console.log(c('gray', 'No messages found.'));
    return;
  }

  for (const msg of messages) {
    const ts   = formatDate(msg.sent_at);
    const chat = showChat && msg.chat_name ? c('yellow', `[${msg.chat_name}]`) + ' ' : '';
    const from = senderLabel(msg);
    const text = textPreview(msg);
    const id   = c('dim', `#${msg.tg_message_id}`);
    console.log(`${ts}  ${chat}${from}: ${text}  ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface SearchResponse {
  results: Message[];
  total: number;
  limit: number;
  next_before_id: number | null;
}

async function cmdSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional[0];
  if (!query) die('Usage: tg search <query> [--chat <id>] [--from <date>] [--to <date>] [--limit N]');

  const params: Record<string, string | number | undefined> = {
    q:     query,
    limit: flagInt(args.flags, 'limit', 50),
  };

  const chatId = flag(args.flags, 'chat');
  if (chatId) params.chat_id = chatId;

  const from = flag(args.flags, 'from');
  if (from) params.from = toEpoch(from);

  const to = flag(args.flags, 'to');
  if (to) params.to = toEpoch(to);

  const data = await apiGet<SearchResponse>('/search', params);

  console.log(c('bold', `Search: "${query}"`) + c('gray', ` — ${data.total} total, showing ${data.results.length}`));
  console.log();
  printMessages(data.results, true);
}

interface Chat {
  tg_chat_id: string;
  chat_name: string | null;
  chat_type: string | null;
  message_count: number;
  last_message_at: number | null;
  sync_status: string;
}

async function cmdChats(): Promise<void> {
  const chats = await apiGet<Chat[]>('/chats');

  const syncColor = (s: string) => {
    if (s === 'exclude') return c('red', s);
    if (s === 'include') return c('green', s);
    return c('gray', s);
  };

  const rows: Row[] = chats.map((ch) => [
    ch.tg_chat_id,
    ch.chat_name ?? c('gray', '—'),
    ch.chat_type ?? c('gray', '—'),
    ch.message_count.toLocaleString(),
    formatDate(ch.last_message_at),
    syncColor(ch.sync_status),
  ]);

  console.log(c('bold', `Chats (${chats.length})`));
  console.log();
  renderTable(['Chat ID', 'Name', 'Type', 'Messages', 'Last message', 'Sync'], rows);
}

async function cmdHistory(args: ParsedArgs): Promise<void> {
  const chatId = args.positional[0];
  if (!chatId) die('Usage: tg history <chat_id> [--before <message_id>] [--limit N]');

  const limit = flagInt(args.flags, 'limit', 50);

  const params: Record<string, string | number | undefined> = {
    chat_id: chatId,
    limit,
  };

  const beforeId = flag(args.flags, 'before');
  if (beforeId) params.before_id = parseInt(beforeId, 10);

  const data = await apiGet<SearchResponse>('/search', params);

  // Worker returns newest-first; reverse to chronological for history view
  const messages = [...data.results].reverse();

  const chatName = messages[0]?.chat_name ?? chatId;
  const pagination = data.next_before_id
    ? c('gray', `  (next: --before ${data.next_before_id})`)
    : '';
  console.log(c('bold', `History: ${chatName}`) + c('gray', ` (${messages.length} messages)`) + pagination);
  console.log();
  printMessages(messages, false);
}

interface Contact {
  tg_user_id: string;
  phone: string | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_mutual: number;
  is_bot: number;
  message_count: number;
  last_seen: number | null;
}

async function cmdContacts(args: ParsedArgs): Promise<void> {
  const contacts = await apiGet<Contact[]>('/contacts');

  const search = flag(args.flags, 'search')?.toLowerCase();
  const filtered = search
    ? contacts.filter((ct) => {
        const haystack = [ct.first_name, ct.last_name, ct.username, ct.phone]
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(search);
      })
    : contacts;

  const nameOf = (ct: Contact) => {
    const full = [ct.first_name, ct.last_name].filter(Boolean).join(' ');
    return full || c('gray', '—');
  };

  const rows: Row[] = filtered.map((ct) => [
    nameOf(ct),
    ct.username ? '@' + ct.username : c('gray', '—'),
    ct.message_count.toLocaleString(),
    formatDate(ct.last_seen),
    ct.is_mutual ? c('green', 'yes') : c('gray', 'no'),
    ct.is_bot ? c('yellow', 'bot') : '',
  ]);

  const title = search
    ? `Contacts matching "${search}" (${filtered.length})`
    : `Contacts (${filtered.length})`;

  console.log(c('bold', title));
  console.log();
  renderTable(['Name', 'Username', 'Messages', 'Last seen', 'Mutual', 'Bot'], rows);
}

async function cmdRecent(args: ParsedArgs): Promise<void> {
  const limit = flagInt(args.flags, 'limit', 20);

  const data = await apiGet<SearchResponse>('/search', { limit });

  console.log(c('bold', `Recent messages (${data.results.length})`));
  console.log();
  printMessages(data.results, true);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

async function cmdInit(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));

  console.log(c('bold', 'tg init') + ' — configure connection to your Telegram archive\n');

  const existing = loadConfig();

  const workerUrl = (await ask(
    `Worker URL ${existing.workerUrl ? c('gray', `[${existing.workerUrl}]`) + ' ' : ''}: `
  )).trim() || existing.workerUrl || '';

  const ingestToken = (await ask(
    `Ingest token ${existing.ingestToken ? c('gray', '[set]') + ' ' : ''}: `
  )).trim() || existing.ingestToken || '';

  const accountId = (await ask(
    `Account ID (numeric Telegram user ID) ${existing.accountId ? c('gray', `[${existing.accountId}]`) + ' ' : ''}: `
  )).trim() || existing.accountId || '';

  rl.close();

  if (!workerUrl || !ingestToken || !accountId) {
    die('All three values are required.');
  }

  saveConfig({ workerUrl, ingestToken, accountId });
  console.log('\n' + c('green', '✓') + ` Config saved to ${CONFIG_PATH}`);
  console.log(c('gray', `  Worker:  ${workerUrl}`));
  console.log(c('gray', `  Account: ${accountId}`));
}

function printHelp(): void {
  const cmd = (s: string) => c('cyan', s);
  const opt = (s: string) => c('gray', s);

  console.log(`
${c('bold', 'tg')} — Telegram Personal Archive CLI

${c('bold', 'Commands:')}
  ${cmd('tg init')}
      Configure connection (saved to ~/.tg-reader.json).

  ${cmd('tg search <query>')}  ${opt('[--chat <id>] [--from <date>] [--to <date>] [--limit N]')}
      Full-text search across all messages.
      Dates accept ISO (2024-01-15) or epoch seconds.

  ${cmd('tg chats')}
      List all chats with message counts and last activity.

  ${cmd('tg history <chat_id>')}  ${opt('[--before <message_id>] [--limit N]')}
      Show messages in a chat in chronological order.

  ${cmd('tg contacts')}  ${opt('[--search <name>]')}
      List contacts with message counts.

  ${cmd('tg recent')}  ${opt('[--limit N]')}
      Show last N messages across all chats (default: 20).

${c('bold', 'Setup:')}
  Run ${cmd('tg init')} first, or set env vars:
  WORKER_URL    Full URL of the deployed Cloudflare Worker
  INGEST_TOKEN  Shared auth token
  ACCOUNT_ID    Numeric Telegram user ID
`.trim() + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case 'init':     return cmdInit();
    case 'search':   return cmdSearch(args);
    case 'chats':    return cmdChats();
    case 'history':  return cmdHistory(args);
    case 'contacts': return cmdContacts(args);
    case 'recent':   return cmdRecent(args);
    case 'help':
    case '--help':
    case '-h':
    case '':         return printHelp();
    default:
      process.stderr.write(c('red', `Unknown command: ${args.command}`) + '\n\n');
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(c('red', 'Fatal: ') + (err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
});
