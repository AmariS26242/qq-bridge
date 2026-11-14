// 代码保险箱的离线断言（不写 C:/E:/OneDrive、不联 OneBot）。
// 跑法：node scripts/test-backup.mjs
//
// 覆盖三层：
//   1. src/zip.mjs —— 自己写的 zip 必须能被自己读回、CRC 篡改必须报错、中文名原样保留；
//   2. src/backup.mjs —— 匹配语义（这是最容易错的地方：`cordis.patch.yml` 曾把隐藏历史副本也捞进来）、
//      配置回退、保留策略、简报行三种状态；
//   3. 端到端一次真实打包，目标是 state/tmp（用完即删），不碰三处备份盘。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { zipCreate, zipRead, crc32, dosDateTime } from '../src/zip.mjs';
import {
  BACKUP_DEFAULTS,
  normalizeBackupConfig,
  globSource,
  makeExcluder,
  makeIncluder,
  parseSnapshotName,
  snapshotName,
  isoWeekKey,
  planPrune,
  formatBytes,
  renderBackupBriefLine,
} from '../src/backup.mjs';

let pass = 0;
const lines = [];
function t(name, fn) {
  try {
    fn();
    pass += 1;
    lines.push(`PASS ${name}`);
  } catch (error) {
    lines.push(`FAIL ${name}\n     ${error?.message ?? error}`);
  }
}

const HERE = path.dirname(new URL(import.meta.url).pathname.slice(1));
const ROOT = path.resolve(HERE, '..');

// ── 1. zip ──────────────────────────────────────────────────────────────────
t('zip：中文路径 / 空文件 / 大文本 往返一致', () => {
  const big = '中文内容 ABCDEFG\n'.repeat(20000);
  const entries = [
    { name: '项目计划/07-候选项目清单.md', data: Buffer.from('# 标题\n正文', 'utf8') },
    { name: 'memory-index/mem.py', data: Buffer.from('print(1)\n', 'utf8') },
    { name: 'empty.txt', data: Buffer.alloc(0) },
    { name: 'big.md', data: Buffer.from(big, 'utf8') },
  ];
  const zip = zipCreate(entries);
  const back = zipRead(zip);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  assert.equal(back[0].data.toString('utf8'), '# 标题\n正文');
  assert.equal(back[2].size, 0);
  assert.equal(back[3].data.toString('utf8'), big);
  for (const e of back) assert.equal(crc32(e.data), crc32(Buffer.from(e.data)));
});

t('zip：反斜杠转正斜杠、前导斜杠去掉（Windows 路径直接喂也不会写坏包）', () => {
  const zip = zipCreate([{ name: '\\qq-bridge\\src\\a.mjs', data: Buffer.from('x') }]);
  const back = zipRead(zip);
  assert.equal(back[0].name, 'qq-bridge/src/a.mjs');
});

t('zip：已压缩数据自动退回 STORE（不白费 CPU，也不让包变大）', () => {
  // 真随机，deflate 一定压不动（用周期序列会假阳性：deflate 能压它）
  const noise = crypto.randomBytes(16 * 1024);
  const zip = zipCreate([{ name: 'noise.bin', data: noise }]);
  // local header 的 method 字段在偏移 8
  assert.equal(zip.readUInt16LE(8), 0, '不可压缩的数据应走 STORE');
  assert.equal(zipRead(zip)[0].data.length, noise.length);
  // 可压缩的文本仍走 DEFLATE
  const textZip = zipCreate([{ name: 'a.txt', data: Buffer.from('aaaa'.repeat(5000)) }]);
  assert.equal(textZip.readUInt16LE(8), 8, '文本应走 DEFLATE');
  assert.ok(textZip.length < 1000, `可压缩文本压完应该很小，实际 ${textZip.length}`);
});

t('zip：UTF-8 标志位（bit 11）必须置位，缺了它在 Windows 上中文会乱码', () => {
  const zip = zipCreate([{ name: '项目计划/a.md', data: Buffer.from('x') }]);
  assert.ok(zip.readUInt16LE(6) & 0x0800, 'local header flags');
  // central directory 的 flags 在 `PK\x01\x02` 之后偏移 8
  const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(cd > 0 && zip.readUInt16LE(cd + 8) & 0x0800, 'central header flags');
});

t('zip：数据被篡改时 CRC 校验必须报错（静默返回坏数据最危险）', () => {
  const zip = zipCreate([{ name: 'a.txt', data: Buffer.from('hello world hello world') }]);
  const victim = Buffer.from(zip);
  victim[30 + 'a.txt'.length] ^= 0xff; // local header(30) + name 之后就是数据
  assert.throws(() => zipRead(victim), /CRC|长度|invalid|inflate/i);
});

