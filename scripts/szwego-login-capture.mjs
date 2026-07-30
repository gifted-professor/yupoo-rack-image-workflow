#!/usr/bin/env node
// Capture szwego login session (cookies + localStorage) with a persistent
// browser profile, auto-detecting login — no stdin needed.
//
// Run: node scripts/szwego-login-capture.mjs
//
// Behavior:
//   - Opens a visible Chromium with a persistent profile (work/.szwego-profile),
//     so your login survives across runs.
//   - Navigates to szwego home. You log in manually.
//   - Polls every 2s for a logged-in signal (auth-like cookie / token-like
//     localStorage key / URL moving to a user area). Once detected, waits 3s
//     for the SPA to settle, dumps work/szwego-session.json, and exits.
//   - Hard timeout 6 min; dumps whatever we have at timeout.

import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve(process.cwd(), 'work/szwego-session.json');
const PROFILE = path.resolve(process.cwd(), 'work/.szwego-profile');
const START_URL = process.env.SZWEGO_START_URL || 'https://www.szwego.com/';
const TIMEOUT_MS = Number(process.env.SZWEGO_TIMEOUT_MS || 6 * 60 * 1000);
const POLL_MS = 2000;

// Strict auth signals — exclude analytics/tracking cookies that cause false positives.
const AUTH_COOKIE = /(^|_)(token|access_?token|auth_?token|sessionid|session_?id|sid|stoken|ticket|jwt|sign_?token|csrf_?token|user_?token|account_?token)(_|$)|bearer/i;
const AUTH_LS_KEY = /token|stoken|ticket|jwt|sessionid|access_?token|auth_?token|account_?id|user_?id|openid/i;
const LOGIN_URL = /login|signin|passport|pc_login/i;
const JUNK_COOKIE = /sensor|sajssdk|aegis|sensorsdata|_cross_|clear_dict|latest_clear/i;

function looksLoggedIn({ cookies, ls, url }) {
  const realCookies = cookies.filter(c => !JUNK_COOKIE.test(c.name));
  if (realCookies.some(c => AUTH_COOKIE.test(c.name))) return true;
  if (Object.keys(ls).some(k => AUTH_LS_KEY.test(k) && ls[k])) return true;
  // URL has clearly moved OFF the login page AND there are several real cookies
  if (!LOGIN_URL.test(url) && realCookies.length >= 2) return true;
  return false;
}

async function snapshot(context, page) {
  const cookies = await context.cookies();
  const localStorage = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      out[k] = window.localStorage.getItem(k);
    }
    return out;
  });
  const sessionStorage = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i);
      out[k] = window.sessionStorage.getItem(k);
    }
    return out;
  });
  return {
    captured_at: new Date().toISOString(),
    final_url: page.url(),
    title: await page.title(),
    cookies,
    localStorage,
    sessionStorage,
  };
}

async function main() {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' });

  console.log('浏览器已打开微购首页。请在窗口里登录。脚本会自动检测登录态。');

  const start = Date.now();
  let logged = false;
  while (Date.now() - start < TIMEOUT_MS) {
    await page.waitForTimeout(POLL_MS);
    let snap;
    try {
      snap = await snapshot(context, page);
    } catch {
      continue;
    }
    if (looksLoggedIn(snap)) {
      logged = true;
      console.log('检测到登录态，等 SPA 稳定 3s 后落盘…');
      await page.waitForTimeout(3000);
      const final = await snapshot(context, page);
      await fs.writeFile(OUT, JSON.stringify(final, null, 2));
      console.log(`✅ 已捕获 → ${OUT}`);
      console.log(`   URL: ${final.final_url}`);
      console.log(`   cookies: ${final.cookies.length} 条 -> ${final.cookies.map(c => c.name).join(', ')}`);
      console.log(`   localStorage keys: ${Object.keys(final.localStorage).join(', ') || '(none)'}`);
      break;
    }
  }

  if (!logged) {
    const final = await snapshot(context, page);
    await fs.writeFile(OUT, JSON.stringify(final, null, 2));
    console.log(`⏱ 超时未确认登录态，已落盘当前快照 → ${OUT}`);
    console.log(`   cookies: ${final.cookies.length} 条 -> ${final.cookies.map(c => c.name).join(', ')}`);
  }

  await context.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
