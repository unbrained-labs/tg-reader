#!/usr/bin/env tsx
/**
 * TG Reader — Interactive Setup Script (Phase 2 of issue #83)
 *
 * Automates first-time deployment across:
 *   - Neon (PostgreSQL)
 *   - Cloudflare Workers
 *   - Fly.io (GramJS listener)
 *   - Telegram auth (GramJS session)
 *   - MCP token minting
 *
 * Usage:
 *   npx tsx scripts/setup.ts
 *   npx tsx scripts/setup.ts --phase <phase-name>
 *
 * Phases: preflight, telegram-creds, telegram-auth, neon, worker, fly, mcp
 *
 * State is persisted to .setup-state.json between runs.
 * TODO: Add scripts/teardown.ts for cleanup (out of scope for Phase 2).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync, spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SetupState {
  preflight_ok?: boolean;
  // Phase B
  api_id?: number;
  api_hash?: string;
  phone_number?: string;
  // Phase C
  gramjs_session?: string; // sensitive — never log
  // Phase D
  neon_project_id?: string;
  neon_branch_id?: string;
  database_url?: string; // sensitive — never log
  neon_schema_applied?: boolean;
  // Phase E
  worker_name?: string;
  worker_url?: string;
  ingest_token?: string; // sensitive
  master_token?: string; // sensitive
  worker_deployed?: boolean;
  // Phase F
  fly_app_name?: string;
  fly_region?: string;
  fly_volume_created?: boolean;
  fly_secrets_set?: boolean;
  fly_deployed?: boolean;
  // Phase G
  mcp_role_name?: string;
  mcp_agent_token?: string; // sensitive
  my_user_id?: string;
  mcp_url?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, '.setup-state.json');
const SCHEMA_FILE = path.join(ROOT, 'schema.sql');
const WRANGLER_TOML = path.join(ROOT, 'worker', 'wrangler.toml');
const FLY_TOML = path.join(ROOT, 'gramjs', 'fly.toml');

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

function loadState(): SetupState {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveState(state: SetupState): void {
  // 0o600 — state contains secrets (session string, tokens, DB URL).
  // Not world-readable on multi-user machines.
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  // Re-apply mode on existing file (writeFileSync only sets mode on create).
  try { fs.chmodSync(STATE_FILE, 0o600); } catch { /* best effort */ }
}

