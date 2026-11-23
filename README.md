# Atoms Demo

输入一句话，生成一个可操作的单页网页应用。登录后，DeepSeek 将需求拆成可执行的验收用例，生成独立 HTML。Chromium 实际操作页面并返回检查结果。你可以在工作台迭代、切换版本，并将通过验收的版本发布到固定链接。

[在线 Demo](http://113.45.177.72:3000/) · [3 分钟评审路径](docs/project-guide.md#02-3-分钟评审路径) · [项目说明](docs/project-guide.md) · [项目进度](ROADMAP.md)

| 试用成品 | 可以验证 |
| --- | --- |
| [窗帘预算计算器](http://113.45.177.72:3000/apps/curtain-budget) | 输入窗宽 3 米、褶皱倍数 2、每米 100 元，得出 600 元。可保存、加载和删除计算方案。 |
| [2048小游戏](http://113.45.177.72:3000/apps/merge-grid) | 用方向键、WASD、屏幕按钮或滑动操作 4×4 棋盘，刷新后保留最高分。支持[下载 HTML](http://113.45.177.72:3000/apps/merge-grid/download)离线试玩。 |
| [秒表](http://113.45.177.72:3000/apps/stopwatch) | 验证开始、暂停、继续和归零。 |

## 快速开始（本地）

### Docker Compose

在当前终端设置 `POSTGRES_PASSWORD`，然后启动应用和 PostgreSQL 16。

```bash
docker compose up -d --build --wait
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。应用启动时检查并保存三个试用成品。仅配置数据库时，可以登录后用内置模板生成计算器、数字合成游戏和秒表。

### Node.js

需要 Node.js 24 或以上版本，以及可访问的 PostgreSQL 16 数据库。先设置 `DATABASE_URL`，再运行下列命令。

```bash
npm ci
HOST=127.0.0.1 npm start
```

### 启用 DeepSeek

在已设置 `POSTGRES_PASSWORD` 的终端中，静默输入模型 Key，并启用 `agent` profile 同时启动浏览器验收服务。

```bash
printf 'DeepSeek API Key: '
IFS= read -rs DEEPSEEK_API_KEY
printf '\n'
if [ -n "$DEEPSEEK_API_KEY" ]; then
  export DEEPSEEK_API_KEY
  docker compose --profile agent up -d --build --wait
  unset DEEPSEEK_API_KEY
fi
```

默认模型为 `deepseek-flash`。可以用「做一个每周习惯打卡网页，支持点击打卡和取消，刷新后保留记录」体验自由生成。[DeepSeek API 文档](https://api-docs.deepseek.com/)

### 端到端验证

设置 `TEST_DATABASE_URL` 指向专用 PostgreSQL 测试库。每条集成用例会创建独立的测试 schema。

```bash
npm test
```

完整回归还需要将 `TEST_QA_SOCKET` 指向浏览器验收服务的 Unix socket，并将 `TEST_CHROME` 指向本机 Chrome 可执行文件。测试用模拟服务替代模型上游，产物交互由真实 Chromium 执行。[验收证据与复现命令](docs/project-guide.md#7-质量证据与复现)

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `POSTGRES_PASSWORD` | Compose 必填的数据库密码，由当前终端或部署平台提供。 |
| `DATABASE_URL` | 手动启动 Node.js 时使用的连接 URL。也可通过 `PGHOST`、`PGUSER`、`PGDATABASE`、`PGPASSWORD` 配置。 |
| `HOST` / `PORT` | Node.js HTTP 监听地址和端口，默认为 `0.0.0.0` 和 `3000`。 |
| `APP_BIND_ADDRESS` / `APP_PORT` | Compose 对宿主机暴露的地址和端口，默认为 `127.0.0.1` 和 `3000`。 |
| `PUBLIC_ORIGIN` | 对外访问的完整 origin，用于请求来源校验。配置 HTTPS origin 时启用 Secure Cookie。 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` | 启用自由生成的服务端 Key 和模型名。 |
| `QA_SOCKET_PATH` / `QA_CHROMIUM_PATH` | 浏览器验收服务的 socket 和 Chromium 可执行文件路径，由 Compose 预设。 |

## 功能与实现

| 功能 | 工作方式 |
| --- | --- |
| 试用与模板 | 游客可打开试用成品，也可在「模板」中选用提示词。首次发起生成时，工作台保留需求并提示登录或注册。 |
| 生成工作台 | 展示需求规划、代码生成、测试、验收和完成五个阶段，可取消生成、切换桌面和手机预览、查看自动测试及 HTML 源码。 |
| 自动验收 | DeepSeek 先写用例，独立 Chromium 服务再执行点击、输入、刷新及结果断言。用户在「自动测试」查看通过、失败、未完成及浏览器日志。 |
| 版本与发布 | 每次保存产生独立版本。通过验收后在发布面板手动发布、更新或下线。更新发布沿用原分享链接。 |
| 账号项目与记录 | 「我的项目」按作品汇总版本和发布状态，展示最新版本的验收通过率。支持保存记录的应用可在同一账号的不同设备恢复记录。 |

## 验收与发布规则

- DeepSeek 产物须通过浏览器运行检查与全部声明式用例。出现明确失败时，尝试修复一次并运行同一批用例。最终未通过的版本保留为私有草稿。
- 发布链接使用 `/s/:slug`。选中新版本并更新发布后，访客访问同一链接即可打开新版。下线后，分享页返回 HTTP 410。
- 可在「版本历史」打开旧版。旧版通过验收时，可以重新发布该版本。作者纳入发布管理后，旧的 `/apps/:id` 分享入口也受发布状态控制。

## 部署（Docker Compose）

部署拓扑由 Node.js 应用、PostgreSQL 16 和可选的 Chromium 验收容器组成。数据库数据存放在 `postgres_data` 命名卷，验收服务只通过共享卷里的 Unix socket 接收任务。生产环境的模型 Key 和数据库密码由宿主机或部署平台注入。

公网评审实例使用 HTTP 和 `3000` 端口。直接暴露时设置 `APP_BIND_ADDRESS=0.0.0.0`，并按需设置 `APP_PORT`。通过 HTTPS 反向代理部署时，配置 `PUBLIC_ORIGIN` 为外部访问地址，并向应用传递原请求的 Host。

## 目录

```text
public/           首页、模板、项目目录、工作台和分享页脚本
src/              HTTP 服务、账号、存储、生成和浏览器验收
deploy/           Chromium 容器配置及 seccomp 许可
test/             项目集成测试和真实浏览器回归
docs/             项目说明和评审路径
ROADMAP.md        部署版本、进度及验证记录
```

## 已知边界

- 自由生成面向能在浏览器离线运行的单页应用。依赖外部 API、实时协作或业务后端的需求超出当前范围。
- 自动验收覆盖用例声明的行为，默认在桌面视口运行。移动端布局及触屏体验需要单独复测。
- 无 DeepSeek Key 时可使用内置生成模式。已配置 DeepSeek 时，模型或浏览器验收故障会显示错误或保留未通过草稿。
