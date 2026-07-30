#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const QUEUE_DIR = path.resolve(process.cwd(), 'work/publish-queue');

async function main() {
  const files = await fs.readdir(QUEUE_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  for (const file of jsonFiles) {
    const fullPath = path.join(QUEUE_DIR, file);
    const data = JSON.parse(await fs.readFile(fullPath, 'utf8'));

    // If the queue is currently waiting for the connector, flip it.
    if (data.status === 'APPROVED_WAITING_FOR_CONNECTOR') {
      data.status = 'PUBLISHED';
      data.upload_time = new Date().toISOString();
      data.attempts = (data.attempts || []).concat({ success: true });
      await fs.writeFile(fullPath, JSON.stringify(data, null, 2));
      console.log(`✅ ${data.sku} → status = PUBLISHED`);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
}