'use strict';

const express = require('express');
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Resend } = require('resend');
const Stripe = require('stripe');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');

// ======================================================
//  定数
// ======================================================
const MS_PER_DAY = 86_400_000;
const RATE_WINDOW_MS = 15 * 60 * 1000;  // 15分
const RATE_MAX_RESERVE = 10;             // 予約API上限
const RATE_MAX_LOGIN = 5;                // ログイン試行上限
const RATE_CLEANUP_MS = 5 * 60 * 1000;  // クリーンアップ間隔
const MAX_RATE_ENTRIES = 10_000;         // メモリリーク防止
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 管理セッション有効期限（12時間）
const AUDIT_LOG_MAX_BYTES = 5 * 1024 * 1024; // 監査ログ1ファイル上限(5MB)
const AUDIT_LOG_KEEP_FILES = 5; // 保持世代数
const FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 免許証アップロード上限 10MB
const ALLOWED_FILE_TYPES = /jpeg|jpg|png|webp|heic|pdf/i;

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'onboarding@resend.dev';
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH || '';
const ADMIN_COOKIE_NAME = 'admin_session';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;
const KEY_BOX_CODE   = process.env.KEY_BOX_CODE   || '（管理者にお問い合わせください）';
const INSURANCE_TEL  = process.env.INSURANCE_TEL  || '（管理者にお問い合わせください）';
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || '';
const DEPOSIT_CAP    = Number(process.env.DEPOSIT_CAP) || 30000; // 保証金の請求上限（円）

// メール共通ブロック（定数はモジュールトップで確定）
const EMAIL_EMERGENCY_CONTACTS = `【緊急連絡先】
・担当（鈴木）     : 080-8520-6929（9〜18時）
・保険ロードサービス: ${INSURANCE_TEL}
・JAF           : #8139（24時間）`;
const EMAIL_COMPANY_FOOTER = `88CAMPCAR / 株式会社88PERCENT
担当：鈴木 / 080-8520-6929
${BASE_URL}`;
const EMAIL_HR = '━━━━━━━━━━━━━━━━━━━━';
const EMAIL_LOCATION = `【貸出・返却場所】
〒905-0009 沖縄県名護市宇茂佐の森2丁目1-9
名護バスターミナルから約550m（徒歩約7分）。
タクシーなら初乗り料金（ワンメーター）の距離です。
貸出・返却はいずれも同じ場所です。`;
const EMAIL_OVERDUE_POLICY = `【返却時間の超過について】
ご返却が契約日時を過ぎた場合、超過1日ごとに通常日額（¥26,000／日）を追加で申し受けます。
やむを得ず遅れる場合は、必ず事前に担当（鈴木 / 080-8520-6929）までご連絡ください。`;

/** Date → YYYY-MM-DD（ローカル時刻） */
function jstDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** 現在のJST日付（YYYY-MM-DD） */
function todayJST() {
  return jstDateStr(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' })));
}

/** キーボックス暗証番号の開示日（出発前日 = start の1日前）を YYYY-MM-DD で返す */
function keyBoxRevealDate(startStr) {
  const d = new Date(startStr + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return jstDateStr(d);
}

/** Checkout セッションから Stripe の顧客ID・支払い方法IDを取得（保証金の事後請求用） */
async function getStripePaymentRefs(session) {
  const customerId = typeof session.customer === 'string'
    ? session.customer
    : (session.customer && session.customer.id) || null;
  const piRef = session.payment_intent;
  const piId = typeof piRef === 'string' ? piRef : (piRef && piRef.id) || null;
  let paymentMethodId = null;
  if (stripe && piId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(piId);
      paymentMethodId = typeof pi.payment_method === 'string'
        ? pi.payment_method
        : (pi.payment_method && pi.payment_method.id) || null;
    } catch (e) { console.error('[STRIPE] 支払い方法の取得に失敗:', e.message); }
  }
  return { customerId, paymentMethodId };
}

if (!ADMIN_PASS_HASH) {
  console.error('⛔ ADMIN_PASS_HASH が未設定です。ハッシュ必須モードのためサーバーを起動できません。');
  process.exit(1);
}

// ======================================================
//  Express アプリ初期化
// ======================================================
const app = express();

// --- ローカル開発時のCORS許可（Safariのlocalhost解決差異対策）---
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

// --- Helmet（セキュリティヘッダー一括設定）---
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://js.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://api.stripe.com", "https://js.stripe.com", "https://m.stripe.network", "https://q.stripe.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false  // Leaflet tiles 用
}));

// --- 圧縮 ---
app.use(compression());

// --- Stripe Webhook（raw body が必要なため JSON パーサーより前に登録）---
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!webhookSecret || !stripe) return res.status(503).send('Webhook 未設定');

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[WEBHOOK] 署名検証失敗:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return res.json({ received: true });

    const reservationId = session.metadata?.reservationId;
    if (!reservationId) return res.json({ received: true });

    try {
      const list = await readReservations();
      const idx = list.findIndex(r => r.id === reservationId);
      if (idx !== -1 && list[idx].status === 'pending_payment') {
        list[idx].status = 'pending';
        list[idx].stripeSessionId = session.id;
        list[idx].stripePaymentIntentId = session.payment_intent || null;
        const _refs = await getStripePaymentRefs(session);
        list[idx].stripeCustomerId = _refs.customerId;
        list[idx].stripePaymentMethodId = _refs.paymentMethodId;
        const _wp = determinePlan(list[idx].start, list[idx].end);
        list[idx].paidAmount = _wp.pricePerDay * _wp.nights;
        list[idx].viewToken = list[idx].viewToken || crypto.randomBytes(24).toString('hex');
        list[idx].updatedAt = new Date().toISOString();
        await writeReservations(list);
        Promise.allSettled([
          sendReservationEmail(list[idx]),
          sendReservationAutoReply(list[idx])
        ]).catch(err => console.error('[MAIL] err:', err.message));
        console.log(`[WEBHOOK] 予約確定: ${reservationId}`);
      }
    } catch (err) {
      console.error('[WEBHOOK] 予約確定エラー:', err.message);
    }
  }

  res.json({ received: true });
});

// --- JSON パーサー ---
app.use(express.json({ limit: '1mb' }));

// ======================================================
//  レート制限
// ======================================================
const rateLimitMap = new Map();
const adminSessionMap = new Map();

/**
 * IPベースのレート制限ミドルウェアを生成
 * @param {number} windowMs - ウィンドウ（ミリ秒）
 * @param {number} maxReqs - 最大リクエスト数
 * @returns {Function} Express ミドルウェア
 */
function rateLimit(windowMs, maxReqs) {
  return (req, res, next) => {
    if (rateLimitMap.size > MAX_RATE_ENTRIES) rateLimitMap.clear();
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const record = rateLimitMap.get(key) || { count: 0, start: now };
    if (now - record.start > windowMs) {
      record.count = 1;
      record.start = now;
    } else {
      record.count++;
    }
    rateLimitMap.set(key, record);
    if (record.count > maxReqs) {
      return res.status(429).json({ error: 'リクエスト回数が上限を超えました。しばらくお待ちください。' });
    }
    next();
  };
}

// 古いエントリを定期的にクリーンアップ
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, rec] of rateLimitMap) {
    if (now - rec.start > RATE_CLEANUP_MS * 2) rateLimitMap.delete(key);
  }
  for (const [token, session] of adminSessionMap) {
    if (session.expiresAt <= now) adminSessionMap.delete(token);
  }
}, RATE_CLEANUP_MS);
cleanupTimer.unref();

// pending_payment を1時間後に自動削除（1時間ごとに実行）
const reservationCleanupTimer = setInterval(async () => {
  try {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const list = await readReservations();
    const expired = list.filter(r =>
      r.status === 'pending_payment' && new Date(r.createdAt).getTime() < oneHourAgo
    );
    if (expired.length === 0) return;
    const remaining = list.filter(r =>
      !(r.status === 'pending_payment' && new Date(r.createdAt).getTime() < oneHourAgo)
    );
    await writeReservations(remaining);
    console.log(`[CLEANUP] pending_payment ${expired.length}件を自動削除しました`);
  } catch (err) {
    console.error('[CLEANUP] 自動削除エラー:', err.message);
  }
}, 60 * 60 * 1000);
reservationCleanupTimer.unref();

