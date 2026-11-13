# 这是生产运行时仓（不是预演）

> 目录名 `dsh-022-pretest` 是 2026-09 升级演练期留下的历史命名，**实际是 9 号机 DSH 的唯一现役运行时仓**。
> 目录名有误导性，但请勿再新建 "pretest" 副本或迁移此目录；历史预演仓已于 2026-11-13 按用户授权删除。

## 它是什么

- **运行方式**：`dsh-web.service` 以 tsx 源码模式直接运行本仓 `apps/cli/src/bin.ts`（`node --import tsx/esm`），**改这里的源码 = 直接改生产**，无需构建。
- **dsh 版本**：0.2.2（上游 tag `dsh-v0.1.1-rc.2` 之后的本地适配线，含 LAN 围栏、guard 放开、agent-presets 重建等本地改动）。
- **端口**：3080（dsh web 主入口）、3081（dsh-pocket LAN 桥）。

## 2026-11-13 的 git 重建说明

本仓原是已删除老仓 `~/deepseek-harness` 的 git worktree（`.git` 为指针文件，指向老仓 `.git/worktrees/`）。老仓删除后 git 元数据失效，已重建：

- 历史基线：`origin/feature/lan-access` = `7f5954c212`（0.1.5 线）
- 现役快照：`466932e93a` = "baseline: DSH 0.2.2 运行态快照"（21102 文件，含全部本地改动）
- 远端备份：`origin/backup/dsh-022-baseline-20261113`
- **注意**：2026-09~11 期间的老仓本地 commit 记录已随老仓删除永久丢失（代码内容全在基线快照内，仅缺变更履历）

## 依赖约定（重要）

`dsh-web.service` 的 `ExecStartPre=pnpm install` 已于 2026-11-13 移除（09-09 事故的加剧因素）。

- **本仓 `node_modules/` 不会自动更新**，需依赖时手动执行：
  ```
  cd /home/dingx/dsh-022-pretest && CI=true pnpm install --no-frozen-lockfile
  ```
- 源码模式下改 `packages/**` 下的插件代码后，通常需要 `pnpm build`（否则插件 import 失败），或确认该插件走 tsx 直读。

## 其它约定

- guard 策略清单（主 agent 可改写范围）在 `/home/dingx/DSF-work/docs/主agent可改写文件清单.yaml`，本仓 `.git/` 已在该清单黑名单内。
- 活配置（settings.yaml / .credentials.yaml / dsh.env / agent-presets）在 `/home/dingx/.dsh/`，**不在本仓**。
