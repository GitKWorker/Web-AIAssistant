'use strict';

// 统计 R2 桶的当前占用：对象数、总字节、按前缀分类、最大对象。
// 走 S3 ListObjectsV2 分页遍历，纯 node:crypto 签名，零依赖。
// 用法:
//   node scripts/r2-usage.js           控制台报告
//   node scripts/r2-usage.js --json    JSON 输出
//   node scripts/r2-usage.js --push    同时推送到企业微信群机器人
// 推送密钥来源（按优先级）：环境变量 WECOM_WEBHOOK_KEY / QW_WEBHOOK / .env.local 同名键

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ---- 读取 .env.local ----
(function loadEnv() {
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const ACCOUNT_ID = String(process.env.R2_ACCOUNT_ID || '').trim();
const ACCESS_KEY = String(process.env.R2_ACCESS_KEY || '').trim();
const SECRET_KEY = String(process.env.R2_SECRET_KEY || '').trim();
const BUCKET = String(process.env.R2_BUCKET || '').trim();

if (!ACCOUNT_ID || !ACCESS_KEY || !SECRET_KEY || !BUCKET) {
  console.error('缺少 R2_ACCOUNT_ID / R2_ACCESS_KEY / R2_SECRET_KEY / R2_BUCKET');
  process.exit(1);
}

const HOST = `${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const REGION = 'auto';
const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function awsUriEncode(value) {
  return String(value).replace(/[^A-Za-z0-9\-._~]/g, (ch) =>
    Buffer.from(ch, 'utf8')
      .toString('hex')
      .replace(/(..)/g, '%$1')
      .toUpperCase()
  );
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

// 签一个 GET 请求（query 参与签名）
function signedGet(canonicalUri, query, keepEmpty) {
  const now = new Date();
  const amzDate = `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const pairs = Object.keys(query)
    .filter((k) => query[k] !== undefined && query[k] !== null && (keepEmpty || query[k] !== ''))
    .map((k) => [awsUriEncode(k), awsUriEncode(query[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalHeaders = `host:${HOST}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${SECRET_KEY}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const url = `https://${HOST}${canonicalUri}${canonicalQuery ? '?' + canonicalQuery : ''}`;
  return fetch(url, {
    method: 'GET',
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      Authorization:
        `${ALGORITHM} Credential=${ACCESS_KEY}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

// 极简 XML 取值：只取本脚本需要的那几个标签
function pickAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function pick(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1] : '';
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function listAll() {
  const objects = [];
  let token = '';
  let pages = 0;

  for (;;) {
    const res = await signedGet(`/${BUCKET}`, {
      'list-type': '2',
      'max-keys': '1000',
      'continuation-token': token,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ListObjects 失败 HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    const xml = await res.text();
    pages += 1;

    const contents = pickAll(xml, 'Contents');
    for (const block of contents) {
      const key = decodeXml(pick(block, 'Key'));
      objects.push({
        key,
        size: Number(pick(block, 'Size') || 0),
        lastModified: pick(block, 'LastModified'),
      });
    }

    const truncated = pick(xml, 'IsTruncated') === 'true';
    if (!truncated) break;
    token = decodeXml(pick(xml, 'NextContinuationToken'));
    if (!token) break;
    if (pages > 500) throw new Error('分页超过 500 页，中止');
  }

  return { objects, pages };
}

// 查询桶的生命周期规则，确认 7 天自动清理是否真的生效
async function checkLifecycle() {
  try {
    const res = await signedGet(`/${BUCKET}`, { lifecycle: '' }, true);
    if (res.status === 404) {
      return { configured: false, reason: '桶没有配置生命周期规则（NoSuchLifecycleConfiguration）', rules: [] };
    }
    if (res.status === 403) {
      return {
        configured: null,
        reason: '无法验证：当前 API 令牌只有对象读写权限，不含桶配置读取权限（需要 Admin 级令牌才能查）',
        rules: [],
      };
    }
    if (!res.ok) {
      return { configured: null, reason: `查询失败 HTTP ${res.status}`, rules: [] };
    }
    const xml = await res.text();
    const rules = pickAll(xml, 'Rule').map((block) => ({
      id: decodeXml(pick(block, 'ID')),
      status: pick(block, 'Status'),
      prefix: decodeXml(pick(block, 'Prefix') || pick(block, 'Filter')),
      days: pick(block, 'Days'),
      action: /<Expiration>/.test(block)
        ? /<Days>/.test(pick(block, 'Expiration'))
          ? 'Delete after Days'
          : 'Expiration(other)'
        : /<AbortIncompleteMultipartUpload>/.test(block)
          ? 'AbortIncompleteMultipartUpload'
          : 'other',
    }));
    return { configured: rules.length > 0, reason: '', rules };
  } catch (err) {
    return { configured: false, reason: `查询异常 ${err.message}`, rules: [] };
  }
}

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : 1)} ${units[i]}`;
}

function beijingTime(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

// 纯文本报告（企微 text 消息，单条上限 2048 字节，注意中文占 3 字节）
function buildWecomText(report) {
  const lines = [];
  lines.push('Cloudflare R2 空间占用');
  lines.push(beijingTime(report.checkedAt));
  lines.push('');
  lines.push(`桶：${report.bucket}`);
  lines.push(`对象总数：${report.objectCount} 个`);
  lines.push(`已用空间：${report.totalHuman}`);
  lines.push(`免费额度：10 GB`);
  lines.push(`已用比例：${report.usedPercent}`);
  lines.push(`剩余可用：${report.remainingHuman}`);
  lines.push('');
  lines.push('分类明细');
  lines.push(`聊天附件：${report.byPrefix.chat.count} 个，${report.byPrefix.chat.human}`);
  lines.push(`独立分享：${report.byPrefix.share.count} 个，${report.byPrefix.share.human}`);
  if (report.byPrefix.other.count) {
    lines.push(`其他对象：${report.byPrefix.other.count} 个，${report.byPrefix.other.human}`);
  }
  lines.push('');
  lines.push('到期情况');
  lines.push(`7 天内创建：${report.ageBuckets.within7d} 个，到期自动清理`);
  lines.push(`超过 7 天：${report.ageBuckets.over7d} 个`);

  const warns = [];
  if (report.ageBuckets.over7d > 0) {
    warns.push('存在超期未清理对象，请检查生命周期规则');
  }
  if (report.lifecycle && report.lifecycle.configured === false) {
    warns.push('桶未配置生命周期规则，文件不会自动过期删除');
  }
  if (Number(report.usedPercent.replace('%', '')) >= 80) {
    warns.push('已用空间超过免费额度的 80%，注意清理');
  }
  if (warns.length) {
    lines.push('');
    lines.push('注意');
    for (const w of warns) lines.push(`· ${w}`);
  }

  return lines.join('\n');
}

// 机器人 webhook 解析：多个来源按优先级取第一个非空值，方便换群/换机器人而不用改代码
function resolveWebhook() {
  // 1) 完整 URL（兼容非企微的转发服务）
  const directUrl = String(process.env.WECOM_WEBHOOK_URL || '').trim();
  if (directUrl) return { url: directUrl, source: 'WECOM_WEBHOOK_URL' };

  // 2) 只给 key
  const key = String(process.env.WECOM_WEBHOOK_KEY || process.env.QW_WEBHOOK || '').trim();
  if (key) {
    return {
      url: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`,
      source: 'WECOM_WEBHOOK_KEY',
    };
  }

  // 3) 回落：复用本机 auto-checkin 技能里已配置的同一个群机器人
  try {
    const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'skills', 'workbuddy-auto-checkin', 'config.json');
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const k = String(cfg.qw_webhook || '').trim();
      if (k) {
        return {
          url: `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(k)}`,
          source: 'auto-checkin/config.json',
        };
      }
    }
  } catch (_) {
    /* 静默回落 */
  }

  return { url: '', source: '' };
}

async function pushWecom(text) {
  const { url, source } = resolveWebhook();
  if (!url) {
    console.error('未配置企微推送：请在 .env.local 里设置 WECOM_WEBHOOK_KEY=<机器人key> 或 WECOM_WEBHOOK_URL=<完整地址>');
    return false;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.errcode === 0) {
    console.log(`企微推送: ok（来源 ${source}）`);
    return true;
  }
  console.error('企微推送失败:', JSON.stringify(body));
  return false;
}

(async () => {
  try {
    const { objects, pages } = await listAll();

    const total = objects.reduce((sum, o) => sum + o.size, 0);
    const groups = { c: { count: 0, bytes: 0 }, s: { count: 0, bytes: 0 }, other: { count: 0, bytes: 0 } };
    for (const o of objects) {
      const head = o.key.split('/')[0];
      const g = groups[head] || groups.other;
      g.count += 1;
      g.bytes += o.size;
    }

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // 估算「7 天内会被清理掉」的部分（按最后修改时间）
    let expiring = 0;
    let expired = 0;
    for (const o of objects) {
      const t = Date.parse(o.lastModified);
      if (!Number.isFinite(t)) continue;
      const age = now - t;
      if (age >= 7 * day) expired += 1;
      else expiring += 1;
    }

    const sorted = objects.slice().sort((a, b) => b.size - a.size);
    const FREE_BYTES = 10 * 1024 * 1024 * 1024;

    const report = {
      bucket: BUCKET,
      publicBase: process.env.R2_PUBLIC_BASE || '',
      checkedAt: new Date().toISOString(),
      pages,
      objectCount: objects.length,
      totalBytes: total,
      totalHuman: human(total),
      freeQuotaBytes: FREE_BYTES,
      usedPercent: ((total / FREE_BYTES) * 100).toFixed(2) + '%',
      remainingBytes: Math.max(0, FREE_BYTES - total),
      remainingHuman: human(Math.max(0, FREE_BYTES - total)),
      byPrefix: {
        chat: { count: groups.c.count, bytes: groups.c.bytes, human: human(groups.c.bytes) },
        share: { count: groups.s.count, bytes: groups.s.bytes, human: human(groups.s.bytes) },
        other: { count: groups.other.count, bytes: groups.other.bytes, human: human(groups.other.bytes) },
      },
      ageBuckets: {
        within7d: expiring,
        over7d: expired,
      },
      top5: sorted.slice(0, 5).map((o) => ({
        key: o.key,
        size: human(o.size),
        bytes: o.size,
        lastModified: o.lastModified,
      })),
    };

    report.lifecycle = await checkLifecycle();

    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log('R2 桶占用统计');
    console.log('--------------------------------------------');
    console.log(`桶          : ${report.bucket}`);
    console.log(`检查时间    : ${report.checkedAt}`);
    console.log(`对象总数    : ${report.objectCount} 个`);
    console.log(`总占用      : ${report.totalHuman} (${total} 字节)`);
    console.log(`免费额度    : 10 GB`);
    console.log(`已用比例    : ${report.usedPercent}`);
    console.log(`剩余可用    : ${report.remainingHuman}`);
    console.log('--------------------------------------------');
    console.log(`聊天附件 c/ : ${report.byPrefix.chat.count} 个, ${report.byPrefix.chat.human}`);
    console.log(`独立分享 s/ : ${report.byPrefix.share.count} 个, ${report.byPrefix.share.human}`);
    if (report.byPrefix.other.count) {
      console.log(`其他        : ${report.byPrefix.other.count} 个, ${report.byPrefix.other.human}`);
    }
    console.log('--------------------------------------------');
    console.log(`7 天内创建  : ${report.ageBuckets.within7d} 个（应被生命周期自动清理）`);
    console.log(`超过 7 天   : ${report.ageBuckets.over7d} 个（若 >0 说明生命周期规则未生效）`);
    if (report.top5.length) {
      console.log('--------------------------------------------');
      console.log('最大的 5 个对象:');
      for (const o of report.top5) console.log(`  ${o.size.padStart(10)}  ${o.key}`);
    }

    console.log('--------------------------------------------');
    if (report.lifecycle.configured === true) {
      console.log('生命周期规则: 已配置');
      for (const r of report.lifecycle.rules) {
        console.log(`  · ${r.id || '(无名)'} [${r.status}] 前缀="${r.prefix}" ${r.days ? r.days + ' 天' : ''} ${r.action}`);
      }
    } else if (report.lifecycle.configured === false) {
      console.log(`生命周期规则: 未生效 — ${report.lifecycle.reason}`);
    } else {
      console.log(`生命周期规则: ${report.lifecycle.reason}`);
    }

    if (process.argv.includes('--preview')) {
      console.log('');
      console.log('---- 推送内容预览 ----');
      console.log(buildWecomText(report));
      console.log('---- 预览结束 ----');
    }

    if (process.argv.includes('--push')) {
      await pushWecom(buildWecomText(report));
    }
  } catch (err) {
    console.error('统计失败:', err.message);
    process.exit(1);
  }
})();