// Strict name validator — used for anything that will be passed into a shell
// command or used as an external resource name. Alphanumerics, hyphens,
// underscores only. No spaces, no shell metacharacters.
function sanitizeName(label: string, value: string): string {
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(trimmed)) {
    throw new Error(
      `${label} must be 1–63 chars and contain only letters, digits, hyphens, or underscores. Got: ${JSON.stringify(trimmed)}`,
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

async function askWithDefault(question: string, defaultValue: string): Promise<string> {
  const answer = await ask(`${question} [${defaultValue}]: `);
  return answer || defaultValue;
}

async function askSecret(question: string): Promise<string> {
  return new Promise(resolve => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;

    let input = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode?.(wasRaw);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
      } else if (ch === '\u0003') {
        // Ctrl-C
        process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        input += ch;
        process.stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}

function print(msg: string): void {
  console.log(msg);
}

function printStep(phase: string, msg: string): void {
  console.log(`\n\x1b[36m[${phase}]\x1b[0m ${msg}`);
}

function printOk(msg: string): void {
  console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`);
}

function printSkip(msg: string): void {
  console.log(`\x1b[33m  ↩ ${msg}\x1b[0m`);
}

function printError(msg: string): void {
  console.error(`\x1b[31m  ✗ ${msg}\x1b[0m`);
}

function printWarn(msg: string): void {
  console.log(`\x1b[33m  ⚠ ${msg}\x1b[0m`);
}

function redacted(value: string | undefined): string {
  if (!value) return '(not set)';
  return '[redacted]';
}

// ---------------------------------------------------------------------------
// CLI utilities
// ---------------------------------------------------------------------------

function run(cmd: string, opts?: { cwd?: string; input?: string; ignoreError?: boolean }): string {
  try {
    const result = spawnSync('sh', ['-c', cmd], {
      cwd: opts?.cwd ?? ROOT,
      input: opts?.input,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0 && !opts?.ignoreError) {
      const stderr = result.stderr?.trim() || '';
      const stdout = result.stdout?.trim() || '';
      throw new Error(
        `Command failed (exit ${result.status}): ${cmd}\n${stderr || stdout}`
      );
    }
    return (result.stdout || '').trim();
  } catch (err) {
    if (opts?.ignoreError) return '';
    throw err;
  }
}

function commandExists(cmd: string): boolean {
  const result = spawnSync('which', [cmd], { encoding: 'utf8' });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Random suffix helper
// ---------------------------------------------------------------------------

function randomSuffix(length = 6): string {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

// ---------------------------------------------------------------------------
// File edit helpers (textual replacement — no templating machinery)
// ---------------------------------------------------------------------------

function replaceInFile(filePath: string, search: string, replacement: string): void {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes(search)) {
    throw new Error(`Pattern not found in ${filePath}: ${search}`);
  }
  fs.writeFileSync(filePath, content.replace(search, replacement), 'utf8');
}

function backupFile(filePath: string): void {
  const backupPath = filePath + '.setup-backup';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
    printOk(`Backed up ${path.basename(filePath)} → ${path.basename(backupPath)}`);
  } else {
    printSkip(`Backup already exists: ${path.basename(backupPath)}`);
  }
}

// ---------------------------------------------------------------------------
// Phase A — Preflight checks
// ---------------------------------------------------------------------------

async function phaseA(state: SetupState): Promise<void> {
  printStep('preflight', 'Checking required CLI tools and versions…');

  if (state.preflight_ok) {
    printSkip('Preflight already passed — skipping');
    return;
  }

  let allOk = true;
  const issues: string[] = [];

  // Node.js version
  const nodeVersion = process.version.replace('v', '');
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
  if (nodeMajor < 20) {
    issues.push(`Node.js >= 20 required (found ${process.version}). Install: https://nodejs.org/`);
    allOk = false;
  } else {
    printOk(`Node.js ${process.version}`);
  }

  // Check CLIs
  const cliChecks: Array<{
    cmd: string;
    name: string;
    authCheck?: string;
    authHint?: string;
    installHint: string;
  }> = [
    {
      cmd: 'neonctl',
      name: 'neonctl',
      authCheck: 'neonctl me --output json',
      authHint: 'neonctl auth',
      installHint: 'npm install -g neonctl',
    },
    {
      cmd: 'wrangler',
      name: 'Wrangler',
      authCheck: 'npx wrangler whoami',
      authHint: 'npx wrangler login',
      installHint: 'npm install -g wrangler  (or: cd worker && npm install)',
    },
    {
      cmd: 'flyctl',
      name: 'flyctl',
      authCheck: 'flyctl auth whoami',
      authHint: 'flyctl auth login',
      installHint: 'curl -L https://fly.io/install.sh | sh',
    },
  ];

  for (const check of cliChecks) {
    const isWrangler = check.cmd === 'wrangler';
    const installed = isWrangler
      ? commandExists('wrangler') || fs.existsSync(path.join(ROOT, 'worker', 'node_modules', '.bin', 'wrangler'))
      : commandExists(check.cmd);

    if (!installed) {
      issues.push(`${check.name} not found. Install: ${check.installHint}`);
      allOk = false;
      continue;
    }
    printOk(`${check.name} installed`);

    // Check auth
    if (check.authCheck) {
      const authResult = spawnSync('sh', ['-c', check.authCheck], {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env },
      });
      if (authResult.status !== 0) {
        issues.push(`${check.name} not authenticated. Run: ${check.authHint}`);
        allOk = false;
      } else {
        printOk(`${check.name} authenticated`);
      }
    }
  }

  if (!allOk) {
    print('\nFix the following issues before running setup:\n');
    for (const issue of issues) {
      printError(issue);
    }
    print('');
    rl.close();
    process.exit(1);
  }

  state.preflight_ok = true;
  saveState(state);
  printOk('All preflight checks passed');
}

// ---------------------------------------------------------------------------
// Phase B — Telegram app credentials
// ---------------------------------------------------------------------------

async function phaseB(state: SetupState): Promise<void> {
  printStep('telegram-creds', 'Collecting Telegram app credentials…');

  if (state.api_id && state.api_hash && state.phone_number) {
    printSkip('Telegram credentials already collected — skipping');
    return;
  }

  print('');
  print('  You need a Telegram app from https://my.telegram.org/apps');
  print('  Create an app (any name/platform) and copy the App api_id and api_hash.');
  print('');

  const apiIdStr = await ask('  API_ID (numeric): ');
  const apiId = parseInt(apiIdStr, 10);
  if (isNaN(apiId) || apiId <= 0) {
    throw new Error(`Invalid API_ID: "${apiIdStr}" — must be a positive integer`);
  }

  const apiHash = await ask('  API_HASH (hex string): ');
  if (!apiHash || !/^[0-9a-f]{32}$/i.test(apiHash)) {
    printWarn('API_HASH does not look like a 32-char hex string — proceeding anyway');
  }

  const phone = await ask('  Phone number (E.164 format, e.g. +4912345678): ');
  if (!phone.startsWith('+')) {
    throw new Error('Phone number must be in E.164 format starting with + (e.g. +4912345678)');
  }

  state.api_id = apiId;
  state.api_hash = apiHash;
  state.phone_number = phone;
  saveState(state);
  printOk('Telegram credentials saved to .setup-state.json');
}

// ---------------------------------------------------------------------------
// Phase C — Telegram auth (GramJS session)
// ---------------------------------------------------------------------------

async function phaseC(state: SetupState): Promise<void> {
  printStep('telegram-auth', 'Authenticating with Telegram (GramJS session)…');

  if (state.gramjs_session) {
    printSkip('GramJS session already exists — skipping (delete from state to re-auth)');
    return;
  }

  if (!state.api_id || !state.api_hash || !state.phone_number) {
    throw new Error('Phase B (telegram-creds) must be completed first');
  }

  print('');
  print('  Telegram will send a code to your phone/app. This must run from your home IP.');
  print('  Completing 2FA password prompt if prompted.');
  print('');

  // We run the existing gramjs/src/auth.ts with env vars injected,
  // capturing the output to extract the session string.
  // Since auth.ts is interactive, we use a wrapper approach: spawn it as a
  // child process with inherited stdio (interactive) and then read the session
  // from a temp file.

  const gramjsDir = path.join(ROOT, 'gramjs');

  // Install gramjs deps if needed
  if (!fs.existsSync(path.join(gramjsDir, 'node_modules'))) {
    print('  Installing gramjs dependencies…');
    run('npm install', { cwd: gramjsDir });
    printOk('gramjs dependencies installed');
  }

  // We run a slightly modified inline script that captures the session to a temp file
  const tmpSession = path.join(ROOT, '.setup-session.tmp');
  const inlineScript = `
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');
const fs = require('fs');

function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

async function main() {
  // JSON.stringify produces a safe JS literal — blocks template injection even
  // if a hypothetical api_hash or phone_number contained backticks or quotes.
  const apiId = ${JSON.stringify(state.api_id)};
  const apiHash = ${JSON.stringify(state.api_hash)};
  const phoneNumber = ${JSON.stringify(state.phone_number)};
  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, {
    floodSleepThreshold: 300,
    deviceModel: 'MacBook Pro',
    systemVersion: 'macOS 26.3',
    appVersion: '12.4.2',
    langCode: 'en',
  });

  await client.start({
    phoneNumber: async () => phoneNumber,
    password: async () => {
      const pw = await prompt('  2FA password (leave empty if none): ');
      return pw || '';
    },
    phoneCode: async () => prompt('  Verification code from Telegram: '),
    onError: (err) => { console.error('Auth error:', err.message); throw err; },
  });

  const sessionStr = client.session.save();
  fs.writeFileSync('${tmpSession}', sessionStr, { mode: 0o600 });
  try { fs.chmodSync('${tmpSession}', 0o600); } catch {}
  console.log('\\n  Authentication successful!');
  await client.disconnect();
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
`;

  const tmpScript = path.join(ROOT, '.setup-auth-helper.cjs');
  // 0o600 — this file and the session it writes contain api_hash and,
  // momentarily, the full Telegram session string.
  fs.writeFileSync(tmpScript, inlineScript, { mode: 0o600 });
  try { fs.chmodSync(tmpScript, 0o600); } catch { /* best effort */ }

  // Clean up any leftover session temp file
  if (fs.existsSync(tmpSession)) fs.unlinkSync(tmpSession);

  print('  Starting Telegram auth — follow the prompts below:');
  print('');

  // Spawn with inherited stdio so user can interact
  const result = spawnSync('node', [tmpScript], {
    cwd: gramjsDir,
    stdio: 'inherit',
    env: { ...process.env },
  });

  // Clean up temp script
  try { fs.unlinkSync(tmpScript); } catch {}

  if (result.status !== 0) {
    try { fs.unlinkSync(tmpSession); } catch {}
    throw new Error('Telegram authentication failed. Check credentials and try again.');
  }

  if (!fs.existsSync(tmpSession)) {
    throw new Error('Session file not created — auth may have failed silently');
  }

  const sessionStr = fs.readFileSync(tmpSession, 'utf8').trim();
  try { fs.unlinkSync(tmpSession); } catch {}

  if (!sessionStr) {
    throw new Error('Session string is empty — authentication did not complete');
  }

  state.gramjs_session = sessionStr;
  saveState(state);
  printOk('GramJS session saved to .setup-state.json [redacted]');
}

// ---------------------------------------------------------------------------
// Phase D — Neon project + schema
// ---------------------------------------------------------------------------

async function phaseD(state: SetupState): Promise<void> {
  printStep('neon', 'Setting up Neon PostgreSQL database…');

  // Sub-step 1: Create project
  if (!state.neon_project_id) {
    const projectName = sanitizeName(
      'Neon project name',
      await askWithDefault('  Neon project name', 'tg-reader'),
    );

    print('  Creating Neon project…');
    const createOutput = run(
      `neonctl projects create --name "${projectName}" --output json`
    );

    let projectData: { id: string; branch?: { id: string } };
    try {
      projectData = JSON.parse(createOutput);
    } catch {
      throw new Error(`Failed to parse neonctl output: ${createOutput}`);
    }

    state.neon_project_id = projectData.id;
    state.neon_branch_id = projectData.branch?.id;
    saveState(state);
    printOk(`Neon project created: ${projectData.id}`);
  } else {
    printSkip(`Neon project already exists: ${state.neon_project_id}`);
  }

  // Sub-step 2: Get connection string
  if (!state.database_url) {
    print('  Fetching connection string…');
    const connStr = run(
      `neonctl connection-string --project-id ${state.neon_project_id} --database-name neondb --role-name neondb_owner`
    );
    if (!connStr.startsWith('postgresql://') && !connStr.startsWith('postgres://')) {
      throw new Error(`Unexpected connection string format: ${connStr.substring(0, 40)}…`);
    }
    state.database_url = connStr;
    saveState(state);
    printOk('Connection string obtained [redacted]');
  } else {
    printSkip('Connection string already in state [redacted]');
  }

  // Sub-step 3: Apply schema
  if (!state.neon_schema_applied) {
    print('  Applying schema.sql via pg…');

    const { Client } = await import('pg');
    const client = new Client({ connectionString: state.database_url });
    await client.connect();

    const schemaSQL = fs.readFileSync(SCHEMA_FILE, 'utf8');
    try {
      await client.query(schemaSQL);
      printOk('Schema applied successfully');
    } catch (err) {
      await client.end();
      throw new Error(
        `Schema application failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    await client.end();

    state.neon_schema_applied = true;
    saveState(state);
  } else {
    printSkip('Schema already applied');
  }
}

// ---------------------------------------------------------------------------
// Phase E — Cloudflare Worker deploy
// ---------------------------------------------------------------------------

async function phaseE(state: SetupState): Promise<void> {
  printStep('worker', 'Deploying Cloudflare Worker…');

  const workerDir = path.join(ROOT, 'worker');

  // Sub-step 1: Choose worker name
  if (!state.worker_name) {
    const defaultName = `tg-reader-${randomSuffix()}`;
    const workerName = sanitizeName(
      'Worker name',
      await askWithDefault(
        '  Worker name (used as <name>.workers.dev subdomain)',
        defaultName,
      ),
    );
    state.worker_name = workerName;
    saveState(state);
  } else {
    printSkip(`Worker name already set: ${state.worker_name}`);
  }

  // Sub-step 2: Generate tokens
  if (!state.ingest_token) {
    state.ingest_token = crypto.randomBytes(32).toString('hex');
    saveState(state);
    printOk('INGEST_TOKEN generated [redacted]');
  } else {
    printSkip('INGEST_TOKEN already in state [redacted]');
  }

  if (!state.master_token) {
    state.master_token = crypto.randomBytes(32).toString('hex');
    saveState(state);
    printOk('MASTER_TOKEN generated [redacted]');
  } else {
    printSkip('MASTER_TOKEN already in state [redacted]');
  }

  // Sub-step 3: Update wrangler.toml
  const wranglerContent = fs.readFileSync(WRANGLER_TOML, 'utf8');
  const currentNameMatch = wranglerContent.match(/^name\s*=\s*"([^"]+)"/m);
  const currentName = currentNameMatch?.[1];

  if (currentName !== state.worker_name) {
    backupFile(WRANGLER_TOML);
    if (!currentName) {
      throw new Error('Could not find name = "..." line in worker/wrangler.toml');
    }
    replaceInFile(WRANGLER_TOML, `name = "${currentName}"`, `name = "${state.worker_name}"`);
    printOk(`wrangler.toml updated: name = "${state.worker_name}"`);
  } else {
    printSkip(`wrangler.toml already has name = "${state.worker_name}"`);
  }

  // Sub-step 4: Install worker deps
  if (!fs.existsSync(path.join(workerDir, 'node_modules'))) {
    print('  Installing worker dependencies…');
    run('npm install', { cwd: workerDir });
    printOk('Worker dependencies installed');
  }

  // Sub-step 5: Set secrets
  print('  Setting Cloudflare Worker secrets…');
  const secrets: Array<{ name: string; value: string }> = [
    { name: 'INGEST_TOKEN', value: state.ingest_token! },
    { name: 'MASTER_TOKEN', value: state.master_token! },
    { name: 'DATABASE_URL', value: state.database_url! },
  ];

  for (const secret of secrets) {
    print(`    Putting secret ${secret.name}…`);
    // Pipe secret via stdin rather than interpolating into a shell command —
    // avoids exposing the value via `ps`, shell history, or shell expansion
    // (DATABASE_URL from Neon could in theory contain `$`, backticks, etc.)
    const result = spawnSync(
      'npx',
      ['wrangler', 'secret', 'put', secret.name, '--name', state.worker_name!],
      { cwd: workerDir, input: secret.value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) {
      throw new Error(
        `wrangler secret put ${secret.name} failed (exit ${result.status}): ${result.stderr || result.stdout}`,
      );
    }
    printOk(`${secret.name} set`);
  }

  // Sub-step 6: Deploy worker
  if (!state.worker_deployed) {
    print('  Deploying worker (this may take ~30s)…');
    const deployOutput = run('npx wrangler deploy', { cwd: workerDir });

    // Extract worker URL from deploy output
    // wrangler prints something like: "Published tg-reader-xyz (1.23 sec)\nhttps://tg-reader-xyz.username.workers.dev"
    const urlMatch = deployOutput.match(/https:\/\/[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+\.workers\.dev/);
    if (!urlMatch) {
      // Try to construct from worker name
      printWarn('Could not auto-detect Worker URL from deploy output. Please enter it manually:');
      print(`    Deploy output: ${deployOutput.slice(-500)}`);
      const workerUrl = await ask('  Worker URL (e.g. https://tg-reader-abc123.your-sub.workers.dev): ');
      state.worker_url = workerUrl.replace(/\/$/, '');
    } else {
      state.worker_url = urlMatch[0];
    }

    state.worker_deployed = true;
    saveState(state);
    printOk(`Worker deployed: ${state.worker_url}`);
  } else {
    printSkip(`Worker already deployed: ${state.worker_url}`);
  }
}

// ---------------------------------------------------------------------------
// Phase F — Fly.io listener deploy
// ---------------------------------------------------------------------------

async function phaseF(state: SetupState): Promise<void> {
  printStep('fly', 'Deploying GramJS listener to Fly.io…');

  if (!state.worker_url) throw new Error('Phase E (worker) must be completed first');
  if (!state.gramjs_session) throw new Error('Phase C (telegram-auth) must be completed first');

  const gramjsDir = path.join(ROOT, 'gramjs');

  // Sub-step 1: Choose Fly app name + region
  if (!state.fly_app_name) {
    const defaultName = `tg-reader-listener-${randomSuffix()}`;
    const flyAppName = sanitizeName(
      'Fly app name',
      await askWithDefault(
        '  Fly app name',
        defaultName,
      ),
    );
    state.fly_app_name = flyAppName;
    saveState(state);
  } else {
    printSkip(`Fly app name already set: ${state.fly_app_name}`);
  }
  if (!state.fly_region) {
    const region = sanitizeName(
      'Fly region',
      await askWithDefault(
        '  Fly region (e.g. ams, iad, lhr, nrt — see https://fly.io/docs/reference/regions/)',
        'ams',
      ),
    );
    state.fly_region = region;
    saveState(state);
  } else {
    printSkip(`Fly region already set: ${state.fly_region}`);
  }

  // Sub-step 2: Update fly.toml
  const flyContent = fs.readFileSync(FLY_TOML, 'utf8');
  const currentAppMatch = flyContent.match(/^app\s*=\s*"([^"]+)"/m);
  const currentApp = currentAppMatch?.[1];

  if (currentApp !== state.fly_app_name) {
    backupFile(FLY_TOML);
    if (!currentApp) {
      throw new Error('Could not find app = "..." line in gramjs/fly.toml');
    }
    replaceInFile(FLY_TOML, `app = "${currentApp}"`, `app = "${state.fly_app_name}"`);
    printOk(`fly.toml updated: app = "${state.fly_app_name}"`);
  } else {
    printSkip(`fly.toml already has app = "${state.fly_app_name}"`);
  }

  // Also update primary_region if user picked a non-default.
  const flyContent2 = fs.readFileSync(FLY_TOML, 'utf8');
  const currentRegionMatch = flyContent2.match(/^primary_region\s*=\s*"([^"]+)"/m);
  const currentRegion = currentRegionMatch?.[1];
  if (state.fly_region && currentRegion && currentRegion !== state.fly_region) {
    replaceInFile(
      FLY_TOML,
      `primary_region = "${currentRegion}"`,
      `primary_region = "${state.fly_region}"`,
    );
    printOk(`fly.toml updated: primary_region = "${state.fly_region}"`);
  }

  // Sub-step 3: Create Fly app
  print('  Creating Fly app…');
  const appExists = run(`flyctl apps list --json`, { ignoreError: true });
  let exists = false;
  try {
    const apps: Array<{ Name: string }> = JSON.parse(appExists);
    exists = apps.some(a => a.Name === state.fly_app_name);
  } catch { /* ignore */ }

  if (!exists) {
    run(`flyctl apps create ${state.fly_app_name}`, { cwd: gramjsDir });
    printOk(`Fly app created: ${state.fly_app_name}`);
  } else {
    printSkip(`Fly app already exists: ${state.fly_app_name}`);
  }

  // Sub-step 4: Create volume
  if (!state.fly_volume_created) {
    print('  Creating Fly volume tg_state…');
    const volCheck = run(`flyctl volumes list --app ${state.fly_app_name} --json`, { ignoreError: true });
    let volExists = false;
    try {
      const vols: Array<{ Name: string }> = JSON.parse(volCheck);
      volExists = vols.some(v => v.Name === 'tg_state');
    } catch { /* ignore */ }

    if (!volExists) {
      run(
        `flyctl volumes create tg_state --size 1 --region ${state.fly_region} --yes --app ${state.fly_app_name}`,
        { cwd: gramjsDir }
      );
      printOk(`Volume tg_state created in ${state.fly_region} region`);
    } else {
      printSkip('Volume tg_state already exists');
    }

    state.fly_volume_created = true;
    saveState(state);
  } else {
    printSkip('Fly volume already created');
  }

  // Sub-step 5: Set Fly secrets
  if (!state.fly_secrets_set) {
    print('  Setting Fly secrets…');

    const flySecrets = [
      `GRAMJS_SESSION=${state.gramjs_session}`,
      `API_ID=${state.api_id}`,
      `API_HASH=${state.api_hash}`,
      `INGEST_TOKEN=${state.ingest_token}`,
      `WORKER_URL=${state.worker_url}`,
    ];

    // Use heredoc-style stdin to avoid shell escaping issues with the session string
    const secretsInput = flySecrets.join('\n');
    run(
      `flyctl secrets import --app ${state.fly_app_name}`,
      { cwd: gramjsDir, input: secretsInput }
    );

    state.fly_secrets_set = true;
    saveState(state);
    printOk('Fly secrets set [redacted]');
  } else {
    printSkip('Fly secrets already set');
  }

  // Sub-step 6: Deploy
  if (!state.fly_deployed) {
    print('  Deploying to Fly.io (this may take ~2 minutes)…');
    run(`flyctl deploy --app ${state.fly_app_name}`, { cwd: gramjsDir });
    state.fly_deployed = true;
    saveState(state);
    printOk(`Fly app deployed: ${state.fly_app_name}`);
  } else {
    printSkip(`Fly app already deployed: ${state.fly_app_name}`);
  }
}

// ---------------------------------------------------------------------------
// Phase G — MCP token + final output
// ---------------------------------------------------------------------------

async function phaseG(state: SetupState): Promise<void> {
  printStep('mcp', 'Minting MCP agent token and generating final config…');

  if (!state.worker_url) throw new Error('Phase E (worker) must be completed first');
  if (!state.master_token) throw new Error('MASTER_TOKEN not in state — Phase E incomplete');

  const workerUrl = state.worker_url;
  const masterToken = state.master_token;

  // Sub-step 1: Wait for listener to register
  if (state.fly_deployed && !state.my_user_id) {
    print('  Waiting 15s for the Fly listener to register itself…');
    await new Promise(resolve => setTimeout(resolve, 15_000));
  }

  // Sub-step 2: Get account/user ID from /stats
  if (!state.my_user_id) {
    print('  Fetching my_user_id from /stats…');
    const statsOutput = run(
      `curl -sf -H "X-Ingest-Token: ${masterToken}" "${workerUrl}/stats"`,
      { ignoreError: true }
    );

    let myUserId: string | undefined;
    try {
      const stats = JSON.parse(statsOutput);
      myUserId = stats.my_user_id ?? stats.account_id;
    } catch { /* ignore */ }

    if (!myUserId) {
      printWarn('Could not auto-detect my_user_id from /stats — using "primary"');
      myUserId = 'primary';
    }

    state.my_user_id = myUserId;
    saveState(state);
    printOk(`Account ID: ${myUserId}`);
  } else {
    printSkip(`Account ID already set: ${state.my_user_id}`);
  }

  // Sub-step 3: Create role via MCP endpoint
  const roleName = 'desktop-full';
  state.mcp_role_name = roleName;

  if (!state.mcp_agent_token) {
    print('  Creating MCP role and agent token…');

    // Create role via /mcp (MCP JSON-RPC)
    const createRolePayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_role',
        arguments: {
          name: roleName,
          read_mode: 'all',
          can_send: true,
          can_edit: false,
          can_delete: false,
          can_forward: false,
        },
      },
    });

    const roleOutput = run(
      `curl -sf -X POST \
        -H "Authorization: Bearer ${masterToken}" \
        -H "Content-Type: application/json" \
        -d '${createRolePayload.replace(/'/g, "'\\''")}'  \
        "${workerUrl}/mcp"`,
      { ignoreError: true }
    );

    // Parse role creation result (or proceed — role might already exist)
    let roleOk = false;
    try {
      const roleResult = JSON.parse(roleOutput);
      if (roleResult.result && !roleResult.error) roleOk = true;
    } catch { /* ignore */ }

    if (!roleOk) {
      printWarn(
        'Role creation returned unexpected response — it may already exist or /mcp differs. Proceeding.'
      );
    } else {
      printOk(`Role "${roleName}" created`);
    }

    // Create token
    const createTokenPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_token',
        arguments: {
          role: roleName,
          label: 'setup-auto',
        },
      },
    });

    const tokenOutput = run(
      `curl -sf -X POST \
        -H "Authorization: Bearer ${masterToken}" \
        -H "Content-Type: application/json" \
        -d '${createTokenPayload.replace(/'/g, "'\\''")}'  \
        "${workerUrl}/mcp"`,
      { ignoreError: true }
    );

    let agentToken: string | undefined;
    try {
      const tokenResult = JSON.parse(tokenOutput);
      // The MCP result is inside result.content[0].text as JSON
      const contentText = tokenResult?.result?.content?.[0]?.text;
      if (contentText) {
        const inner = JSON.parse(contentText);
        agentToken = inner.token ?? inner.raw_token;
      }
    } catch { /* ignore */ }

    if (!agentToken) {
      printWarn('Could not auto-extract agent token from MCP response.');
      printWarn('You can create one manually: use MASTER_TOKEN with the /mcp create_token tool.');
      printWarn(`Token output was: ${tokenOutput?.slice(0, 200)}`);
      agentToken = '(create-manually)';
    }

    state.mcp_agent_token = agentToken;
    saveState(state);
    printOk('MCP agent token created [redacted]');
  } else {
    printSkip('MCP agent token already in state [redacted]');
  }

  // Build MCP URL
  const accountId = state.my_user_id ?? 'primary';
  const mcpUrl = `${workerUrl}/mcp?account_id=${accountId}`;
  state.mcp_url = mcpUrl;
  saveState(state);

  // ---------------------------------------------------------------------------
  // Final summary
  // ---------------------------------------------------------------------------

  const divider = '─'.repeat(60);
  print('');
  print(`\x1b[32m${divider}\x1b[0m`);
  print('\x1b[32m  Setup complete!\x1b[0m');
  print(`\x1b[32m${divider}\x1b[0m`);
  print('');
  print('  Summary');
  print('  ───────');
  print(`  Worker URL:      ${workerUrl}`);
  print(`  Fly app:         ${state.fly_app_name ?? '(not deployed)'}`);
  print(`  Neon project ID: ${state.neon_project_id ?? '(not created)'}`);
  print(`  Account ID:      ${accountId}`);
  print('');
  print('  MCP Configuration');
  print('  ─────────────────');
  print(`  MCP URL (no token): ${mcpUrl}`);
  print('');
  print('  The full MCP URL with agent token is saved in .setup-state.json');
  print('  (field: mcp_agent_token). Keep this file private — it contains secrets.');
  print('');
  print('  Add to Claude Desktop (claude_desktop_config.json):');
  print('  ─────────────────────────────────────────────────');
  print('  {');
  print('    "mcpServers": {');
  print('      "tg-reader": {');
  print('        "url": "<mcp_url>",');
  print('        "headers": { "Authorization": "Bearer <mcp_agent_token>" }');
  print('      }');
  print('    }');
  print('  }');
  print('');
  print('  Or for Claude CLI:');
  print(`  claude mcp add --transport http --header "Authorization: Bearer <mcp_agent_token>" tg-reader ${mcpUrl}`);
  print('');
  print('  (Replace <mcp_agent_token> with the value from .setup-state.json)');
  print('');
  print('  Next steps');
  print('  ──────────');
  print('  • Check logs: flyctl logs -a ' + (state.fly_app_name ?? 'tg-reader-listener'));
  print('  • Run backfill after 24h: see docs/backfill.md');
  print('  • Dashboard: cd frontend && npm install && npm run build');
  print('');
  print('  # Optional — AI insights (out of scope for this setup):');
  print('  # wrangler secret put OPENAI_API_KEY   (cd worker first)');
  print('  # wrangler secret put ANTHROPIC_API_KEY');
  print('');
}

// ---------------------------------------------------------------------------
// Phase runner
// ---------------------------------------------------------------------------

const PHASES: Record<string, (state: SetupState) => Promise<void>> = {
  preflight: phaseA,
  'telegram-creds': phaseB,
  'telegram-auth': phaseC,
  neon: phaseD,
  worker: phaseE,
  fly: phaseF,
  mcp: phaseG,
};

const PHASE_ORDER = ['preflight', 'telegram-creds', 'telegram-auth', 'neon', 'worker', 'fly', 'mcp'];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const phaseFlag = args.indexOf('--phase');
  const singlePhase = phaseFlag >= 0 ? args[phaseFlag + 1] : null;

  print('');
  print('  \x1b[1mTG Reader — Interactive Setup\x1b[0m');
  print('  ─────────────────────────────');
  print('  State file: .setup-state.json');
  print('  Re-run at any time to resume from where you left off.');
  print('');

  const state = loadState();

  // Ensure .setup-state.json is gitignored
  const gitignorePath = path.join(ROOT, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    if (!gitignore.includes('.setup-state.json')) {
      fs.appendFileSync(gitignorePath, '\n.setup-state.json\n', 'utf8');
      printOk('Added .setup-state.json to .gitignore');
    }
  }

  if (singlePhase) {
    if (!PHASES[singlePhase]) {
      printError(`Unknown phase: "${singlePhase}". Available: ${PHASE_ORDER.join(', ')}`);
      rl.close();
      process.exit(1);
    }
    await PHASES[singlePhase](state);
  } else {
    for (const phase of PHASE_ORDER) {
      await PHASES[phase](state);
    }
  }

  rl.close();
}

main().catch(err => {
  printError(err instanceof Error ? err.message : String(err));
  rl.close();
  process.exit(1);
});
