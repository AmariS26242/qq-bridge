// CSV 小工具：盲评表里有跨行的引号字段（多行回复），不能按 \n 粗暴切。
// 只处理本目录需要的最小集合：双引号包裹、"" 转义、字段内换行、行尾 CRLF。

/** 把整份 CSV 文本拆成二维数组（含表头行）。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text ?? '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0].trim() === ''));
}

/** 把 CSV 文本转成对象数组，首行为表头。 */
export function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cells) => {
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i] ?? ''; });
    return o;
  });
}

/** 写一行 CSV（字段按需加引号）。 */
export function csvLine(cells) {
  return cells.map((c) => {
    const s = String(c ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}