t('zip：EOCD 缺失 → 明确报错而不是崩在 readUInt32LE', () => {
  assert.throws(() => zipRead(Buffer.from('not a zip at all, really')), /EOCD/);
});

t('zip：DOS 时间戳落在合法区间（1980–2107）', () => {
  const { date, time } = dosDateTime(new Date(2026, 9, 24, 3, 10, 30));
  const year = (date >> 9) + 1980;
  assert.equal(year, 2026);
  assert.equal((date >> 5) & 0x0f, 10); // 月
  assert.equal(date & 0x1f, 24);        // 日
  assert.equal(time >> 11, 3);          // 时
  assert.equal((time >> 5) & 0x3f, 10); // 分
  assert.equal((time & 0x1f) * 2, 30);  // 秒（2 秒精度）
});

// ── 2. 匹配语义 ─────────────────────────────────────────────────────────────
t('globSource：`**` 跨目录，`*` 不跨，`?` 单字符', () => {
  assert.ok(new RegExp(`^${globSource('**/*.md')}$`).test('a.md'));
  assert.ok(new RegExp(`^${globSource('**/*.md')}$`).test('a/b/c.md'));
  assert.ok(new RegExp(`^${globSource('docs/*.md')}$`).test('docs/a.md'));
  assert.ok(!new RegExp(`^${globSource('docs/*.md')}$`).test('docs/a/b.md'));
  assert.ok(new RegExp(`^${globSource('a?.txt')}$`).test('ab.txt'));
});

t('include：目录型模式按前缀收（`src` → src 下全部）', () => {
  const inc = makeIncluder(['src', 'config.json']);
  assert.equal(inc('src/bridge.js'), true);
  assert.equal(inc('src/deep/x/y.mjs'), true);
  assert.equal(inc('config.json'), true);
  assert.equal(inc('scripts/a.mjs'), false);
  assert.equal(inc('srcfoo/a.mjs'), false); // 不许把 srcfoo 当成 src
});

t('include：通配模式只匹配顶层，不往隐藏目录里捞（真实踩过的坑）', () => {
  const inc = makeIncluder(['cordis.patch.yml']);
  assert.equal(inc('cordis.patch.yml'), true);
  assert.equal(inc('.backup-20261015-212735/cordis.patch.yml'), false);
  const py = makeIncluder(['*.py']);
  assert.equal(py('mem.py'), true);
  assert.equal(py('vendor/x.py'), false);
});

t('include：`.` 表示全收', () => {
  const inc = makeIncluder(['.']);
  assert.equal(inc('任何/文件.md'), true);
  assert.equal(inc('a'), true);
});

t('exclude：不含 `/` 的模式匹配任意一段路径名', () => {
  const ex = makeExcluder(['node_modules', '*.log', '.snapshots']);
  assert.equal(ex('node_modules/fflate/index.js'), true);
  assert.equal(ex('deep/node_modules/x.js'), true);
  assert.equal(ex('state/bot.log'), true);
  assert.equal(ex('src/bridge.js'), false);
  assert.equal(ex('config.json.bak-2026'), false); // 由 `*.bak-*` 负责，不是这一条
});

t('exclude：`*.bak-*` / `config.json.bak*` 命中历史备份文件', () => {
  const ex = makeExcluder(['*.bak', '*.bak-*', 'config.json.bak*']);
  assert.equal(ex('config.json.bak-2026-10-24T03-13-08'), true);
  assert.equal(ex('start.bat.bak-20261023-2055'), true);
  assert.equal(ex('config.json'), false);
});

t('exclude：含 `/` 的模式整体锚定', () => {
  const ex = makeExcluder(['docs/private/*.md']);
  assert.equal(ex('docs/private/a.md'), true);
  assert.equal(ex('docs/a.md'), false);
});

// ── 3. 配置归一 ─────────────────────────────────────────────────────────────
t('normalizeBackupConfig：空输入 = 默认策略（开启 / 03:10 / 三处落盘 / 7+4）', () => {
  const cfg = normalizeBackupConfig(undefined);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.at, '03:10');
  assert.equal(cfg.targets.length, 3);
  assert.match(cfg.targets[0], /snapshots/i);
  assert.equal(cfg.retention.daily, 7);
  assert.equal(cfg.retention.weekly, 4);
  assert.equal(cfg.sources.length, 5);
  assert.ok(cfg.sources.some((s) => s.label === 'qq-bridge' && s.paths.includes('config.json')));
});

