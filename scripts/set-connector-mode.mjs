#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

const MODE_FILE = path.resolve(process.cwd(), 'work', 'mode.json');
const DEFAULT_MODE = { connector_status: 'dry_run_only' };

async function ensureModeFile() {
  try {
    await fs.access(MODE_FILE);
  } catch {
    await fs.writeFile(MODE_FILE, JSON.stringify(DEFAULT_MODE, null, 2));
  }
}

async function readMode() {
  await ensureModeFile();
  const data = await fs.readFile(MODE_FILE, 'utf8');
  return JSON.parse(data);
}

async function writeMode(modeObj) {
  await fs.writeFile(MODE_FILE, JSON.stringify(modeObj, null, 2));
}

const args = process.argv.slice(2);
if (args.length === 0) {
  // No args: print current mode
  const mode = await readMode();
  console.log(`Current connector status: ${mode.connector_status}`);
  process.exit(0);
}

const cmd = args[0].toLowerCase();
let newMode;
if (cmd === 'live' || cmd === 'active') {
  newMode = { connector_status: 'active' };
} else if (cmd === 'dry' || cmd === 'dry_run' || cmd === 'dry_run_only') {
  newMode = { connector_status: 'dry_run_only' };
} else {
  console.error('Usage: node set-connector-mode.mjs [live|active|dry|dry_run|dry_run_only]');
  console.error('If no argument provided, prints current mode.');
  process.exit(1);
}

await writeMode(newMode);
console.log(`Connector status set to: ${newMode.connector_status}`);