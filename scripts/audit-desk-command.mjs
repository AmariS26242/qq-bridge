#!/usr/bin/env node
/**
 * 桌面命令静态审核器。
 *
 * 用途：QQ 端把「命令」发到桌面端之前/之后，先跑一遍确定性审核，判断这条命令可能
 * 对**桌面 agent（DSH 会话本身）**或**电脑环境**造成什么影响。
 *
 * 设计原则：
 * - 纯规则、无模型、无网络、可复现：同一条命令永远得到同一个结论，便于事后对账。
 * - 结论只有三档：low（可直接执行）/ review（可执行但必须报告命中的风险点）/
 *   high（禁止自动执行，必须先经桌面端人工确认）。
 * - 宁可按 high 处理：这是「减少误伤」的闸门，不是精确的沙箱。
 *
 * 导出 auditCommand(text) 供 desk-command.mjs / MCP 工具复用；也可单独 CLI 调用：
 *   node audit-desk-command.mjs "命令文本"
 */
import { pathToFileURL } from 'node:url';

/** 每条：id / severity / label / re / note。severity 直接累加成风险分。 */
const RULES = [
  // ── 影响我自己（DSH 本体、配置、会话、凭据）──────────────────────────────
  { id: 'dsh-home', sev: 90, label: '触碰 DSH 自身：配置/会话/凭据/profile', re: /(\.dsh\b|profiles[\\/]|sessions[\\/]|cordis\.(ya?ml|patch)|credentials|\.env\b|state[\\/]console-token|taskledger)/i, note: '可能改到 DSH 的配置、会话记录或凭据，会直接影响桌面端这个 agent 的行为与身份。' },
  { id: 'agent-preset', sev: 80, label: '改 agent 预设/人格/工具白名单', re: /(agent-preset|agentPresets|persona|system.?prompt|tool-restrict|mcp-snowluma|bridge\.js|qqbot\.mjs)/i, note: '改的是「我自己怎么工作」的设定：prompt、工具清单、桥接逻辑。' },
  { id: 'self-kill', sev: 95, label: '停/杀自身进程或服务', re: /(Stop-Process|taskkill|kill\b|sc\s+(stop|delete)|Stop-Service|schtasks\s+\/delete|Restart-Computer|shutdown)/i, note: '会中断桌面端/QQ 机器人/桥接的进程，可能让会话或机器人直接掉线。' },

  // ── 破坏性文件操作 ────────────────────────────────────────────────────
  { id: 'rm-rf', sev: 70, label: '递归删除/格式化', re: /(rm\s+-rf|Remove-Item[^\n]*(-Recurse|-Force)|Remove-Item[^\n]*-LiteralPath|del\s+\/[sfq]|rd\s+\/s|rmdir\s+\/s|format\s+[a-z]:|diskpart|Clear-Disk)/i, note: '不可恢复的删除/格式化，务必先确认路径是目标路径。' },
  { id: 'rm-cn', sev: 50, label: '删除文件（自然语言）', re: /(删除|删掉|清空|抹掉|移除文件)/i, note: '删除是不可恢复的，先确认删的是哪一个文件。' },
  { id: 'system-path', sev: 85, label: '写系统目录/注册表/服务', re: /(C:\\+Windows\\+|Program Files|System32|reg\s+(add|delete)|HKLM|HKEY_LOCAL_MACHINE|New-Service|sc\s+create|Register-ScheduledTask|schtasks\s+\/create)/i, note: '改系统级配置，影响面超出当前用户和当前项目。' },
  { id: 'autostart', sev: 60, label: '开机自启/计划任务/看门狗', re: /(autostart|startup|watchdog|看门狗|Run\\+|Startup 文件夹|开机自启)/i, note: '会留下长期生效的后台行为，事后不易清理。' },

  // ── 凭据与隐私外发 ────────────────────────────────────────────────────
  { id: 'secret-read', sev: 85, label: '读取密钥/口令/凭据', re: /(accessToken|api[_-]?key|password|passwd|口令|密钥|cookie|id_rsa|\.pem\b|\.key\b)/i, note: '涉及凭据读取；不得把它们贴进聊天或日志。' },
  { id: 'net-egress', sev: 40, label: '发网络请求/上传', re: /(curl|Invoke-WebRequest|Invoke-RestMethod|iwr\b|wget|ftp\b|scp\b|ssh\b|nc\s|HttpClient|axios|fetch\(|上传|外发|贴到|pastebin|gist\.github)/i, note: '有数据外发可能；注意上传内容与目标地址。' },
  { id: 'remote-exec', sev: 88, label: '下载即执行 / 动态求值', re: /(Invoke-Expression|\biex\b|\|\s*(bash|sh|powershell|pwsh)\b|curl[^\n]*\|\s*(sh|bash)|iwr[^\n]*\|\s*iex)/i, note: '把远端内容直接当代码执行，等于把控制权交出去。' },
  { id: 'pkg-install', sev: 35, label: '安装/升级依赖或系统包', re: /(pip\s+install|npm\s+(i|install|add)\b|pnpm\s+add|yarn\s+add|winget|choco\s+install|scoop\s+install|apt(-get)?\s+install)/i, note: '改环境依赖，可能连带升级/替换已有组件。' },

  // ── 中风险：可回滚但需知情 ─────────────────────────────────────────────
  { id: 'write-workspace', sev: 15, label: '写工作区文件', re: /(Set-Content|Out-File|>\s*[A-Za-z]:\\|New-Item|Move-Item|Copy-Item|Rename-Item|mkdir|touch\s|新建|创建|写入|写到|存到|保存到|另存|裁成|改成|改一下|重命名|移动到|复制到)/i, note: '在工作区产生/改写文件；确认文件名与路径。' },
  { id: 'firewall-net', sev: 40, label: '改防火墙/端口/网络配置', re: /(netsh\s+(adv)?firewall|New-NetFirewallRule|netsh\s+int|ipconfig\s+\/release|route\s+(add|delete))/i, note: '改网络可达性，可能影响远程访问或让本机失联。' },
  { id: 'gpu-model', sev: 45, label: '占用 GPU / 跑本地模型 / 生图', re: /(ComfyUI|diffusers|torch|cuda|stable.?diffusion|seedream|生图|出图|生成一张|生成个|画一张|跑模型)/i, note: '会长时间占用显存/CPU，期间其它任务会明显变慢。' },
  { id: 'qq-send', sev: 40, label: '以机器人身份对外发消息', re: /(qq_send|send_message|sendSticker|sendVoice|发到手机|send_to_phone|发到[^\n]{0,8}(QQ|qq)|我的\s*QQ|发给[^\n]{0,6}(好友|群|某人))/i, note: '消息一旦发出不可撤回，注意对象与内容。' },

  // ── 只读类：明确降噪（命中也不加分，仅用于判定「纯只读」）───────────────
];

const READONLY_HINT = /(^\s*(Get-|dir\b|ls\b|cat\b|type\b|head\b|tail\b|Select-String|findstr|where\b|git\s+(status|log|diff|show)|python\s+-c\s+["']print|node\s+-e\s+["']console\.log)|\b(List|Show|Read|Query|Check|Count|统计|查一下|看看|列一下|读一下)\b)/i;

/** 危险路径：即使只是「写」，落在这些位置也要升级。 */
const SENSITIVE_PATHS = /(桌面|Documents|Downloads|下载|Desktop|AppData|Tencent Files|\.ssh|\.git[\\/]config)/i;

/**
 * 审核一条命令文本。
 * @param {string} text 命令原文（可以是自然语言，也可以是 shell）
 * @returns {{verdict:'low'|'review'|'high', score:number, hits:Array, readonly:boolean, advice:string, summary:string}}
 */
export function auditCommand(text) {
  const raw = String(text ?? '');
  const t = raw.trim();
  const hits = [];
  let score = 0;

  if (!t) {
    return { verdict: 'high', score: 100, hits: [{ id: 'empty', sev: 100, label: '命令为空', note: '空命令没有意义，拒绝投递。' }], readonly: false, advice: '命令为空，已拒绝。', summary: '空命令' };
  }
  if (t.length > 4000) {
    hits.push({ id: 'too-long', sev: 60, label: `命令过长（${t.length} 字符）`, note: '过长的命令通常是把整段脚本塞进来，人工复核成本高。' });
    score += 60;
  }

  for (const rule of RULES) {
    const m = t.match(rule.re);
    if (!m) continue;
    hits.push({ id: rule.id, sev: rule.sev, label: rule.label, match: m[0], note: rule.note });
    score += rule.sev;
  }

  // 敏感路径 + 写/删操作 = 升级
  if (SENSITIVE_PATHS.test(t) && hits.some((h) => h.id === 'write-workspace' || h.id === 'rm-rf' || h.id === 'rm-cn')) {
    hits.push({ id: 'sensitive-path', sev: 50, label: '写/删敏感目录（桌面、下载、AppData、SSH、git 配置）', note: '这些位置常含个人资料或凭据。' });
    score += 50;
  }

  const readonly = READONLY_HINT.test(t) && !hits.some((h) => h.sev >= 45);

  // 判档（刻意让 high 只由真正危险的单项触发，而不是中等项累加）：
  //   high   = 任一命中项 sev >= 85，或风险分 >= 120（多个中等项叠加到那一步）
  //   review = 风险分 >= 40
  //   low    = 其余（纯只读不再降噪，因为只读本身就不加分）
  const maxSev = hits.reduce((m, h) => Math.max(m, h.sev), 0);
  let verdict = 'low';
  if (maxSev >= 85 || score >= 120) verdict = 'high';
  else if (score >= 40) verdict = 'review';

  const top = hits.slice().sort((a, b) => b.sev - a.sev).slice(0, 3);
  const summary = hits.length === 0
    ? '未命中风险规则（默认低风险）'
    : top.map((h) => h.label).join('；') + (hits.length > 3 ? `；等 ${hits.length} 项` : '');

  const advice = verdict === 'high'
    ? '禁止自动执行：先向桌面端用户确认「是否允许」，得到明确同意后再动。'
    : verdict === 'review'
      ? '可以执行，但执行前后都要把命中的风险点讲清楚，并把结果回报给管理员。'
      : '低风险，可直接执行。';

  return { verdict, score, hits, readonly, advice, summary };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const text = process.argv.slice(2).join(' ');
  process.stdout.write(JSON.stringify(auditCommand(text), null, 2) + '\n');
}