// 毎日 8:00 JST に当日チェックイン・アウト通知を送信（1時間ごとにチェック）
let lastDailyNotificationDate = '';
const dailyNotificationTimer = setInterval(async () => {
  const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  if (nowJST.getHours() !== 8) return;
  const ds = jstDateStr(nowJST);
  if (lastDailyNotificationDate === ds) return;
  lastDailyNotificationDate = ds;
  await sendDailyCheckinNotification(ds);
}, 60 * 60 * 1000);
dailyNotificationTimer.unref();

// 出発24時間前リマインダー：1時間ごとにチェック
const departureReminderTimer = setInterval(maybeSendDepartureReminders, 60 * 60 * 1000);
departureReminderTimer.unref();

// 返却日リマインダー：1時間ごとにチェック（9時JST送信）
maybeSendReturnReminders();
const returnReminderTimer = setInterval(maybeSendReturnReminders, 60 * 60 * 1000);
returnReminderTimer.unref();

// バックアップ：24時間ごと（初回はサーバー起動完了後に実行）
const backupTimer = setInterval(backupReservations, 24 * 60 * 60 * 1000);
backupTimer.unref();

// Renderスリープ対策：14分ごとに自己ping
if (KEEP_ALIVE_URL) {
  const kaTimer = setInterval(async () => {
    try { await fetch(`${KEEP_ALIVE_URL}/x1/ping`, { signal: AbortSignal.timeout(5000) }); }
    catch {}
  }, 14 * 60 * 1000);
  kaTimer.unref();
  console.log(`[KEEP-ALIVE] 有効 — 14分ごとに自己ping: ${KEEP_ALIVE_URL}`);
}

// ======================================================
//  ユーティリティ
// ======================================================

/**
 * XSS防止のため文字列をサニタイズ
 * @param {*} str - 入力値
 * @returns {string} サニタイズ済み文字列
 */
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'&]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;'
  })[c]).trim().slice(0, 500);
}

/**
 * 暗号学的に安全なIDを生成
 * @returns {string} 一意のID
 */
function generateId() {
  return crypto.randomUUID();
}

/**
 * タイミング安全な文字列比較
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 電話番号の形式を検証
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhone(phone) {
  return /^[\d\-+() ]{8,20}$/.test(phone);
}

/**
 * Cookieヘッダをパース
 * @param {string} cookieHeader
 * @returns {Record<string,string>}
 */
function parseCookies(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return {};
  return cookieHeader.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(val);
    return acc;
  }, {});
}

/**
 * ADMIN_PASS_HASH (scrypt) の検証
 * フォーマット: scrypt$N$r$p$saltHex$hashHex
 * @param {string} inputPassword
 * @param {string} stored
 * @returns {boolean}
 */
function verifyScryptHash(inputPassword, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const hash = parts[5];
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !hash) return false;
  try {
    const derived = crypto.scryptSync(inputPassword, Buffer.from(salt, 'hex'), Buffer.from(hash, 'hex').length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024
    }).toString('hex');
    return safeCompare(derived, hash);
  } catch {
    return false;
  }
}

/**
 * 管理パスワード検証（ハッシュ優先・平文は互換）
 * @param {string} inputPassword
 * @returns {boolean}
 */
function verifyAdminPassword(inputPassword) {
  if (typeof inputPassword !== 'string' || !inputPassword) return false;
  return verifyScryptHash(inputPassword, ADMIN_PASS_HASH);
}

/**
 * 管理セッションを新規作成
 * @returns {{sessionToken: string, csrfToken: string, expiresAt: number}}
 */
function createAdminSession() {
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  adminSessionMap.set(sessionToken, { csrfToken, expiresAt });
  return { sessionToken, csrfToken, expiresAt };
}

/**
 * 管理セッションを取得（期限切れは破棄）
 * @param {string} sessionToken
 * @returns {{csrfToken: string, expiresAt: number} | null}
 */
function getAdminSession(sessionToken) {
  const s = adminSessionMap.get(sessionToken);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    adminSessionMap.delete(sessionToken);
    return null;
  }
  return s;
}

// ======================================================
//  メール設定
// ======================================================
let resend = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log('[MAIL] Resend 初期化完了 — メール通知有効');
} else {
  console.log('[MAIL] RESEND_API_KEY 未設定 — メール通知は無効（予約は保存されます）');
}

// ======================================================
//  ビジネスロジック
// ======================================================

/**
 * 宿泊日数からプランと日額を判定
 * @param {string} start - YYYY-MM-DD
 * @param {string} end - YYYY-MM-DD
 * @returns {{ name: string, pricePerDay: number, nights: number }}
 */
const STRIPE_PRICE_IDS = {
  short:  process.env.STRIPE_PRICE_SHORT  || 'price_1TJqs78bpHlYoUmIXg5t02SS',
  medium: process.env.STRIPE_PRICE_MEDIUM || 'price_1TKetV8bpHlYoUmIWFTIcrDB',
  weekly: process.env.STRIPE_PRICE_WEEKLY || 'price_1TKeuV8bpHlYoUmIBf4Zv9Mo',
};

function determinePlan(start, end) {
  const nights = Math.round((new Date(end) - new Date(start)) / MS_PER_DAY);
  if (nights >= 7) return { name: 'Weekly Plan', planKey: 'weekly', pricePerDay: 19000, nights };
  if (nights >= 4) return { name: 'Medium Plan', planKey: 'medium', pricePerDay: 22000, nights };
  return { name: 'Short Stay', planKey: 'short', pricePerDay: 26000, nights };
}

/**
 * メールに埋め込むURLを決定
 * BASE_URL が localhost / 127.0.0.1 の場合は同一Wi-Fi端末から到達できる LAN IP URL を優先
 * @returns {string}
 */
function getMailBaseUrl() {
  let parsed;
  try {
    parsed = new URL(BASE_URL);
  } catch {
    return 'http://localhost:3000';
  }

  const host = (parsed.hostname || '').toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1') {
    return BASE_URL.replace(/\/+$/, '');
  }

  const lanIp = getLanIpv4List()[0];
  if (!lanIp) return BASE_URL.replace(/\/+$/, '');
  const portPart = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${lanIp}${portPart}`;
}

/**
 * 予約通知メール送信（管理者宛て）
 * @param {Object} entry - 予約データ
 */
async function sendReservationEmail(entry) {
  if (!resend) return;
  const plan = determinePlan(entry.start, entry.end);
  const total = plan.pricePerDay * plan.nights;
  const mailBaseUrl = getMailBaseUrl();
  const html = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;border:2px solid #111;border-radius:8px;overflow:hidden;">
      <div style="background:#111;color:#fff;padding:20px 24px;">
        <h1 style="margin:0;font-size:20px;letter-spacing:.05em;">🚐 88CAMPCAR — 新規予約</h1>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#888;width:100px;">予約ID</td><td style="padding:8px 0;font-weight:700;">${entry.id}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">お名前</td><td style="padding:8px 0;font-weight:700;">${entry.name}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">メール</td><td style="padding:8px 0;"><a href="mailto:${entry.email}">${entry.email}</a></td></tr>
          <tr><td style="padding:8px 0;color:#888;">電話番号</td><td style="padding:8px 0;"><a href="tel:${entry.phone}">${entry.phone}</a></td></tr>
          <tr style="border-top:1px solid #eee;"><td style="padding:12px 0 8px;color:#888;">プラン</td><td style="padding:12px 0 8px;font-weight:700;color:#f97316;">${plan.name}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">期間</td><td style="padding:8px 0;font-weight:700;">${entry.start} → ${entry.end}（${plan.nights}泊）</td></tr>
          <tr><td style="padding:8px 0;color:#888;">料金</td><td style="padding:8px 0;font-weight:700;font-size:18px;">¥${total.toLocaleString()}<span style="font-size:12px;color:#888;"> (¥${plan.pricePerDay.toLocaleString()}/日)</span></td></tr>
          <tr><td style="padding:8px 0;color:#888;">車両</td><td style="padding:8px 0;">${entry.vehicle}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">免許証</td><td style="padding:8px 0;">${entry.licenseFront ? '表面 ✓' : '—'} / ${entry.licenseBack ? '裏面 ✓' : '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">受付日時</td><td style="padding:8px 0;">${new Date(entry.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td></tr>
        </table>
        <div style="margin-top:20px;text-align:center;">
          <a href="${mailBaseUrl}/admin.html" style="display:inline-block;background:#111;color:#fff;padding:12px 28px;text-decoration:none;font-size:13px;font-weight:700;border-radius:6px;letter-spacing:.05em;">管理画面を開く →</a>
        </div>
      </div>
      <div style="background:#f8f8f8;padding:12px 24px;text-align:center;font-size:11px;color:#aaa;">
        88CAMPCAR Reservation System
      </div>
    </div>
  `;

  try {
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: `【新規予約】${entry.name}様 ${entry.start}〜${entry.end}（${plan.name}）`,
      html
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] 予約通知メール送信完了 → ${ADMIN_EMAIL}`);
  } catch (err) {
    console.error('[MAIL] メール送信エラー:', err.message);
  }
}

/**
 * 予約確認メール送信（お客様宛て）
 * @param {Object} entry - 予約データ
 */
async function sendReservationAutoReply(entry) {
  if (!resend) return;
  const plan = determinePlan(entry.start, entry.end);
  const total = plan.pricePerDay * plan.nights;
  const text = `${entry.name}様

