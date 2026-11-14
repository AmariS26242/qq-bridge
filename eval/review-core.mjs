// B1 人工评审的纯逻辑：解析评审包 CSV → 收集两栏分数 → 导出提交用 CSV。
// 与 eval/review.html 里的内联实现是同一套规则（页面不能 import 模块，file:// 会被 CORS 拦），
// scripts/test-eval-review-page.mjs 比对两边输出是否一致，防止改一边忘另一边。
//
// 数据约定：一条评审包 = 两栏（side1 / side2），每栏五维各 1–5 分；
// 导出为「每栏一行」的扁平 CSV（30 条 → 60 行），与 eval/check-review.mjs、eval/aggregate.mjs 对齐。

export const DIMS = ['natural', 'faithful', 'harm', 'template', 'stable'];

/** 最小 CSV 解析：支持双引号包裹、"" 转义、字段内换行、CRLF。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

export function parseCsvObjects(text) {
  const all = parseCsv(text);
  const head = all[0] || [];
  const rest = all.slice(1);
  const keys = head.map((k) => k.trim());
  return rest.map((r) => {
    const obj = {};
    keys.forEach((k, i) => { obj[k] = r[i] ?? ''; });
    return obj;
  });
}

/** 评审包里必须有的列（两栏正文；评分列由页面生成）。 */
export const PACK_REQUIRED = ['id', 'situation', 'incoming', 'side1', 'side2'];

export function packRows(text) {
  const rows = parseCsvObjects(text);
  const head = rows.length ? Object.keys(rows[0]) : [];
  const missing = PACK_REQUIRED.filter((k) => !head.includes(k));
  if (missing.length) throw new Error(`评审包缺列：${missing.join(', ')}`);
  return rows;
}

const isScore = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;

/**
 * answers 形如：{ c01: { pick: 1, s1: {natural:4,...}, s2: {...}, note: '' } }
 * 返回每栏一行；某栏五维不齐则跳过该栏（不导出半行，让 check-review 报「缺整行」）。
 * 有值但越界 → 直接抛错（这是录入手误，不该静默丢）。
 */
export function scoreRows(pack, answers, reviewer) {
  const out = [];
  for (const row of pack) {
    const a = answers[row.id] || {};
    for (const side of [1, 2]) {
      const s = (side === 1 ? a.s1 : a.s2) || {};
      const present = DIMS.filter((d) => s[d] !== undefined && s[d] !== null && s[d] !== '');
      if (!present.length) continue;
      const bad = DIMS.filter((d) => present.includes(d) && !isScore(Number(s[d])));
      if (bad.length) throw new Error(`${row.id} 第 ${side} 栏分数越界或非整数：${bad.join(', ')}`);
      if (present.length < DIMS.length) continue; // 未打完，等补
      const item = { reviewer, id: row.id, side };
      for (const d of DIMS) item[d] = Number(s[d]);
      item.note = a.note ?? '';
      out.push(item);
    }
  }
  return out;
}

const escCell = (v) => {
  let s = String(v ?? '');
  // 表格软件会把 =/+/-/@ 开头的单元格当公式执行：加一个前导单引号让它保持文本。
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  // \r 也要进引号分支：只有 \n 时，带 \r 的备注会把整行拆坏。
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function serializeScores(rows) {
  const head = ['reviewer', 'id', 'side', ...DIMS, 'note'];
  const lines = [head.join(',')];
  for (const r of rows) lines.push(head.map((k) => escCell(r[k])).join(','));
  return lines.join('\n');
}

/** 进度：按「栏」计（60 格），顺带给出还缺哪些条。 */
export function progress(pack, answers) {
  const missing = [];
  let sidesDone = 0;
  for (const row of pack) {
    const a = answers[row.id] || {};
    const s1 = DIMS.every((d) => isScore(Number(a.s1 && a.s1[d]))) && a.s1;
    const s2 = DIMS.every((d) => isScore(Number(a.s2 && a.s2[d]))) && a.s2;
    if (s1) sidesDone += 1;
    if (s2) sidesDone += 1;
    if (!s1 || !s2) missing.push(row.id);
  }
  return { done: sidesDone, total: pack.length * 2, missing };
}
