#!/usr/bin/env node
// Reuse the REAL Chrome profile (already logged into szwego) and sniff network
// while you manually create ONE product. Records to work/szwego-net.jsonl.
//
// Run (Chrome must be fully quit first): node scripts/szwego-net-sniff.mjs

import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const USER_DATA = process.env.CHROME_USER_DATA ||
  path.resolve(process.cwd(), 'work/.chrome-copy');
const NETLOG = path.resolve(process.cwd(), 'work/szwego-net.jsonl');
const START = process.env.SZWEGO_START_URL || 'https://www.szwego.com/';

async function main() {
  await fs.writeFile(NETLOG, '');

  const context = await chromium.launchPersistentContext(USER_DATA, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1366, height: 900 },
    args: ['--profile-directory=Default'],
  });
  const page = context.pages()[0] || (await context.newPage());

  const want = /szwego|qiniucdn|qiniu|myqcloud|cos\.|upload|commodity|album|api|create|save|putb64|mkblk/i;

  page.on('request', (req) => {
    const url = req.url();
    if (!want.test(url)) return;
    fs.appendFile(NETLOG, JSON.stringify({
      ts: new Date().toISOString(), type: 'request',
      method: req.method(), url,
      headers: req.headers(),
      postData: req.postData() ? req.postData().slice(0, 6000) : null,
    }) + '\n').catch(() => {});
  });
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!/commodity|album\/api|save|create|upload|qiniu|cos\.|putb64|mkblk|token\.jsp/i.test(url)) return;
    let body = null;
    try {
      const ct = resp.headers()['content-type'] || '';
      if (ct.includes('json') || ct.includes('text')) body = (await resp.text()).slice(0, 6000);
    } catch {}
    fs.appendFile(NETLOG, JSON.stringify({
      ts: new Date().toISOString(), type: 'response',
      status: resp.status(), url, body,
    }) + '\n').catch(() => {});
  });

  await page.goto(START, { waitUntil: 'domcontentloaded' });
  console.log('\n✅ 已用你的真实 Chrome profile 打开微购（登录态就在里面）。');
  console.log('请在里面手动创建【一个】商品：上传图、填标题/价格/分类/库存、保存/发布。');
  console.log('网络请求已录到 work/szwego-net.jsonl。');
  console.log('建好一个后回来告诉我，我分析并复刻给其余 41 个。\n');
}

main().catch(e => { console.error(e); process.exit(1); });