このたびは 88CAMPCAR へご予約いただきありがとうございます。
以下の内容でご予約が確定しました。

━━━━━━━━━━━━━━━━━━━━
予約ID : ${entry.id}
期間   : ${entry.start} 〜 ${entry.end}（${plan.nights}泊）
プラン : ${plan.name}
料金   : ¥${total.toLocaleString()}（決済済み）
車両   : ${entry.vehicle}
━━━━━━━━━━━━━━━━━━━━

【ご準備いただくもの】
・運転免許証（ご出発時にご提示ください）

${EMAIL_LOCATION}

【ご出発の手順】
1. 駐車場にて車両をご確認ください
2. キーボックスの暗証番号を入力し、鍵を取り出してご乗車ください
3. ご出発前に車両各部の写真を必ず撮影してください（下記参照）

【キーボックス暗証番号について】
防犯のため、暗証番号はご出発の前日にお知らせします。
前日に「出発前日リマインダーメール」、または下記の予約確認ページでご確認いただけます。
予約確認ページ：${BASE_URL}/booking.html?token=${entry.viewToken}

【車両写真撮影のお願い】
ご出発前・ご返却前の双方で、以下の箇所を撮影してください。
・車両前後・左右の4面全体
・既存の傷・へこみがある箇所（クローズアップ）
・燃料計（メーター）
※撮影データはトラブル時の証明になります。必ずご自身のスマートフォン等に保存してください。

【返却の手順】
1. 元の駐車スペースに駐車し、車両写真を撮影してください
2. 鍵をキーボックスに戻し、施錠してください
3. キーボックスの番号をランダムにずらしてお離れください

${EMAIL_EMERGENCY_CONTACTS}

【予約確認ページ（いつでも確認できます）】
${BASE_URL}/booking.html?token=${entry.viewToken}

【特定商取引法に基づく表記・キャンセルポリシー】
${BASE_URL}/tokushoho.html

ご不明な点はお気軽にお問い合わせください。
良い旅を！

${EMAIL_HR}
${EMAIL_COMPANY_FOOTER}
営業時間 9時〜18時（年中無休）
${EMAIL_HR}`;

  try {
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: entry.email,
      subject: `【88CAMPCAR】ご予約ありがとうございます — ${entry.start} ご出発`,
      text
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] 予約確認メール送信完了 → ${entry.email}`);
  } catch (err) {
    console.error('[MAIL] 予約確認メール送信エラー:', err.message);
  }
}

/** 出発24時間前リマインダーメール（お客様宛て） */
async function sendDepartureReminder(entry) {
  if (!resend) return;
  const plan = determinePlan(entry.start, entry.end);
  const total = plan.pricePerDay * plan.nights;
  const text = `${entry.name}様

明日 ${entry.start} のご出発まであと1日です。
出発に向けてご確認をお願いします。

━━━━━━━━━━━━━━━━━━━━
期間   : ${entry.start} 〜 ${entry.end}（${plan.nights}泊）
プラン : ${plan.name}
料金   : ¥${total.toLocaleString()}（決済済み）
車両   : ${entry.vehicle}
━━━━━━━━━━━━━━━━━━━━

【出発前チェックリスト】
□ 運転免許証をお持ちですか？
□ キーボックス暗証番号を確認しましたか？→ ${KEY_BOX_CODE}
□ 車両写真（出発前・返却前）を撮影する準備はできていますか？

${EMAIL_LOCATION}

【当日の手順（再掲）】
1. 駐車場にて車両を確認
2. キーボックス（暗証番号：${KEY_BOX_CODE}）から鍵を取り出してご乗車
3. 出発前に車両4面・傷・燃料計を撮影
4. 返却時も同様に撮影 → 鍵をキーボックスに戻して施錠

${EMAIL_EMERGENCY_CONTACTS}

良い旅を！

${EMAIL_HR}
${EMAIL_COMPANY_FOOTER}
${EMAIL_HR}`;

  try {
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: entry.email,
      subject: `【88CAMPCAR】明日 ${entry.start} ご出発 — 最終確認`,
      text
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] 出発リマインダー送信完了 → ${entry.email}`);
  } catch (err) {
    console.error('[MAIL] 出発リマインダーエラー:', err.message);
  }
}

/** 出発24時間前リマインダーを未送信の予約に送信（1時間ごとに実行） */
async function maybeSendDepartureReminders() {
  try {
    const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    const tomorrow = new Date(nowJST);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = jstDateStr(tomorrow);

    const list = await readReservations();
    const targets = list.filter(r =>
      r.start === tomorrowStr &&
      r.status !== 'cancelled' &&
      r.status !== 'pending_payment' &&
      !r.reminderSentAt
    );
    if (!targets.length) return;

    const sent = [];
    for (const r of targets) {
      try { await sendDepartureReminder(r); sent.push(r.id); }
      catch (err) { console.error('[REMINDER] メール送信エラー:', err.message); }
    }
    if (!sent.length) return;
    const sentSet = new Set(sent);
    const now = new Date().toISOString();
    for (const r of list) { if (sentSet.has(r.id)) r.reminderSentAt = now; }
    await writeReservations(list);
    console.log(`[REMINDER] 出発リマインダー送信: ${sent.length}件`);
  } catch (err) {
    console.error('[REMINDER] エラー:', err.message);
  }
}

/** 当日チェックイン・チェックアウト通知メール（管理者宛て） */
async function sendDailyCheckinNotification(dateStr) {
  if (!resend || !ADMIN_EMAIL) return;
  try {
    const list = await readReservations();
    const active = list.filter(r => r.status !== 'cancelled' && r.status !== 'pending_payment');
    const checkIns  = active.filter(r => r.start === dateStr);
    const checkOuts = active.filter(r => r.end   === dateStr);
    if (!checkIns.length && !checkOuts.length) return;
    const lines = [];
    if (checkIns.length) {
      lines.push(`■ 本日チェックイン (${checkIns.length}件)\n` +
        checkIns.map(r => {
          const p = determinePlan(r.start, r.end);
          return `  ${r.name}様 / TEL: ${r.phone} / ${p.name}（${p.nights}泊）/ ¥${(p.pricePerDay * p.nights).toLocaleString()}`;
        }).join('\n'));
    }
    if (checkOuts.length) {
      lines.push(`■ 本日チェックアウト (${checkOuts.length}件)\n` +
        checkOuts.map(r => `  ${r.name}様`).join('\n'));
    }
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: `【88CAMPCAR】本日の予定 ${dateStr}`,
      text: `本日 ${dateStr} の予定をお知らせします。\n\n${lines.join('\n\n')}\n\n管理画面: ${BASE_URL}/admin.html`
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] 当日通知メール送信完了 → ${ADMIN_EMAIL}`);
  } catch (err) {
    console.error('[MAIL] 当日通知メールエラー:', err.message);
  }
}

// ── 書き込みロック（同時リクエストによるレースコンディション防止） ──
let _rwLocked = false;
const _rwQueue = [];
function withReservationLock(fn) {
  const run = async (resolve, reject) => {
    _rwLocked = true;
    try { resolve(await fn()); }
    catch (err) { reject(err); }
    finally {
      _rwLocked = false;
      if (_rwQueue.length) _rwQueue.shift()();
    }
  };
  if (!_rwLocked) return new Promise(run);
  return new Promise((res, rej) => _rwQueue.push(() => run(res, rej)));
}

// ── 日程ブロック（整備・個人使用） ──
const blocksFile = path.join(DATA_DIR, 'blocked-dates.json');

async function readBlocks() {
  try {
    if (fs.existsSync(blocksFile))
      return JSON.parse(await fs.promises.readFile(blocksFile, 'utf8') || '[]');
  } catch { }
  return [];
}

async function writeBlocks(list) {
  const tmp = blocksFile + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fs.promises.rename(tmp, blocksFile);
}

