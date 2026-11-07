#!/usr/bin/env node
/**
 * Fills the deployment placeholders from the environment, for Cloudflare
 * Workers Builds.
 *
 * This fork is public and the project's convention (PROJECT_PLAN §21–§22) is
 * that real Cloudflare ids never enter the repository. They live in the
 * **Build variables** of each Workers Builds project instead; this script runs
 * before `wrangler deploy` and edits the working copy only — nothing is
 * committed, and a fresh clone still carries placeholders.
 *
 * Required (set once per Workers Builds project):
 *   PVUV_ACCOUNT_ID
 *   PVUV_D1_ID
 *   PVUV_KV_BLOCKLIST_ID
 *   PVUV_KV_SITE_CONFIG_ID
 *   PVUV_ADMIN_EMAILS          comma-separated allowlist
 *   PVUV_ZONE                  the DNS zone, e.g. example.com
 *   PVUV_GITHUB_CLIENT_ID
 *
 * Optional (override the hosts derived from PVUV_ZONE):
 *   PVUV_CONSOLE_HOST          default analytics.<PVUV_ZONE>
 *   PVUV_INGEST_HOST           default in.<PVUV_ZONE>
 *   PVUV_API_HOST              default api.<PVUV_ZONE>
 *   PVUV_GOOGLE_CLIENT_ID      when Google login is used instead of GitHub
 *
 * Usage:  npm run ci:prepare
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKERS = ['ingest', 'consumer', 'api', 'console', 'cron', 'proxy'];
const FILES = [
  'wrangler.toml',
  ...WORKERS.map((w) => `workers/${w}/wrangler.toml`),
];

const zone = process.env.PVUV_ZONE;
const host = (name, override) => override || (zone ? `${name}.${zone}` : undefined);

const replacements = [
  ['PLACEHOLDER_ACCOUNT_ID', process.env.PVUV_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID],
  ['PLACEHOLDER_D1_DATABASE_ID', process.env.PVUV_D1_ID],
  ['PLACEHOLDER_KV_BLOCKLIST_ID', process.env.PVUV_KV_BLOCKLIST_ID],
  ['PLACEHOLDER_KV_SITE_CONFIG_ID', process.env.PVUV_KV_SITE_CONFIG_ID],
  // Hostnames follow the same defaults as scripts/setup.mjs: the console on
  // analytics.<zone>, ingest on in.<zone>, the API on api.<zone>. Each can be
  // overridden, because a deployer's DNS is their own.
  ['PLACEHOLDER_CONSOLE_HOST', host('analytics', process.env.PVUV_CONSOLE_HOST)],
  ['PLACEHOLDER_INGEST_HOST', host('in', process.env.PVUV_INGEST_HOST)],
  ['PLACEHOLDER_API_HOST', host('api', process.env.PVUV_API_HOST)],
  ['ADMIN_EMAILS = "you@example.com"', process.env.PVUV_ADMIN_EMAILS
    ? `ADMIN_EMAILS = "${process.env.PVUV_ADMIN_EMAILS}"`
    : undefined],
  ['GITHUB_CLIENT_ID = ""', process.env.PVUV_GITHUB_CLIENT_ID
    ? `GITHUB_CLIENT_ID = "${process.env.PVUV_GITHUB_CLIENT_ID}"`
    : undefined],
].filter(([, value]) => value);

// Every Worker in this repo shares the same config files, so each build must
// receive the full set: a partially filled tree would fail the placeholder
// check below on a file this Worker is not even deploying.
const missing = [
  'PVUV_ACCOUNT_ID',
  'PVUV_D1_ID',
  'PVUV_KV_BLOCKLIST_ID',
  'PVUV_KV_SITE_CONFIG_ID',
  'PVUV_ADMIN_EMAILS',
  'PVUV_ZONE',
  'PVUV_GITHUB_CLIENT_ID',
].filter((name) => !process.env[name] && !(name === 'PVUV_ACCOUNT_ID' && process.env.CLOUDFLARE_ACCOUNT_ID));

if (missing.length) {
  console.error(
    `ci-prepare: missing build variable(s): ${missing.join(', ')}\n` +
      'Set them under the Workers Builds project settings (Settings → Build → Variables).'
  );
  process.exit(1);
}


let changed = 0;
for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // optional configs (proxy) may be absent
  }
  const before = text;
  for (const [from, to] of replacements) text = text.split(from).join(to);
  if (text !== before) {
    writeFileSync(file, text);
    changed++;
  }
}

// A typo in a variable name must fail the build, not deploy a worker with a
// binding to the string "PLACEHOLDER_…". `you@example.com` is only a warning:
// every Worker shares these config files, and only the console build is given
// PVUV_ADMIN_EMAILS — the other four would otherwise fail on a file they are
// not deploying.
const unfilled = FILES.filter((rel) => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8').includes('PLACEHOLDER_');
  } catch {
    return false;
  }
});

if (unfilled.length) {
  console.error(
    `ci-prepare: placeholders remain in ${unfilled.join(', ')} — set the matching build variable(s) on this Worker.`
  );
  process.exit(1);
}

try {
  if (
    readFileSync(path.join(ROOT, 'workers/console/wrangler.toml'), 'utf8')
      .includes('you@example.com')
  ) {
    console.warn(
      'ci-prepare: ADMIN_EMAILS is still the placeholder — set PVUV_ADMIN_EMAILS on the console build.'
    );
  }
} catch {
  /* console config absent */
}

console.log(`ci-prepare: ${changed} config file(s) filled from build variables`);
