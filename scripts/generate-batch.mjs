#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

async function main() {
  const queueDir = path.resolve(process.cwd(), 'work/publish-queue');
  const files = await fs.readdir(queueDir);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const items = [];
  for (const file of jsonFiles) {
    const fullPath = path.join(queueDir, file);
    const content = await fs.readFile(fullPath, 'utf8');
    const obj = JSON.parse(content);
    // Expect fields: sku, publish_package, review
    items.push({
      sku: obj.sku,
      package: path.relative(process.cwd(), path.join('work/items', obj.sku, 'publish-package.json')),
      review: path.relative(process.cwd(), path.join('work/items', obj.sku, 'approved-review.json')),
    });
  }

  const batch = {
    target: 'szwego',
    items: items,
  };

  const outPath = path.resolve(process.cwd(), 'work/batch-szwego-live.json');
  await fs.writeFile(outPath, JSON.stringify(batch, null, 2));
  console.log(`Generated batch file at ${outPath} with ${items.length} items`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});