// ── 返却日リマインダーメール（お客様宛て） ──
async function sendReturnReminderEmail(entry) {
  if (!resend) return;
  const text = `${entry.name}様

本日 ${entry.end} はご返却日です。
以下のチェックリストをご確認ください。

【返却チェックリスト】
□ 車内のお忘れ物はありませんか？
□ 車両の写真を撮影しましたか？（4面・傷・燃料計）
□ 鍵をキーボックスに返却しましたか？（暗証番号：${KEY_BOX_CODE}）
□ キーボックスの番号をランダムにずらしましたか？

${EMAIL_LOCATION}

${EMAIL_OVERDUE_POLICY}

${EMAIL_EMERGENCY_CONTACTS}

ご利用ありがとうございました。
またのご利用をお待ちしております！

${EMAIL_HR}
${EMAIL_COMPANY_FOOTER}`;
  try {
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: entry.email,
      subject: `【88CAMPCAR】本日返却日のご確認 — ${entry.end}`,
      text
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] 返却リマインダー送信完了 → ${entry.email}`);
  } catch (err) { console.error('[MAIL] 返却リマインダーエラー:', err.message); }
}

async function maybeSendReturnReminders() {
  try {
    const nowJST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
    if (nowJST.getHours() !== 9) return;
    const ds = jstDateStr(nowJST);
    const list = await readReservations();
    const targets = list.filter(r =>
      r.end === ds && r.status !== 'cancelled' && r.status !== 'pending_payment' && !r.returnReminderSentAt
    );
    if (!targets.length) return;
    for (const r of targets) {
      await sendReturnReminderEmail(r);
      r.returnReminderSentAt = new Date().toISOString();
    }
    await writeReservations(list);
    console.log(`[REMINDER] 返却リマインダー送信: ${targets.length}件`);
  } catch (err) { console.error('[REMINDER] 返却リマインダーエラー:', err.message); }
}

// ── Stripe 返金ユーティリティ ──
async function processStripeRefund(reservation, amountYen) {
  if (!stripe) return { ok: false, error: 'Stripe未設定' };
  try {
    let piId = reservation.stripePaymentIntentId;
    if (!piId && reservation.stripeSessionId) {
      const s = await stripe.checkout.sessions.retrieve(reservation.stripeSessionId);
      piId = s.payment_intent;
    }
    if (!piId) return { ok: false, error: 'PaymentIntentが見つかりません' };
    const refund = await stripe.refunds.create({ payment_intent: piId, amount: amountYen });
    return { ok: true, refundId: refund.id, amount: amountYen };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── キャンセル料計算（管理画面と同ポリシー） ──
function calcCancelFee(reservation) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = reservation.start.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const daysUntil = Math.round((start - today) / MS_PER_DAY);
  const p = determinePlan(reservation.start, reservation.end);
  const total = reservation.paidAmount ?? p.pricePerDay * p.nights;
  const pct = daysUntil >= 8 ? 0 : daysUntil >= 4 ? 30 : daysUntil >= 1 ? 50 : 100;
  const fee    = Math.round(total * pct / 100);
  const refund = total - fee;
  return { total, fee, refund, pct, daysUntil };
}

// ── キャンセル通知メール（お客様宛て） ──
async function sendCancellationEmail(entry, refundAmount, cancelFee, autoProcessed) {
  if (!resend) return;
  const p = determinePlan(entry.start, entry.end);
  const total = entry.paidAmount ?? p.pricePerDay * p.nights;
  const refundNote = refundAmount > 0
    ? autoProcessed
      ? `返金額　: ¥${refundAmount.toLocaleString()}（Stripe自動処理済み。反映まで数営業日）`
      : `返金額　: ¥${refundAmount.toLocaleString()}（管理者より別途処理いたします）`
    : `返金　　: なし（キャンセル料100%）`;
  const text = `${entry.name}様

ご予約のキャンセルを受け付けました。

${EMAIL_HR}
予約ID　: ${entry.id}
期間　　: ${entry.start} 〜 ${entry.end}（${p.nights}泊）
お支払い: ¥${total.toLocaleString()}
キャンセル料: ¥${cancelFee.toLocaleString()}
${refundNote}
${EMAIL_HR}

ご不明な点はお問い合わせください。

${EMAIL_COMPANY_FOOTER}`;
  try {
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: entry.email,
      subject: `【88CAMPCAR】予約キャンセルのご確認 — ${entry.start}〜${entry.end}`,
      text
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] キャンセル通知送信完了 → ${entry.email}`);
  } catch (err) { console.error('[MAIL] キャンセル通知エラー:', err.message); }
}

