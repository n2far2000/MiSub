#!/usr/bin/env node
/**
 * 幂等补丁器（MiSub fork 专用）
 *
 * 背景：MiSub 是上游 imzyb/MiSub 的 fork，每天自动同步。本地改动以
 *       patches/*.patch 的形式保存，每次同步后从「干净的上游树」重新应用，
 *       而不是作为 commit 长期保留 —— 那样上游一改同一行就会产生 merge 冲突。
 *
 * 判定顺序：
 *   1. git apply --reverse --check 成功 → 已应用，跳过
 *   2. git apply --check 成功         → 应用
 *   3. 两者都失败                      → 冲突，exit 1（流水线红，不推送，线上保持旧版）
 *
 * 换行归一化：patch 文件在 Windows 上可能被 checkout 成 CRLF（.gitattributes
 *             只对 *.js/*.yml 等强制 eol=lf），直接 apply 会失败。这里统一
 *             转成 LF 写到临时文件再应用，保证跨平台一致。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PATCH_DIR = 'patches';
const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', ...opts });
const gitQuiet = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const canApply = (p) => { try { gitQuiet(['apply', '--check', p]); return true; } catch { return false; } };
const alreadyApplied = (p) => { try { gitQuiet(['apply', '--reverse', '--check', p]); return true; } catch { return false; } };

if (!existsSync(PATCH_DIR)) {
  console.log(`[patches] 没有 ${PATCH_DIR}/ 目录，跳过`);
  process.exit(0);
}

const files = readdirSync(PATCH_DIR).filter((f) => f.endsWith('.patch')).sort();
if (files.length === 0) {
  console.log(`[patches] ${PATCH_DIR}/ 为空，跳过`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), 'misub-patch-'));
let applied = 0, skipped = 0;
const conflicts = [];

try {
  for (const name of files) {
    const normalized = readFileSync(join(PATCH_DIR, name), 'utf8').replace(/\r\n/g, '\n');
    const dst = join(tmp, name);
    writeFileSync(dst, normalized, 'utf8');

    if (alreadyApplied(dst)) {
      console.log(`[patches] 跳过（已应用） ${name}`);
      skipped++;
      continue;
    }
    if (canApply(dst)) {
      git(['apply', '--index', dst]);
      console.log(`[patches] 已应用 ${name}`);
      applied++;
      continue;
    }
    console.error(`[patches] 冲突 ${name}`);
    conflicts.push(name);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`[patches] 汇总：applied=${applied} skipped=${skipped} conflicts=${conflicts.length} total=${files.length}`);

if (conflicts.length > 0) {
  console.error(`[patches] 以下补丁无法应用，需人工更新补丁内容：\n  - ${conflicts.join('\n  - ')}`);
  process.exit(1);
}
