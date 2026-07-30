#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

import { mergeCatalog } from './catalog-state.mjs';
import {
  dedupeFeishuRecords,
  feishuState,
  parseFeishuRows,
  planCatalogChanges,
} from './feishu-status.mjs';
import { projectRoot, resolveProjectPath, loadLocalEnv } from './workflow-lib.mjs';

const execFileAsync = promisify(execFile);
const BASE_TOKEN = () => process.env.FEISHU_BASE_TOKEN || 'PYtZbqyPyafc4sscwdjcQNLNnEh';
const TABLE_ID = () => process.env.FEISHU_TABLE_ID || 'tblUcslarq5iLEPB';

function parseArgs(argv) {
  const args = { dryRun: false, fixture: null, catalog: 'config/sku-catalog.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--fixture') args.fixture = argv[++index];
    else if (value === '--catalog') args.catalog = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function loadPayload(args) {
  if (args.fixture) return JSON.parse(await fs.readFile(resolveProjectPath(args.fixture), 'utf8'));
  const { stdout } = await execFileAsync('lark-cli', [
    'base', '+record-list',
    '--base-token', BASE_TOKEN(),
    '--table-id', TABLE_ID(),
    '--limit', '200',
    '--json',
  ], { cwd: projectRoot, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function writeAtomic(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await fs.rename(temporary, target);
}

async function main() {
  await loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const payload = await loadPayload(args);
  const parsed = parseFeishuRows(payload);
  const records = dedupeFeishuRecords(parsed);
  const catalogPath = resolveProjectPath(args.catalog);
  const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
  const changes = planCatalogChanges(catalog, records);
  const conflicts = records.filter(record => record.conflicts?.length);
  const report = {
    rows: parsed.length,
    unique_skus: records.length,
    duplicate_rows: parsed.length - records.length,
    conflicts,
    planned_changes: changes,
    dry_run: args.dryRun,
  };
  if (!args.dryRun) {
    const discovered = records.map(record => ({
      sku: record.sku,
      state: feishuState(record),
      sources: record.yupoo_url ? [{ url: record.yupoo_url }] : [],
      feishu: { record_ids: record.record_ids },
    }));
    await writeAtomic(catalogPath, mergeCatalog(catalog, discovered));
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(`错误: ${error.message}`);
  process.exit(1);
});