// ── 日程変更通知メール（お客様宛て） ──
async function sendModificationEmail(entry, oldStart, oldEnd, diff, additionalUrl) {
  if (!resend) return;
  const p = determinePlan(entry.start, entry.end);
  const newTotal = p.pricePerDay * p.nights;
  const changeNote = diff < 0
    ? `差額返金  : ¥${Math.abs(diff).toLocaleString()}（Stripe自動処理済み。反映まで数営業日）`
    : diff > 0
      ? `追加料金  : ¥${diff.toLocaleString()}\n追加決済URL: ${additionalUrl}\n※上記URLより追加分のお支払いをお願いします。`
      : `料金変動  : なし`;
  const text = `${entry.name}様

ご予約の日程を変更しました。

${EMAIL_HR}
予約ID : ${entry.id}
変更前  : ${oldStart} 〜 ${oldEnd}
変更後  : ${entry.start} 〜 ${entry.end}（${p.nights}泊 / ¥${newTotal.toLocaleString()}）
${changeNote}
${EMAIL_HR}

ご不明な点はお問い合わせください。

${EMAIL_COMPANY_FOOTER}`;
  try {
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: entry.email,
      subject: `【88CAMPCAR】予約日程変更のご確認 — ${entry.start}〜${entry.end}`,
      text
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] 日程変更通知送信完了 → ${entry.email}`);
  } catch (err) { console.error('[MAIL] 日程変更通知エラー:', err.message); }
}

// ======================================================
//  データストア（JSONファイル）
// ======================================================
const reservationsFile = path.join(DATA_DIR, 'reservations.json');
const adminAuditFile = path.join(DATA_DIR, 'admin-audit.log');
const uploadsDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// 免許証アップロード（multer）
const _uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${file.fieldname}_${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage: _uploadStorage,
  limits: { fileSize: FILE_SIZE_LIMIT },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
    if (ALLOWED_FILE_TYPES.test(ext) || ALLOWED_FILE_TYPES.test(file.mimetype)) cb(null, true);
    else cb(new Error('許可されていないファイル形式です'));
  }
});

let auditWriteQueue = Promise.resolve();

/** 管理操作ログをJSON Lines形式で追記 */
function writeAdminAudit(req, action, payload = {}) {
  const row = {
    ts: new Date().toISOString(),
    action,
    ip: req.ip,
    ua: req.headers['user-agent'] || '',
    ...payload
  };
  auditWriteQueue = auditWriteQueue
    .then(async () => {
      try {
        const st = await fs.promises.stat(adminAuditFile).catch(() => null);
        if (st && st.size >= AUDIT_LOG_MAX_BYTES) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const rotated = `${adminAuditFile}.${ts}`;
          await fs.promises.rename(adminAuditFile, rotated).catch(() => {});

          const allFiles = await fs.promises.readdir(path.dirname(adminAuditFile));
          const rotatedList = allFiles
            .filter((f) => f.startsWith(path.basename(adminAuditFile) + '.'))
            .sort()
            .reverse();
          const toDelete = rotatedList.slice(AUDIT_LOG_KEEP_FILES);
          for (const f of toDelete) {
            await fs.promises.unlink(path.join(path.dirname(adminAuditFile), f)).catch(() => {});
          }
        }
        await fs.promises.appendFile(adminAuditFile, JSON.stringify(row) + '\n', 'utf8');
      } catch {
        // 監査ログ失敗は本処理を止めない
      }
    })
    .catch(() => {});
}

/** 日次バックアップ（当日分が存在しなければ作成、7世代保持） */
async function backupReservations() {
  try { await fs.promises.access(reservationsFile); } catch { return; }
  const today = new Date().toISOString().slice(0, 10);
  const backupFile = path.join(DATA_DIR, `reservations.backup.${today}.json`);
  try { await fs.promises.access(backupFile); return; } catch { /* proceed */ }
  try {
    await fs.promises.copyFile(reservationsFile, backupFile);
    console.log(`[BACKUP] バックアップ作成: reservations.backup.${today}.json`);
    const dir = await fs.promises.readdir(DATA_DIR);
    const old = dir
      .filter(f => /^reservations\.backup\.\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort().reverse().slice(7);
    for (const f of old) {
      await fs.promises.unlink(path.join(DATA_DIR, f)).catch(() => {});
      console.log(`[BACKUP] 古いバックアップ削除: ${f}`);
    }
  } catch (err) {
    console.error('[BACKUP] バックアップエラー:', err.message);
  }
}

/** 予約データを非同期で読み込み */
async function readReservations() {
  try {
    if (fs.existsSync(reservationsFile)) {
      const data = await fs.promises.readFile(reservationsFile, 'utf8');
      return JSON.parse(data || '[]');
    }
  } catch (e) {
    console.error('[DATA] 予約データ読み込みエラー:', e.message);
  }
  return [];
}

/** 予約データを非同期で書き込み（アトミック書き込み） */
async function writeReservations(list) {
  const tmpFile = reservationsFile + '.tmp';
  await fs.promises.writeFile(tmpFile, JSON.stringify(list, null, 2), 'utf8');
  await fs.promises.rename(tmpFile, reservationsFile);
}

/**
 * ダブルブッキングチェック
 * @param {string} start - YYYY-MM-DD
 * @param {string} end - YYYY-MM-DD
 * @param {string} [excludeId] - 除外するID
 * @param {Array} list - 予約リスト
 * @returns {boolean}
 */
function hasConflict(start, end, excludeId, list) {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return list.some(r => {
    if (excludeId && r.id === excludeId) return false;
    if (r.status === 'cancelled') return false;
    const rs = new Date(r.start).getTime();
    const re = new Date(r.end).getTime();
    return s < re && e > rs;
  });
}


// ======================================================
//  認証ミドルウェア
// ======================================================

/**
 * 管理者認証（タイミング安全比較）
 */
function adminAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const tokenFromHeader = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const tokenFromQuery = typeof req.query?.token === 'string' ? req.query.token : '';
  const cookies = parseCookies(req.headers.cookie || '');
  const tokenFromCookie = cookies[ADMIN_COOKIE_NAME] || '';
  const token = tokenFromHeader || tokenFromQuery || tokenFromCookie;

  const session = getAdminSession(token);
  if (!session) return res.status(401).json({ error: '管理者認証が必要です' });

  req.adminSession = session;
  req.adminSessionToken = token;
  next();
}

/**
 * 管理APIのCSRF検証（状態変更系で必須）
 */
function requireAdminCsrf(req, res, next) {
  const csrf = req.headers['x-csrf-token'];
  const expected = req.adminSession?.csrfToken || '';
  if (typeof csrf !== 'string' || !expected || !safeCompare(csrf, expected)) {
    return res.status(403).json({ error: 'CSRFトークンが不正です。再ログインしてください。' });
  }
  next();
}

// ======================================================
//  静的ファイル配信
// ======================================================
// 機微なファイル/ディレクトリへの直接アクセスを拒否
// （本番の DATA_DIR が配信ルート配下にあるため、データ・ログ・サーバーコード等の漏えいを防ぐ）
app.use((req, res, next) => {
  const p = req.path || '';
  if (/^\/(storage|server|node_modules|scripts)(\/|$)/i.test(p) ||
      /\.(json|log|tmp|lock|bak|env)$/i.test(p)) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.static(path.join(__dirname, '..'), {
  dotfiles: 'deny',
  index: 'index.html',
  maxAge: '7d',            // 静的ファイルのキャッシュ
  etag: true,
  setHeaders: (res, filePath) => {
    // HTML / JS / CSS は常に最新を取得（コード更新を即時反映し、クライアント側の古いキャッシュを防ぐ）
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// アップロードファイルは管理者認証必須
app.use('/uploads', adminAuth, express.static(uploadsDir));

// 管理者向け: 免許証画像の安全な配信
app.get(['/api/admin/license/:filename', '/_/admin/license/:filename', '/x1/r/license/:filename'], adminAuth, async (req, res, next) => {
  try {
    const safeName = path.basename(req.params.filename || '');
    if (!safeName) return res.status(400).json({ error: 'ファイル名が不正です' });
    const fp = path.join(uploadsDir, safeName);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'ファイルが見つかりません' });
    res.sendFile(fp);
  } catch (err) {
    next(err);
  }
});

// ======================================================
//  ヘルスチェック
// ======================================================
app.get(['/api/health', '/_/health', '/x1/ping'], (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// メール診断エンドポイント（管理者認証必須）
app.post('/x1/mail-test', adminAuth, async (req, res) => {
  if (!resend) {
    return res.json({ ok: false, error: 'resend が null — RESEND_API_KEY が未設定の可能性があります' });
  }
  try {
    const { data, error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: ADMIN_EMAIL,
      subject: '【診断テスト】Render からのメール送信確認',
      text: 'Render サーバーからの Resend メールテストです。このメールが届いていれば正常です。'
    });
    if (error) return res.json({ ok: false, step: 'sendMail', error: error.message });
    return res.json({ ok: true, messageId: data?.id, to: ADMIN_EMAIL });
  } catch (err) {
    return res.json({ ok: false, step: 'sendMail', error: err.message });
  }
});

// ======================================================
//  Stripe Checkout Session API
// ======================================================

// ======================================================
//  予約 API
// ======================================================

// 予約済み日付を返す（カレンダー表示用）
app.get('/api/reservations/dates', async (req, res, next) => {
  try {
    const [list, blocks] = await Promise.all([readReservations(), readBlocks()]);
    const booked = new Set();
    for (const r of list.filter(r => r.status !== 'cancelled')) {
      for (let d = new Date(r.start); d < new Date(r.end); d.setDate(d.getDate() + 1))
        booked.add(d.toISOString().slice(0, 10));
    }
    for (const b of blocks) {
      for (let d = new Date(b.start); d <= new Date(b.end); d.setDate(d.getDate() + 1))
        booked.add(d.toISOString().slice(0, 10));
    }
    res.json({ booked: [...booked], blocked: blocks });
  } catch (err) { next(err); }
});

// 予約情報を受け取りStripe Checkout Sessionを作成（免許証はご来店時確認）
app.post('/api/checkout-with-reservation',
  rateLimit(RATE_WINDOW_MS, RATE_MAX_RESERVE),
  upload.fields([
    { name: 'license_front', maxCount: 1 },
    { name: 'license_back',  maxCount: 1 },
  ]),
  async (req, res, next) => {
    // バリデーション失敗時にアップロード済みの免許証ファイルを削除
    const cleanupFiles = () => {
      for (const k of ['license_front', 'license_back']) {
        const f = req.files?.[k]?.[0];
        if (f?.path) fs.promises.unlink(f.path).catch(() => {});
      }
    };
    const bad = (code, error) => { cleanupFiles(); return res.status(code).json({ error }); };
    try {
      if (!stripe) return bad(503, 'Stripe が設定されていません');

      const name  = sanitize(req.body?.name);
      const email = sanitize(req.body?.email);
      const phone = sanitize(req.body?.phone);
      const start = sanitize(req.body?.start);
      const end   = sanitize(req.body?.end);
      const licenseFront = req.files?.license_front?.[0]?.filename || null;
      const licenseBack  = req.files?.license_back?.[0]?.filename  || null;

      if (!name || !email || !phone || !start || !end)
        return bad(400, '必須項目が不足しています');
      if (req.body?.consent !== 'true' && req.body?.consent !== true)
        return bad(400, '貸渡契約書・保証金の内容への同意が必要です');
      if (!licenseFront || !licenseBack)
        return bad(400, '運転免許証（表・裏）の画像をアップロードしてください');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return bad(400, '有効なメールアドレスを入力してください');
      if (!isValidPhone(phone))
        return bad(400, '有効な電話番号を入力してください');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
        return bad(400, '日付形式が不正です');
      if (new Date(start) >= new Date(end))
        return bad(400, '終了日は開始日の翌日以降にしてください');
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (new Date(start) < today)
        return bad(400, '過去の日付は指定できません');

      // ロック内で競合チェック＋仮予約書き込み
      const plan = determinePlan(start, end);
      const priceId = STRIPE_PRICE_IDS[plan.planKey];
      let entry;
      try {
        entry = await withReservationLock(async () => {
          const list = await readReservations();
          const oneHourAgo = Date.now() - 60 * 60 * 1000;
          const activeList = list.filter(r =>
            r.status !== 'pending_payment' || new Date(r.createdAt).getTime() > oneHourAgo
          );
          // ブロック日程との重複チェック
          const blocks = await readBlocks();
          for (const b of blocks) {
            const bs = new Date(b.start).getTime(), be = new Date(b.end).getTime() + 86400000;
            if (new Date(start).getTime() < be && new Date(end).getTime() > bs)
              throw Object.assign(new Error('ご指定の日程はご利用いただけません。別の日程をお選びください。'), { status: 409 });
          }
          if (hasConflict(start, end, null, activeList))
            throw Object.assign(new Error('ご指定の日程は既に予約済みです。別の日程をお選びください。'), { status: 409 });
          const e = { id: generateId(), name, email, phone, start, end, vehicle: 'スーパーロングハイエース', status: 'pending_payment', createdAt: new Date().toISOString(), agreedAt: new Date().toISOString(), agreedTerms: 'yakkan+deposit-v1', licenseFront, licenseBack };
          list.push(e);
          await writeReservations(list);
          return e;
        });
      } catch (lockErr) {
        cleanupFiles();
        return res.status(lockErr.status || 500).json({ error: lockErr.message });
      }

      // Stripe Checkout Session 作成
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: plan.nights }],
        mode: 'payment',
        customer_email: email,
        // 保証金（クリーニング・超過・損傷）の事後請求に備え、カードを保存する
        customer_creation: 'always',
        payment_intent_data: { setup_future_usage: 'off_session' },
        metadata: { reservationId: entry.id },
        success_url: `${BASE_URL}/?booking=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${BASE_URL}/?booking=cancelled&rid=${entry.id}`,
      });

      res.json({ url: session.url });
    } catch (err) {
      next(err);
    }
  }
);

// Stripe 決済完了後の予約確定
app.get('/api/confirm-payment', async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe が設定されていません' });

    const { session_id } = req.query;
    if (!session_id || typeof session_id !== 'string')
      return res.status(400).json({ error: 'session_id が必要です' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid')
      return res.status(402).json({ error: '支払いが確認できませんでした' });

    const reservationId = session.metadata?.reservationId;
    if (!reservationId) return res.status(400).json({ error: '予約IDが見つかりません' });

    const list = await readReservations();
    const idx = list.findIndex(r => r.id === reservationId);
    if (idx === -1) return res.status(404).json({ error: '予約が見つかりません' });
    if (list[idx].status !== 'pending_payment')
      return res.json({ ok: true }); // 既に確定済み

    list[idx].status = 'pending';
    list[idx].stripeSessionId = session_id;
    list[idx].stripePaymentIntentId = session.payment_intent || null;
    const _crefs = await getStripePaymentRefs(session);
    list[idx].stripeCustomerId = _crefs.customerId;
    list[idx].stripePaymentMethodId = _crefs.paymentMethodId;
    const _cp = determinePlan(list[idx].start, list[idx].end);
    list[idx].paidAmount = _cp.pricePerDay * _cp.nights;
    list[idx].viewToken = list[idx].viewToken || crypto.randomBytes(24).toString('hex');
    list[idx].updatedAt = new Date().toISOString();
    await writeReservations(list);

    Promise.allSettled([
      sendReservationEmail(list[idx]),
      sendReservationAutoReply(list[idx])
    ]).catch(err => console.error('[MAIL] err:', err.message));

    res.json({ ok: true, name: list[idx].name });
  } catch (err) {
    next(err);
  }
});

// 決済キャンセル時の仮予約削除
app.post('/api/cancel-reservation', async (req, res, next) => {
  try {
    const { rid } = req.body;
    if (!rid || typeof rid !== 'string') return res.status(400).json({ error: 'rid が必要です' });

    const list = await readReservations();
    const idx = list.findIndex(r => r.id === rid && r.status === 'pending_payment');
    if (idx === -1) return res.json({ ok: true });

    for (const f of [list[idx].licenseFront, list[idx].licenseBack]) {
      if (f) { try { await fs.promises.unlink(path.join(uploadsDir, f)); } catch {} }
    }
    list.splice(idx, 1);
    await writeReservations(list);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});


// ======================================================
//  お問い合わせ API
// ======================================================
const RATE_MAX_CONTACT = 5; // 15分間に5件まで

/**
 * お問い合わせ自動返信メール送信（送信者宛て）
 * @param {Object} data - { name, email, subject, message }
 */
async function sendContactAutoReply(data) {
  if (!resend) return;
  const text = `${data.name}様　お問い合わせありがとうございます。

お問い合わせ内容
----------------------------
お名前
${data.name}

メールアドレス
${data.email}

題名
${data.subject}

メッセージ本文
${data.message}

----------------------------

お問い合わせありがとうございました。
折り返し担当者よりご連絡させていただきますので、
しばらくお待ちください。

＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊
株式会社88PERCENT　88CAMPCARレンタルシステム
担当：鈴木　　mobile：080-85200-6929
${BASE_URL}
お問合せ 88per88cent@gmail.com
営業時間 9 時〜18 時（年中無休）
＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊＊

本メールは 88PERCENT　88CAMPCARレンタルシステム（${BASE_URL}）のお問い合わせフォームから送信されました`;

  try {
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: data.email,
      subject: `【88CAMPCAR】お問い合わせありがとうございます — ${data.subject}`,
      text
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] お問い合わせ自動返信送信完了 → ${data.email}`);
  } catch (err) {
    console.error('[MAIL] お問い合わせ自動返信エラー:', err.message);
  }
}