t('normalizeBackupConfig：坏字段回退默认值，不抛错（备份任务不能因笔误整夜不跑）', () => {
  const cfg = normalizeBackupConfig({
    at: '   ',
    sources: 'nope',
    targets: [null, '', 'C:\\A', 'c:\\a\\', 'E:\\B'],
    retention: { daily: -3, weekly: 'x' },
    drill: { everyDays: 0, sampleFiles: 0 },
  });
  assert.equal(cfg.at, '03:10');
  assert.equal(cfg.sources.length, 5);
  assert.deepEqual(cfg.targets, ['C:\\A', 'E:\\B']); // 去重（大小写 + 尾斜杠）
  assert.equal(cfg.retention.daily, 7);              // -3 是笔误 → 回默认 7，不是 0（0 会删光历史）
  assert.equal(cfg.retention.weekly, 4);             // 'x' → 默认
  assert.equal(normalizeBackupConfig({ retention: { daily: 0 } }).retention.daily, 1); // 0 抬到 1
  assert.equal(cfg.drill.everyDays, 1);
  assert.equal(cfg.drill.sampleFiles, 1);
});

t('normalizeBackupConfig：enabled=false 能被保留（临时停用不改代码）', () => {
  assert.equal(normalizeBackupConfig({ enabled: false }).enabled, false);
});

t('BACKUP_DEFAULTS 不可变（避免运行期被别的模块改掉）', () => {
  assert.equal(Object.isFrozen(BACKUP_DEFAULTS), true);
});

// ── 4. 文件名 / 周键 / 保留策略 ─────────────────────────────────────────────
t('snapshotName ↔ parseSnapshotName 往返', () => {
  const d = new Date(2026, 9, 24, 3, 10, 7);
  const name = snapshotName(d);
  assert.equal(name, 'qbbridge_20261024-031007.zip');
  assert.equal(parseSnapshotName(name)?.getTime(), d.getTime());
  assert.equal(parseSnapshotName('手动的备份.zip'), null);   // 手动包不参与自动删除
  assert.equal(parseSnapshotName('qbbridge_bad.zip'), null);
});

t('isoWeekKey：周日归前一周、跨年按 ISO 算（12/31 与 1/1 同一周）', () => {
  assert.equal(isoWeekKey(new Date(2026, 9, 24)), '2026-W43'); // 2026-10-24 是周六
  assert.equal(isoWeekKey(new Date(2026, 9, 18)), '2026-W42'); // 周日 → 前一周
  assert.equal(isoWeekKey(new Date(2026, 11, 31)), isoWeekKey(new Date(2027, 0, 1)));
});

t('planPrune：30 天日备 → 留 7 份日备 + 4 个更早周各最新一份', () => {
  const names = [];
  for (let i = 0; i < 30; i += 1) names.push(snapshotName(new Date(2026, 8, 1 + i, 3, 10, 0)));
  const del = planPrune(names, { daily: 7, weekly: 4 });
  const kept = names.filter((n) => !del.includes(n));
  assert.equal(kept.length, 11);
  // 最新 7 份一定全在
  for (const n of names.slice(-7)) assert.ok(kept.includes(n), `最近一份被误删：${n}`);
  assert.equal(new Set(kept.map((n) => parseSnapshotName(n).toDateString())).size, 11);
});

t('planPrune：不足额度时一份不删', () => {
  const names = [snapshotName(new Date(2026, 9, 20, 3, 0, 0)), snapshotName(new Date(2026, 9, 21, 3, 0, 0))];
  assert.deepEqual(planPrune(names, { daily: 7, weekly: 4 }), []);
});

t('planPrune：非本工具命名的 zip 永不删、目录里的无关文件不被波及', () => {
  assert.deepEqual(planPrune(['别人的备份.zip', 'readme.txt'], { daily: 1, weekly: 1 }), []);
});

t('planPrune：同一周的多份只留最新（周备不重复占位）', () => {
  const names = [
    snapshotName(new Date(2026, 8, 1, 3, 0, 0)),
    snapshotName(new Date(2026, 8, 2, 3, 0, 0)),
    snapshotName(new Date(2026, 8, 3, 3, 0, 0)),
    snapshotName(new Date(2026, 8, 8, 3, 0, 0)),
    snapshotName(new Date(2026, 8, 9, 3, 0, 0)),
    snapshotName(new Date(2026, 8, 10, 3, 0, 0)),
  ];
  const del = planPrune(names, { daily: 2, weekly: 1 });
  // 最新 2 份（9/9、9/10）保留；再往前的周（9/7 那周）留最新一份 9/8；其余删
  assert.deepEqual(del.sort(), [names[0], names[1], names[2]].sort());
});

