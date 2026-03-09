import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import * as input from 'input';

async function main(): Promise<void> {
  const apiIdStr = process.env.API_ID;
  const apiHash = process.env.API_HASH;

  if (!apiIdStr) {
    throw new Error('Missing required environment variable: API_ID');
  }
  if (!apiHash) {
    throw new Error('Missing required environment variable: API_HASH');
  }

  const apiId = parseInt(apiIdStr, 10);
  if (isNaN(apiId)) {
    throw new Error(`API_ID must be a valid integer, got: ${apiIdStr}`);
  }

  const session = new StringSession('');

  const client = new TelegramClient(session, apiId, apiHash, {
    floodSleepThreshold: 300,
    deviceModel: 'MacBook Pro',
    systemVersion: 'macOS 26.3',
    appVersion: '12.4.2',
    langCode: 'en',
  });

  await client.start({
    phoneNumber: async () => input.text('Phone number (+countrycode): '),
    password: async () => input.text('2FA password (or leave empty): '),
    phoneCode: async () => input.text('Verification code: '),
    onError: (err: Error) => {
      console.error('Auth error:', err.message);
      throw err;
    },
  });

  console.log('\nAuthentication successful!');
  console.log('Session string (set as GRAMJS_SESSION Fly secret):');
  console.log(client.session.save());

  await client.disconnect();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
