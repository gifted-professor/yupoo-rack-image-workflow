#!/usr/bin/env node
/**
 * Auto-generate script - automatically skips already processed SKUs
 *
 * Usage:
 *   node scripts/auto-generate.mjs [--dry-run] [--force] [--sku SKU1,SKU2]
 *
 * Options:
 *   --dry-run    Show what would be processed without actually doing it
 *   --force      Force re-processing of already processed SKUs
 *   --sku        Only process specific SKUs (comma-separated)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { projectRoot, readJson, resolveProjectPath } from './workflow-lib.mjs';

function parseArgs(argv) {
  const args = { dryRun: false, force: false, skus: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--force') args.force = true;
    else if (value === '--sku') args.skus.push(...String(argv[++index]).split(',').filter(Boolean));
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function getProcessedSkus() {
  const itemsRoot = resolveProjectPath('work/items');
  const entries = await fs.readdir(itemsRoot, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name);
}

async function getCatalog() {
  const catalogPath = resolveProjectPath('config/sku-catalog.json');
  if (!(await exists(catalogPath))) {
    return { version: 1, items: [] };
  }
  return readJson('config/sku-catalog.json');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Get processed SKUs from work/items
  const processedSkus = await getProcessedSkus();
  console.log(`📦 已处理的 SKU: ${processedSkus.length} 个`);

  // Get catalog
  const catalog = await getCatalog();
  console.log(`📋 目录中的 SKU: ${catalog.items.length} 个`);

  // Filter new SKUs
  let newItems = catalog.items.filter(item => !processedSkus.includes(item.sku));

  // Filter by specific SKUs if provided
  if (args.skus.length > 0) {
    newItems = newItems.filter(item => args.skus.includes(item.sku));
  }

  // Filter by status
  if (!args.force) {
    newItems = newItems.filter(item => item.status !== 'completed');
  }

  console.log(`🆕 新增待处理: ${newItems.length} 个`);

  if (args.dryRun) {
    console.log('\n🔍 Dry-run 模式 - 以下 SKU 将被处理:');
    for (const item of newItems) {
      console.log(`  - ${item.sku} (${item.yupoo_url || '无 URL'})`);
    }
    return;
  }

  if (newItems.length === 0) {
    console.log('✅ 没有新商品需要处理');
    return;
  }

  // Process new items
  console.log('\n🚀 开始处理新商品...');

  for (const item of newItems) {
    console.log(`\n📦 处理 ${item.sku}...`);

    // Step 1: Ingest Yupoo album (if URL provided)
    if (item.yupoo_url) {
      console.log(`  📥 抓取 Yupoo 相册: ${item.yupoo_url}`);
      // TODO: Call ingest script
      // await execFileAsync(python, [workflow, 'run', '--album-url', item.yupoo_url, ...]);
    }

    // Step 2: Generate images
    console.log(`  🎨 生成图片...`);
    // TODO: Call generate script
    // await execFileAsync(node, ['scripts/generate-racks.mjs', '--batch', `config/${item.sku}.batch.json`]);

    // Step 3: Generate XHS cover
    console.log(`  🖼️ 生成四宫格...`);
    // TODO: Call XHS cover script

    // Update status
    item.status = 'completed';
    item.completed_at = new Date().toISOString().split('T')[0];
  }

  // Save updated catalog
  catalog.last_updated = new Date().toISOString().split('T')[0];
  await fs.writeFile(
    resolveProjectPath('config/sku-catalog.json'),
    JSON.stringify(catalog, null, 2) + '\n'
  );

  console.log('\n✅ 处理完成！');
}

main().catch(error => {
  console.error('❌ 错误:', error.message);
  process.exit(1);
});
