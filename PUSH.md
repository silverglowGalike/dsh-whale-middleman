# PUSH — 把 dsh-whale-middleman 推上 GitHub

本目录（`UEGC\tools\gh-release\dsh-whale-middleman\`）已经是一个完整的本地 git 仓库：
**1 个初始 commit、没有 remote、没有推送**。审查过文件清单后，按下面三行走即可。

## 1. 建远端空仓库

在 GitHub 新建一个**空仓库**（不要勾 README / .gitignore / LICENSE，否则第一次 push 会撞车）：

```
owner/dsh-whale-middleman
```

## 2. 加 remote 并推送

```sh
cd UEGC/tools/gh-release/dsh-whale-middleman
git remote add origin https://github.com/<你的账号>/dsh-whale-middleman.git
git push -u origin main
```

> 文档里（`package.json` 的 `repository` / `homepage`、`README.md`、`USAGE.md`）已经把仓库地址写成
> `https://github.com/silverglowGalike/dsh-whale-middleman`。**如果 `<你的账号>` 不是 `silverglowGalike`**，推送前先把这四处的
> `silverglowGalike` 一起替换掉，否则 GitHub 上的链接和安装命令都会指向别人的仓库。

## 3. 可选：发布到 npm

```sh
npm login                      # 先确认已登录
npm publish --access public    # 包名 dsh-whale-middleman 若已被占用会失败，改 package.json 的 name 再发
```

发布前检查：包内不能有凭据。本次打出的 tgz 已核对过清单，见下。

---

## 仓库文件清单（21 个，已 commit）

| 路径 | 说明 |
|---|---|
| `.gitignore` | `node_modules/`、`*.tgz`、`*.tmp`、`.DS_Store` |
| `LICENSE` | MIT |
| `README.md` | 为什么这么做（设计原理、四道闸门、与 ask-matt 技能的关系） |
| `USAGE.md` | 第一次用什么顺序读：装、触发、卡片、模型选择、排错 |
| `cordis.patch.yml` | bundle 层：一行宿主半区（浏览器半区由 `dsh.client` 声明） |
| `docs/DETAIL.md` | 插件长描述：是什么、13 个工具、批准只发生在会话里、回传信封协议、安装步骤 |
| `docs/preview.svg` | 详情页配图（640×300，无文字，自包含） |
| `icon.svg` | 侧边栏图标 |
| `lib/*.js` | 11 个运行时文件（`index` / `client` / `tools` / `core` / `routes` / `dispatch` / `observer` / `ledger` / `card-model` / `refusals` / `verifyscan`） |
| `PUSH.md` | 本文件：推送与发布命令、文件清单、包校验值 |
| `package.json` | 版本 0.2.0；`files` 只含 `lib`、`cordis.patch.yml`、`icon.svg`、`docs`、`README.md`、`USAGE.md` |

`dsh-whale-middleman-0.2.0.tgz` 在仓库根目录但**被 .gitignore 忽略**，不会进 commit。

## 已打好的包

| 项 | 值 |
|---|---|
| 文件 | `dsh-whale-middleman-0.2.0.tgz` |
| 大小 | 95,172 字节（93.1 KiB） |
| sha256 | `4f8a69123cb5074b01f0a125d20c47b0bbcffe22bce5d43486a31e6d3ce86865` |
| 包内条目 | 19 个文件（均在 `package/` 下）：11 个 `lib/*.js` + `package.json` + `cordis.patch.yml` + `icon.svg` + `docs/DETAIL.md` + `docs/preview.svg` + `README.md` + `USAGE.md` + `LICENSE` |

安装这个 tgz：

```sh
tar -xzf dsh-whale-middleman-0.2.0.tgz          # 得到 package/
```

然后打开 DSH → 侧边栏「插件」→「安装」→ 选 `package/` 目录（根下有 `cordis.patch.yml`），
启用后**完全退出 DSH 再打开**。或者用插件管理器：

```js
plugin_manager({ action: "install_bundle", target: "<package 目录的绝对路径>" })
```

## 已知缺口（推之前可自行决定补不补）

- `README.md` / `USAGE.md` 写的一键安装 `install.sh` **不在本发布副本里**（开发副本里也没有）。推上去
  这条 `curl | sh` 会 404；想保留这条路径就补一个 `install.sh`，否则改用应用内安装。
- `README.md` 第 21 行引用 `AUDIT.md`（31 个坑的审计记录）——该文件在开发副本里也不存在，链接会 404。
- `USAGE.md` 的 `npm test`、`package.json` 的 `scripts.test` / `scripts.check` 指向 `test/` 与
  `scripts/`，这两个目录按发布清单没有复制，因此本地 `npm test` 会失败（不影响安装与运行，也不在
  `files` 白名单里）。

## 边界

- 没有执行 `git push`，没有执行 `npm publish`。
- 没有改动 `~/.dsh` 下任何文件。
- git 身份只设在本仓库：`user.name=dsh-whale-middleman`、`user.email=dsh-whale-middleman@users.noreply.local`，全局身份未动。