/**
 * お問い合わせ通知メール送信（管理者宛て）
 * @param {Object} data - { name, email, subject, message }
 */
async function sendContactNotification(data) {
  if (!resend || !ADMIN_EMAIL) return;
  const html = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;border:2px solid #111;border-radius:8px;overflow:hidden;">
      <div style="background:#111;color:#fff;padding:20px 24px;">
        <h1 style="margin:0;font-size:20px;letter-spacing:.05em;">✉️ 88CAMPCAR — 新規お問い合わせ</h1>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#888;width:100px;">お名前</td><td style="padding:8px 0;font-weight:700;">${sanitize(data.name)}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">メール</td><td style="padding:8px 0;"><a href="mailto:${sanitize(data.email)}">${sanitize(data.email)}</a></td></tr>
          <tr><td style="padding:8px 0;color:#888;">題名</td><td style="padding:8px 0;font-weight:700;">${sanitize(data.subject)}</td></tr>
          <tr style="border-top:1px solid #eee;"><td style="padding:12px 0 8px;color:#888;vertical-align:top;">本文</td><td style="padding:12px 0 8px;white-space:pre-wrap;">${sanitize(data.message)}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">受信日時</td><td style="padding:8px 0;">${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td></tr>
        </table>
        <div style="margin-top:20px;text-align:center;">
          <a href="mailto:${sanitize(data.email)}?subject=Re: ${encodeURIComponent(data.subject)}" style="display:inline-block;background:#f97316;color:#fff;padding:12px 28px;text-decoration:none;font-size:13px;font-weight:700;border-radius:6px;letter-spacing:.05em;">返信する →</a>
        </div>
      </div>
      <div style="background:#f8f8f8;padding:12px 24px;text-align:center;font-size:11px;color:#aaa;">
        88CAMPCAR Contact Form
      </div>
    </div>
  `;

  try {
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: ADMIN_EMAIL,
      replyTo: data.email,
      subject: `【お問い合わせ】${data.name}様 — ${data.subject}`,
      html
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] お問い合わせ管理者通知送信完了 → ${ADMIN_EMAIL}`);
  } catch (err) {
    console.error('[MAIL] お問い合わせ管理者通知エラー:', err.message);
  }
}

// お問い合わせ送信 — レート制限付き
app.post('/api/contact',
  rateLimit(RATE_WINDOW_MS, RATE_MAX_CONTACT),
  async (req, res, next) => {
    try {
      const name = sanitize(req.body?.name);
      const email = sanitize(req.body?.email);
      const subject = sanitize(req.body?.subject);
      const message = (typeof req.body?.message === 'string' ? req.body.message : '').trim().slice(0, 5000);

      // 必須項目チェック
      if (!name || !email || !subject || !message) {
        return res.status(400).json({ error: '必須項目が不足しています' });
      }
      // メール形式チェック
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: '有効なメールアドレスを入力してください' });
      }

      const data = { name, email, subject, message };

      // 自動返信（送信者宛て）＋ 管理者通知を並行送信
      await Promise.allSettled([
        sendContactAutoReply(data),
        sendContactNotification(data)
      ]);

      res.json({ ok: true, message: 'お問い合わせを送信しました。確認メールをお送りしましたのでご確認ください。' });
    } catch (err) {
      next(err);
    }
  }
);

// ======================================================
//  管理者 API
// ======================================================

