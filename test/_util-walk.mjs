/**
 * 测试用的小工具：递归列出仓库里的文件（跳过 .git 与 node_modules）。
 *
 * 单独成文件是为了让多个测试共用，而不用各自实现一份递归。
 */

import fsp from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "preview", "_research", ".wbwe-state"]);

/** 递归列出 `root` 下的所有普通文件（绝对路径）。 */
export async function globFiles(root, { skipDirs = SKIP_DIRS, maxFiles = 20000 } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return out;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}
