// D3 接线测试：人格卡影子覆盖（role.overrideFile）只决定「读哪份文件」，不改注入逻辑。
//
// 测两件事：
//   1. 纯函数 resolveRoleFile 的路径裁决 —— 默认回落 roles/<名称>.md，覆盖值必须落在项目内；
//   2. bridge.js 真的把它接进了 roleRawContent（否则函数再对也不生效）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRoleFile } from '../src/role-card.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = path.join(ROOT, 'roles');
const SLIM = 'eval/d3/小鲸鱼.slim.md';

let passed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    return;
  }
  failures.push(`${name}${extra ? `（${extra}）` : ''}`);
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}

// —— 1. 默认路径：没有覆盖值时按老规则读 roles/<名称>.md ——
eq('默认读 roles/<名称>.md', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼' }), path.join(ROLES, '小鲸鱼.md'));
eq('overrideFile 空串等同未配置', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼', overrideFile: '   ' }), path.join(ROLES, '小鲸鱼.md'));

// —— 2. 合法覆盖：项目内的 .md 相对路径 ——
eq('合法覆盖解析成项目内绝对路径', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼', overrideFile: SLIM }), path.join(ROOT, 'eval', 'd3', '小鲸鱼.slim.md'));
ok('候选稿文件真的存在', fs.existsSync(path.join(ROOT, 'eval', 'd3', '小鲸鱼.slim.md')));
eq('.txt 也允许', resolveRoleFile({ rolesDir: ROLES, name: 'x', overrideFile: 'eval/d3/note.txt' }), path.join(ROOT, 'eval', 'd3', 'note.txt'));
eq('扩展名大小写不敏感', resolveRoleFile({ rolesDir: ROLES, name: 'x', overrideFile: 'eval/d3/NOTE.MD' }), path.join(ROOT, 'eval', 'd3', 'NOTE.MD'));
eq('正斜杠反斜杠都接受', resolveRoleFile({ rolesDir: ROLES, name: 'x', overrideFile: 'eval\\d3\\a.md' }), path.join(ROOT, 'eval', 'd3', 'a.md'));

// —— 3. 拒绝：任何越界、任何可能读错文件的值都返回空串 ——
eq('绝对路径拒绝', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼', overrideFile: 'C:\\Windows\\win.ini' }), '');
eq('drive-relative 拒绝', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼', overrideFile: '/etc/passwd' }), '');
eq('.. 穿越拒绝', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼', overrideFile: '../../secret.md' }), '');
eq('项目内 .. 但不越界也拒绝（收紧到项目根之外即拒）', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼', overrideFile: '..\\..\\x.md' }), '');
eq('node_modules 拒绝', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼', overrideFile: 'node_modules/pkg/x.md' }), '');
eq('.git 拒绝', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼', overrideFile: '.git/config.md' }), '');
eq('非 md/txt 扩展名拒绝', resolveRoleFile({ rolesDir: ROLES, name: '小鲸鱼', overrideFile: 'eval/d3/card.json' }), '');
eq('角色名含 .. 拒绝', resolveRoleFile({ rolesDir: ROLES, name: '..\\evil' }), '');
eq('角色名含分隔符拒绝', resolveRoleFile({ rolesDir: ROLES, name: 'a/b' }), '');
eq('空角色名拒绝', resolveRoleFile({ rolesDir: ROLES, name: '' }), '');
eq('空 rolesDir 拒绝', resolveRoleFile({ rolesDir: '', name: '小鲸鱼' }), '');

// —— 4. 接线检查：bridge.js 里 roleRawContent 必须真的调用它 ——
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
ok('bridge.js import 了 resolveRoleFile', /from '\.\/role-card\.js'/.test(bridge) && /resolveRoleFile/.test(bridge));
ok('roleRawContent 用 resolveRoleFile 决定文件', /const roleFile = resolveRoleFile\(\{[\s\S]{0,160}?overrideFile: cfg\.role\?\.overrideFile/.test(bridge));
ok('cfg.role 默认值含 overrideFile 空串', /overrideFile: ''/.test(bridge));
ok('覆盖值会被 trim 归一化', /cfg\.role\.overrideFile = typeof cfg\.role\.overrideFile === 'string'/.test(bridge));
ok('缓存 key 带解析后的绝对路径', /const cacheKey = `\$\{safeName\}:\$\{resolved\}/.test(bridge));

// —— 汇总 ——
if (failures.length) {
  for (const message of failures) console.log(`✗ ${message}`);
  console.log(`\n${passed} passed / ${failures.length} failed`);
  process.exit(1);
}
console.log(`${passed} passed / 0 failed`);