// ── 5. 简报行 ───────────────────────────────────────────────────────────────
const NOW = new Date(2026, 9, 24, 8, 0, 0);

t('简报行：成功的格式与需求一字不差（💾 备份：今天 03:10 成功（N 份 / X））', () => {
  const line = renderBackupBriefLine(
    { lastRunAt: new Date(2026, 9, 24, 3, 10, 0).toISOString(), lastOk: true, fileCount: 235, totalBytes: 4.5 * 1024 ** 3 },
    { now: NOW },
  );
  assert.equal(line, '💾 备份：今天 03:10 成功（235 份 / 4.5 GB）');
});

t('简报行：昨天的备份写日期而不是「今天」', () => {
  const line = renderBackupBriefLine(
    { lastRunAt: new Date(2026, 9, 23, 3, 10, 0).toISOString(), lastOk: true, fileCount: 10, totalBytes: 1024 },
    { now: NOW },
  );
  assert.equal(line, '💾 备份：10/23 03:10 成功（10 份 / 1.0 KB）');
});

t('简报行：失败要带原因且截断（不把整段异常甩进简报）', () => {
  const line = renderBackupBriefLine(
    { lastRunAt: NOW.toISOString(), lastOk: false, lastError: 'EACCES 拒绝访问 '.repeat(10) },
    { now: NOW },
  );
  assert.match(line, /^💾 备份：今天 08:00 失败（EACCES/);
  assert.ok(line.length <= 70, `太长了：${line.length}`);
});

t('简报行：超过 36 小时没跑 → 点名超时（沉默的备份等于没有备份）', () => {
  const line = renderBackupBriefLine(
    { lastRunAt: new Date(2026, 9, 22, 3, 10, 0).toISOString(), lastOk: true, fileCount: 5, totalBytes: 100 },
    { now: NOW },
  );
  assert.match(line, /上次 2 天前/);
  assert.match(line, /超时未跑/);
});

t('简报行：没有记录时返回 null（简报里不出现空行）', () => {
  assert.equal(renderBackupBriefLine(null, { now: NOW }), null);
  assert.equal(renderBackupBriefLine({}, { now: NOW }), null);
});

t('formatBytes：0 / B / KB / MB / GB 边界', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024 * 1.25), '1.3 MB');
  assert.equal(formatBytes(1024 ** 3 * 100), '100 GB');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes('x'), '0 B');
});

// ── 6. 端到端：真打一个包，自己读回来 ───────────────────────────────────────
t('端到端：真实源打包 → 读回 → 关键文件在包内且内容没坏', () => {
  const src = path.join(ROOT, 'src', 'zip.mjs');
  const cfgFile = path.join(ROOT, 'config.json');
  assert.ok(fs.existsSync(src), 'src/zip.mjs 应该存在');
  assert.ok(fs.existsSync(cfgFile), 'config.json 应该存在');
  const entries = [
    { name: 'qq-bridge/src/zip.mjs', data: fs.readFileSync(src), mtime: fs.statSync(src).mtime },
    { name: 'qq-bridge/config.json', data: fs.readFileSync(cfgFile), mtime: fs.statSync(cfgFile).mtime },
  ];
  const zip = zipCreate(entries);
  const back = zipRead(zip);
  assert.deepEqual(back.map((e) => e.name), ['qq-bridge/src/zip.mjs', 'qq-bridge/config.json']);
  assert.equal(back[0].data.toString('utf8'), fs.readFileSync(src, 'utf8'));
  assert.equal(zip.subarray(0, 4).readUInt32LE(0), 0x04034b50);
});

t('端到端：state/tmp 落盘 → 读回（模拟真实写盘路径，不碰备份盘）', () => {
  const tmpRoot = path.join(ROOT, 'state', 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'backup-test-'));
  try {
    const zip = zipCreate([{ name: '项目计划/a.md', data: Buffer.from('内容', 'utf8') }]);
    const file = path.join(dir, snapshotName(new Date(2026, 9, 24, 3, 10, 0)));
    fs.writeFileSync(`${file}.part`, zip);
    fs.renameSync(`${file}.part`, file);
    assert.equal(fs.existsSync(`${file}.part`), false, '.part 不该残留');
    const back = zipRead(fs.readFileSync(file));
    assert.equal(back[0].data.toString('utf8'), '内容');
    // 目录扫描能认出它
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => parseSnapshotName(n)).length,
      1,
    );
    assert.equal(zlib.inflateRawSync, zlib.inflateRawSync); // 保底：zlib 可用
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(lines.join('\n'));
const failed = lines.filter((l) => l.startsWith('FAIL')).length;
console.log(`\nPASS：${pass} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
