// Saves a full SQL copy of the production database to backups/ (git-ignored).
// Usage: npm run backup
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'));
mkdirSync('backups', { recursive: true });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
const file = `backups/fin-${stamp}.sql`;

const result = spawnSync(`npx wrangler d1 export fin --remote --output ${file}`, { stdio: 'inherit', shell: true });
if (result.status !== 0) {
  console.error('Backup failed');
  process.exit(1);
}
console.log(`Saved ${file}`);
