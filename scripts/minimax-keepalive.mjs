// 每日 MiniMax 音色保活：每天至少合成并发送一条语音。
// 这是独立于 bridge 的运维任务，bridge/DSH 重启时也能补跑；同一本地日期幂等一次。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesize, voiceTtsConfig, removeQuietly } from '../src/voice-tts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(ROOT, 'state');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(STATE_DIR, 'minimax-keepalive.json');
const LOG_FILE = path.join(STATE_DIR, 'minimax-keepalive.log');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function appendLog(line) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8'); } catch {}
}

function localDateKey(at = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function normalizeKeepalive(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const target = String(value.targetKey ?? '').trim();
  const text = String(value.text ?? '今日も元気だよ').trim() || '今日も元気だよ';
  const mood = String(value.mood ?? 'calm').trim() || 'calm';
  const attempts = Math.min(5, Math.max(1, Math.trunc(Number(value.attempts) || 3)));
  return {
    enabled: value.enabled === true,
    targetKey: /^(private|group):\d+$/.test(target) ? target : '',
    text: text.slice(0, 80),
    mood,
    attempts,
    verify: value.verify !== false
  };
}

function targetFromConfig(config, keepalive) {
  const raw = keepalive.targetKey || String(config.dailyBrief?.key ?? '').trim() || (config.ownerQQ ? `private:${config.ownerQQ}` : '');
  const match = /^(private|group):(\d+)$/.exec(raw);
  if (!match || Number(match[2]) <= 0) throw new Error('MINIMAX_KEEPALIVE_TARGET_INVALID');
  return { key: raw, kind: match[1], id: Number(match[2]) };
}

function endpoint(config) {
  const httpUrl = String(config.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const accessToken = String(config.snowluma?.accessToken ?? '').trim();
  return { httpUrl, accessToken };
}

async function onebotSendVoice(config, target, filePath) {
  const { httpUrl, accessToken } = endpoint(config);
  const action = target.kind === 'private' ? 'send_private_msg' : 'send_group_msg';
  const params = target.kind === 'private'
    ? { user_id: target.id, message: [{ type: 'record', data: { file: filePath } }] }
    : { group_id: target.id, message: [{ type: 'record', data: { file: filePath } }] };
  const response = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(90000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status !== 'ok' || body.retcode !== 0) throw new Error(`ONEBOT_SEND_FAILED:${body.wording || body.retcode || response.status}`);
  return body.data?.message_id ?? null;
}

async function verifyVoice(config, messageId) {
  if (messageId == null) return null;
  const { httpUrl, accessToken } = endpoint(config);
  try {
    const response = await fetch(`${httpUrl}/get_msg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ message_id: Number(messageId) }),
      signal: AbortSignal.timeout(30000)
    });
    const body = await response.json().catch(() => ({}));
    const segments = Array.isArray(body.data?.message) ? body.data.message : [];
    return response.ok && body.status === 'ok' && body.retcode === 0 && segments.some((segment) => segment?.type === 'record');
  } catch { return false; }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');
  const dry = args.has('--dry');
  const config = readJson(CONFIG_FILE, {});
  const keepalive = normalizeKeepalive(config.minimaxKeepalive ?? config.voiceTts?.keepalive);
  const tts = voiceTtsConfig(config);
  const today = localDateKey();
  const state = readJson(STATE_FILE, {}) || {};
  if (!keepalive.enabled) { console.log('skip: minimaxKeepalive.enabled=false'); appendLog('skip: disabled'); return 0; }
  if (tts.engine !== 'minimax' || !tts.enabled) { console.error('fail: MiniMax TTS 未启用'); appendLog('fail: minimax tts disabled'); return 2; }
  const target = targetFromConfig(config, keepalive);
  if (dry) {
    const plan = { date: today, target: target.key, mood: keepalive.mood, text: keepalive.text, engine: tts.engine, voice: tts.minimax.voice, attempts: keepalive.attempts };
    console.log(JSON.stringify(plan, null, 2));
    appendLog(`dry target=${target.key} mood=${keepalive.mood}`);
    return 0;
  }
  if (!force && state.lastSentDate === today) { console.log(`skip: already sent (${today})`); appendLog(`skip: already sent (${today})`); return 0; }

  let lastError = null;
  for (let attempt = 1; attempt <= keepalive.attempts; attempt += 1) {
    let synth = null;
    try {
      synth = await synthesize(keepalive.text, keepalive.mood, config);
      const messageId = await onebotSendVoice(config, target, synth.filePath);
      const verified = keepalive.verify ? await verifyVoice(config, messageId) : null;
      const next = { lastSentDate: today, lastSentAt: new Date().toISOString(), target: target.key, messageId, verified, attempts: attempt, mood: synth.mood, voice: synth.voice, seconds: synth.seconds };
      writeJson(STATE_FILE, next);
      appendLog(`sent date=${today} target=${target.key} message_id=${messageId ?? '?'} verified=${verified === true} attempts=${attempt}`);
      console.log(`sent: ${today} target=${target.key} message_id=${messageId ?? '?'}`);
      return 0;
    } catch (error) {
      lastError = String(error?.message ?? error);
      appendLog(`attempt ${attempt}/${keepalive.attempts} failed: ${lastError}`);
      if (attempt < keepalive.attempts) await new Promise((resolve) => setTimeout(resolve, 5000));
    } finally {
      if (synth?.filePath) removeQuietly(synth.filePath);
    }
  }
  writeJson(STATE_FILE, { ...state, lastSendError: { at: new Date().toISOString(), date: today, error: lastError } });
  console.error(`fail: ${lastError}`);
  return 2;
}

main().then((code) => process.exit(code)).catch((error) => { appendLog(`crash: ${error?.stack ?? error}`); console.error(error?.message ?? error); process.exit(2); });