// 管理者ログイン検証（レート制限付き）
app.post(['/api/admin/login', '/_/admin/login', '/x1/r/login'],
  rateLimit(RATE_WINDOW_MS, RATE_MAX_LOGIN),
  (req, res) => {
    const { password } = req.body || {};
    if (!password || !verifyAdminPassword(password)) {
      writeAdminAudit(req, 'admin_login_failed');
      return res.status(401).json({ error: 'パスワードが正しくありません' });
    }

    const session = createAdminSession();
    res.cookie(ADMIN_COOKIE_NAME, session.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: SESSION_TTL_MS,
      path: '/'
    });
    writeAdminAudit(req, 'admin_login_success');
    res.json({ ok: true });
  }
);

// 管理者ログアウト
app.post(['/api/admin/logout', '/_/admin/logout', '/x1/r/logout'], adminAuth, (req, res) => {
  if (req.adminSessionToken) adminSessionMap.delete(req.adminSessionToken);
  res.clearCookie(ADMIN_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });
  writeAdminAudit(req, 'admin_logout');
  res.json({ ok: true });
});

// 管理画面用CSRFトークン取得
app.get(['/api/admin/csrf', '/_/admin/csrf', '/x1/r/csrf'], adminAuth, (req, res) => {
  if (req.adminSession?.csrfToken) {
    return res.json({ ok: true, csrfToken: req.adminSession.csrfToken });
  }
  return res.status(400).json({ error: 'CSRFトークンを発行できません。再ログインしてください。' });
});

// 全予約取得（viewToken未生成の既存予約を自動補完）
app.get(['/api/admin/reservations', '/_/admin/reservations', '/x1/r/list'], adminAuth, async (req, res, next) => {
  try {
    const list = await readReservations();
    let needsSave = false;
    for (const r of list) {
      if (!r.viewToken && r.status !== 'pending_payment') {
        r.viewToken = crypto.randomBytes(24).toString('hex');
        needsSave = true;
      }
    }
    if (needsSave) await writeReservations(list);
    res.json(list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  } catch (err) {
    next(err);
  }
});

// 予約ステータス更新（autoRefund: true でキャンセル時にStripe返金を自動実行）
app.patch(['/api/admin/reservations/:id', '/_/admin/reservations/:id', '/x1/r/item/:id'], adminAuth, requireAdminCsrf, async (req, res, next) => {
  try {
    const { status, autoRefund, note } = req.body;
    const list = await readReservations();
    const idx = list.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '予約が見つかりません' });

    // メモのみ更新
    if (note !== undefined && !status) {
      list[idx].note = typeof note === 'string' ? note.trim().slice(0, 1000) : '';
      list[idx].updatedAt = new Date().toISOString();
      await writeReservations(list);
      return res.json({ ok: true });
    }

    if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: '無効なステータス' });
    }

    if (status === 'cancelled') {
      const cf = calcCancelFee(list[idx]);
      if (autoRefund && cf.refund > 0) {
        const result = await processStripeRefund(list[idx], cf.refund);
        if (!result.ok) return res.status(502).json({ error: `Stripe返金失敗: ${result.error}` });
        list[idx].stripeRefundId = result.refundId;
        list[idx].stripeRefundAmount = cf.refund;
      }
      list[idx].status = 'cancelled';
      list[idx].updatedAt = new Date().toISOString();
      await writeReservations(list);
      writeAdminAudit(req, 'reservation_cancelled', { reservationId: req.params.id, autoRefund: !!autoRefund, refundAmount: autoRefund ? cf.refund : 0 });
      sendCancellationEmail(list[idx], cf.refund, cf.fee, !!autoRefund).catch(console.error);
      return res.json({ ok: true, reservation: list[idx], refundAmount: autoRefund ? cf.refund : 0 });
    }

    list[idx].status = status;
    list[idx].updatedAt = new Date().toISOString();
    await writeReservations(list);
    writeAdminAudit(req, 'reservation_status_changed', { reservationId: req.params.id, status });
    res.json({ ok: true, reservation: list[idx] });
  } catch (err) {
    next(err);
  }
});

// 予約日程変更（差額を自動返金 or 追加決済リンクを生成）
app.patch(['/x1/r/item/:id/dates'], adminAuth, requireAdminCsrf, async (req, res, next) => {
  try {
    const { start: newStart, end: newEnd } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newStart) || !/^\d{4}-\d{2}-\d{2}$/.test(newEnd))
      return res.status(400).json({ error: '日付形式が不正です' });
    if (new Date(newStart) >= new Date(newEnd))
      return res.status(400).json({ error: '終了日は開始日の翌日以降にしてください' });

    const list = await readReservations();
    const idx = list.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '予約が見つかりません' });
    const r = list[idx];
    if (r.status === 'cancelled') return res.status(400).json({ error: 'キャンセル済みの予約は変更できません' });

    if (hasConflict(newStart, newEnd, r.id, list))
      return res.status(409).json({ error: '指定の日程は他の予約と重複しています' });

    const oldStart = r.start, oldEnd = r.end;
    const paidAmount = r.paidAmount ?? (determinePlan(r.start, r.end).pricePerDay * determinePlan(r.start, r.end).nights);
    const newPlan = determinePlan(newStart, newEnd);
    const newTotal = newPlan.pricePerDay * newPlan.nights;
    const diff = newTotal - paidAmount;

    let additionalUrl = null;

    if (diff < 0) {
      const result = await processStripeRefund(r, Math.abs(diff));
      if (!result.ok) return res.status(502).json({ error: `Stripe返金失敗: ${result.error}` });
      list[idx].stripeRefundId = result.refundId;
      list[idx].stripeRefundAmount = (r.stripeRefundAmount || 0) + Math.abs(diff);
      list[idx].paidAmount = newTotal;
    } else if (diff > 0) {
      if (!stripe) return res.status(503).json({ error: 'Stripe未設定' });
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'jpy',
            product_data: { name: `88CAMPCAR 追加料金（${newStart}〜${newEnd}）` },
            unit_amount: diff,
          },
          quantity: 1,
        }],
        mode: 'payment',
        customer_email: r.email,
        metadata: { reservationId: r.id, type: 'modification' },
        success_url: `${BASE_URL}/admin.html`,
        cancel_url:  `${BASE_URL}/admin.html`,
      });
      additionalUrl = session.url;
      list[idx].pendingAdditionalAmount = diff;
      list[idx].pendingAdditionalUrl = additionalUrl;
    }

    list[idx].start = newStart;
    list[idx].end = newEnd;
    list[idx].updatedAt = new Date().toISOString();
    await writeReservations(list);
    writeAdminAudit(req, 'reservation_dates_modified', { reservationId: r.id, oldStart, oldEnd, newStart, newEnd, diff });
    sendModificationEmail(list[idx], oldStart, oldEnd, diff, additionalUrl).catch(console.error);

    res.json({ ok: true, diff, additionalUrl });
  } catch (err) {
    next(err);
  }
});

// 予約削除
/** 保証金請求のレシートメール（お客様宛て） */
async function sendDepositChargeEmail(entry, amount, reason) {
  if (!resend) return;
  const text = `${entry.name}様

ご利用いただきありがとうございました。
ご返却後の精算として、保証金より下記のとおりご請求（カード決済）いたしました。

━━━━━━━━━━━━━━━━━━━━
予約ID : ${entry.id}
請求額 : ¥${amount.toLocaleString()}
内容   : ${reason}
━━━━━━━━━━━━━━━━━━━━

ご不明な点がございましたら、担当（鈴木 / 080-8520-6929）までお問い合わせください。

${EMAIL_HR}
${EMAIL_COMPANY_FOOTER}`;
  try {
    const { error } = await resend.emails.send({
      from: `88CAMPCAR <${MAIL_FROM}>`,
      to: entry.email,
      subject: `【88CAMPCAR】保証金からのご請求 — ¥${amount.toLocaleString()}（${reason}）`,
      text,
    });
    if (error) throw new Error(error.message);
    console.log(`[MAIL] 保証金請求メール送信完了 → ${entry.email}`);
  } catch (err) { console.error('[MAIL] 保証金請求メールエラー:', err.message); }
}

// ── 保証金の事後請求（クリーニング・超過・損傷をカードへ） ──
app.post(['/x1/r/item/:id/charge-deposit'], adminAuth, requireAdminCsrf, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe が設定されていません' });
    const id = req.params.id;
    const amount = Math.round(Number(req.body?.amount));
    const reason = sanitize(req.body?.reason);
    if (!Number.isInteger(amount) || amount <= 0)
      return res.status(400).json({ error: '金額が不正です' });
    if (!reason)
      return res.status(400).json({ error: '請求理由を入力してください' });

    const list = await readReservations();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return res.status(404).json({ error: '予約が見つかりません' });
    const r = list[idx];

    if (!r.stripeCustomerId || !r.stripePaymentMethodId)
      return res.status(400).json({ error: 'この予約にはカード情報が保存されていません（保証金機能の導入前の予約です）。決済リンクでご請求ください。' });

    const already = (r.depositCharges || []).reduce((s, c) => s + (c.amount || 0), 0);
    if (already + amount > DEPOSIT_CAP)
      return res.status(400).json({ error: `保証金の上限（¥${DEPOSIT_CAP.toLocaleString()}）を超えます。請求済み ¥${already.toLocaleString()} / 残り ¥${(DEPOSIT_CAP - already).toLocaleString()}` });

    let pi;
    try {
      pi = await stripe.paymentIntents.create({
        amount, currency: 'jpy',
        customer: r.stripeCustomerId,
        payment_method: r.stripePaymentMethodId,
        off_session: true,
        confirm: true,
        metadata: { reservationId: r.id, type: 'deposit', reason },
      });
    } catch (e) {
      console.error('[DEPOSIT] 課金失敗:', e.code || e.type, e.message);
      return res.status(402).json({ error: `カードへの請求に失敗しました（${e.code || 'エラー'}）。残高不足やカード会社の本人認証要求の可能性があります。お客様に決済リンクを送るなど別の方法でご対応ください。` });
    }

    if (pi.status !== 'succeeded')
      return res.status(402).json({ error: `請求が完了しませんでした（状態: ${pi.status}）。別の方法でご対応ください。` });

    r.depositCharges = [...(r.depositCharges || []), {
      amount, reason, piId: pi.id, at: new Date().toISOString(),
    }];
    r.updatedAt = new Date().toISOString();
    await writeReservations(list);
    writeAdminAudit(req, 'deposit_charged', { reservationId: r.id, amount, reason, piId: pi.id });
    sendDepositChargeEmail(r, amount, reason).catch(console.error);

    const totalCharged = already + amount;
    res.json({ ok: true, amount, totalCharged, remaining: DEPOSIT_CAP - totalCharged });
  } catch (err) { next(err); }
});

app.delete(['/api/admin/reservations/:id', '/_/admin/reservations/:id', '/x1/r/item/:id'], adminAuth, requireAdminCsrf, async (req, res, next) => {
  try {
    let list = await readReservations();
    const target = list.find(r => r.id === req.params.id);
    if (!target) return res.status(404).json({ error: '予約が見つかりません' });
    // 関連ファイル削除
    for (const f of [target.licenseFront, target.licenseBack]) {
      if (f) {
        const fp = path.join(uploadsDir, f);
        try { await fs.promises.unlink(fp); } catch { /* ファイルが存在しない場合は無視 */ }
      }
    }
    list = list.filter(r => r.id !== req.params.id);
    await writeReservations(list);
    writeAdminAudit(req, 'reservation_deleted', {
      reservationId: req.params.id,
      name: target.name,
      email: target.email
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── ブロック一覧（管理者） ──
app.get('/x1/r/blocks', adminAuth, async (req, res, next) => {
  try { res.json(await readBlocks()); }
  catch (err) { next(err); }
});

// ── ブロック追加（管理者） ──
app.post('/x1/r/blocks', adminAuth, requireAdminCsrf, async (req, res, next) => {
  try {
    const start  = sanitize(req.body?.start  || '');
    const end    = sanitize(req.body?.end    || '');
    const reason = sanitize(req.body?.reason || '').slice(0, 100);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
      return res.status(400).json({ error: '日付が不正です' });
    if (start > end) return res.status(400).json({ error: '終了日は開始日以降にしてください' });
    const block = { id: generateId(), start, end, reason, createdAt: new Date().toISOString() };
    const list = await readBlocks();
    list.push(block);
    await writeBlocks(list);
    writeAdminAudit(req, 'block_added', { start, end, reason });
    res.json({ ok: true, block });
  } catch (err) { next(err); }
});

// ── ブロック削除（管理者） ──
app.delete('/x1/r/blocks/:id', adminAuth, requireAdminCsrf, async (req, res, next) => {
  try {
    let list = await readBlocks();
    if (!list.find(b => b.id === req.params.id))
      return res.status(404).json({ error: 'ブロックが見つかりません' });
    await writeBlocks(list.filter(b => b.id !== req.params.id));
    writeAdminAudit(req, 'block_deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── お客様予約確認（viewToken認証） ──
app.get('/api/booking/:token', async (req, res, next) => {
  try {
    const token = req.params.token;
    if (!token || typeof token !== 'string' || token.length < 48)
      return res.status(400).json({ error: '無効なトークンです' });
    const list = await readReservations();
    const r = list.find(x => x.viewToken === token);
    if (!r) return res.status(404).json({ error: '予約が見つかりません' });
    const p = determinePlan(r.start, r.end);
    const active = r.status === 'pending' || r.status === 'confirmed';
    // 暗証番号は防犯＋本人確認のため「確定（免許証確認済み）」かつ「出発前日〜返却日」のみ開示する
    const confirmed = r.status === 'confirmed';
    const revealFrom = keyBoxRevealDate(r.start);
    const today = todayJST();
    const keyBoxRevealed = confirmed && today >= revealFrom && today <= r.end;
    let keyBoxNote = null;
    if (active && !keyBoxRevealed) {
      if (!confirmed) keyBoxNote = 'ご本人確認（免許証）の確認後、出発前日に表示されます';
      else if (today < revealFrom) keyBoxNote = `出発前日（${revealFrom.replace(/-/g, '/')}）に表示されます`;
      else keyBoxNote = '暗証番号の表示期間を過ぎています。担当までお問い合わせください';
    }
    res.json({
      id: r.id, name: r.name, start: r.start, end: r.end,
      planName: p.name, nights: p.nights, total: p.pricePerDay * p.nights,
      status: r.status, vehicle: r.vehicle,
      keyBox: keyBoxRevealed ? KEY_BOX_CODE : null,
      keyBoxNote,
      hasLicense: !!(r.licenseFront && r.licenseBack),
    });
  } catch (err) { next(err); }
});

// ======================================================
//  404 ハンドラ
// ======================================================
app.use((_req, res) => {
  res.status(404).json({ error: 'ページが見つかりません' });
});

// ======================================================
//  グローバルエラーハンドラ
// ======================================================
app.use((err, _req, res, _next) => {
  // アップロードエラー（multer）
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ error: 'ファイルサイズが上限（10MB）を超えています' });
    return res.status(400).json({ error: `アップロードエラー: ${err.message}` });
  }
  if (err && err.message === '許可されていないファイル形式です')
    return res.status(400).json({ error: err.message });
  // それ以外の予期しないエラー
  console.error('[ERROR]', err.stack || err.message);
  res.status(500).json({ error: 'サーバーエラーが発生しました。しばらくしてからお試しください。' });
});

// ======================================================
//  サーバー起動 & グレースフルシャットダウン
// ======================================================
function getLanIpv4List() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const items of Object.values(nets)) {
    for (const info of items || []) {
      if (info && info.family === 'IPv4' && !info.internal) addrs.push(info.address);
    }
  }
  return [...new Set(addrs)];
}

const server = app.listen({ port: PORT, host: '::', ipv6Only: false }, () => {
  console.log(`[SERVER] Running: http://localhost:${PORT}`);
  console.log(`[SERVER] Admin:   http://localhost:${PORT}/admin.html`);
  const lanIps = getLanIpv4List();
  for (const ip of lanIps) {
    console.log(`[SERVER] LAN:     http://${ip}:${PORT}/admin.html`);
  }
  // 起動完了後に初回実行（リッスン開始をブロックしない）
  setImmediate(() => {
    maybeSendDepartureReminders();
    backupReservations();
  });
});

function gracefulShutdown(signal) {
  console.log(`\n[SERVER] ${signal} 受信 — シャットダウン中...`);
  server.close(() => {
    clearInterval(cleanupTimer);
    clearInterval(reservationCleanupTimer);
    clearInterval(dailyNotificationTimer);
    clearInterval(departureReminderTimer);
    clearInterval(returnReminderTimer);
    clearInterval(backupTimer);
    console.log('[SERVER] 正常終了');
    process.exit(0);
  });
  // 10秒以内に終了しなければ強制終了
  setTimeout(() => {
    console.error('[SERVER] 強制終了');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
