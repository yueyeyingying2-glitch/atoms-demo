# Atoms Demo

[在线 Demo](http://113.45.177.72:3000/)

输入自然语言生成可操作的网页应用。DeepSeek 先列出需求和验收用例，再写出独立 HTML。工作台用 Chromium 操作产物，展示每项的实际结果。登录后可生成和迭代应用。验收通过后可发布、下线和下载对应版本，注册账号可跨设备恢复版本与工具记录。

## 本地启动

使用 Docker Compose 时，在当前终端设置 `POSTGRES_PASSWORD` 后启动应用与 PostgreSQL 16。

```bash
docker compose up -d --build --wait
```

也可使用 Node.js 24、npm 和独立 PostgreSQL 数据库。先设置 `DATABASE_URL` 为该数据库的连接 URL。

```bash
npm ci
HOST=127.0.0.1 npm start
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。未设置 DeepSeek Key 时，匹配的内置模板标为「演示模式」。服务器首次启动时会检查并保存三个示例。

## 启用 DeepSeek

在已设置 `POSTGRES_PASSWORD` 的终端中，通过静默输入读取 Key 并启动浏览器验收服务。

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

Key 由应用服务读取，默认调用 `deepseek-flash`。部署时使用主机或平台的密钥配置。配置 Key 后同时启用 `agent` Compose profile。浏览器服务通过 Unix socket 接收验收任务，无外部网络和模型或数据库凭据。[DeepSeek API 文档](https://api-docs.deepseek.com/)

体验自由生成时，可以试「做一个房贷提前还款计算器，保存计算方案并在刷新后恢复」或「做一个每周习惯打卡网页，支持点击打卡和取消」。生成完成后，在工作台继续输入修改要求，或者返回首页发起新项目。

设置 `TEST_DATABASE_URL` 指向独立的 PostgreSQL 测试数据库，再运行 `npm test`。测试为每条用例创建独立 schema。要测试 DeepSeek 生成链，再设置 `TEST_QA_SOCKET` 指向浏览器验收服务。测试以本地模拟服务替代 DeepSeek 上游，产物交互由真实 Chromium 执行。可设置 `TEST_CHROME` 为本机 Chrome 可执行路径以同时验证工作台界面。

在本机运行浏览器服务时，使用 `QA_SOCKET_PATH` 指定短路径，使用 `QA_CHROMIUM_PATH` 指定已安装的 Chrome 可执行文件，然后运行 `node src/qa-worker.js`。

## 评审操作

| 输入或操作 | 预期 |
|---|---|
| 游客点击生成 | 弹出登录或注册窗口，并保留输入的需求。登录成功后继续本次生成。 |
| 注册 | 输入用户名和至少 8 字符的密码，按提示点击验证码图片中的图案。 |
| 退出后登录 | 只输入用户名和密码，工作台可找回该账号的历史。 |
| 做一个窗帘预算计算器，输入窗宽、褶皱倍数和每米价格，输出预算 | 输入 3、2、100 得到 600 元。保存方案后刷新，仍可加载或删除。用同一账号换浏览器登录后，也能看到记录。 |
| 做一个 2048 小游戏，简单说明游戏规则 | 打开原创 4×4 数字合成游戏。支持方向键、WASD、触摸及屏幕按钮，最高分刷新后保留。 |
| 做一个秒表 | 打开产物链接，依次操作开始、暂停、继续和归零。 |
| 给刚才这个秒表增加计次功能，保留现有操作 | 在「版本历史」可查看两版。发布新版后，同一个分享链接会指向新版。 |
| 发布和下线 | 打开发布面板，确认发布并复制链接。用无痕或手机窗口验证可操作，点「下线」后刷新显示已下线。 |

工作台按「需求规划 → 代码生成 → 测试 → 验收 → 完成」展示状态。可以取消进行中的生成，并在「版本历史」中查看已保存版本。验收失败时 DeepSeek 会尝试修正一次。复验失败的版本留作私有草稿。

新版应用通过验收后，可在发布面板发布到固定链接。更新发布将固定链接指向当前版本，下线关闭访客入口。已有旧版公开链接在作者纳入发布管理前继续可用。登录后的使用记录保存在当前账号，访客预览及匿名使用的记录各自保存在浏览器里。

## 导出2048小游戏

从首页打开「2048小游戏」，或下载 `/apps/merge-grid/download` 返回的完整 HTML 文件。双击文件即可游玩。需要独立分享时，将文件命名为 `index.html` 并上传到静态网页托管，使用托管服务返回的公开地址。在工作台发布生成作品时，可直接复制发布面板中的公网链接。

## 实现与取舍

- Node.js 提供注册、登录、生成和分享路由。PostgreSQL 16 保存账号、会话、版本、验收结果、发布状态和账号工具记录。
- DeepSeek 生成自包含的 HTML、CSS 和 JavaScript。工作台支持桌面与手机预览、验收记录和查看源代码。生成页面支持离线运行，适合浏览器内可以完成的任务。
- 浏览器服务以声明式用例操作控件和断言结果。超时记录为「未完成」。生成代码在单独的 Chromium 容器及受限的浏览器 iframe 里执行。
- iframe 使用受限的本地存储接口。工作台和登录后的发布页通过账号同步工具记录，访客视图使用独立的浏览器存储。
- 演示样例使用内置运行时代码和原有回归检查。登录使用 scrypt 密码哈希和一次性图像选择验证码。

## 部署与 GitHub

GitHub 提供代码仓库。Compose 在容器内网连接 PostgreSQL，数据库数据保存在 `postgres_data` 命名卷。应用端口默认绑定回环地址。评审实例使用公网 IP 和端口，在 Compose 启动时设置 `APP_BIND_ADDRESS=0.0.0.0` 和 `APP_PORT=3000`。

| 运行环境变量 | 用途 |
|---|---|
| `PORT` | HTTP 端口，默认 `3000`。 |
| `HOST` | 监听地址，容器默认 `0.0.0.0`。 |
| `DATABASE_URL` | 手动启动 Node 时使用 PostgreSQL 连接 URL。也可使用标准 `PGHOST`、`PGUSER`、`PGDATABASE`、`PGPASSWORD` 配置。 |
| `POSTGRES_PASSWORD` | Compose 读取的数据库密码，从终端环境或部署平台密钥配置传入。 |
| `PUBLIC_ORIGIN` | 客户端访问的完整 origin，用于校验请求源。HTTPS 下设置 Secure Cookie。 |
| `DEEPSEEK_API_KEY` | DeepSeek 服务端 Key。 |
| `DEEPSEEK_MODEL` | 模型名，默认 `deepseek-flash`。 |
| `QA_SOCKET_PATH` | 浏览器验收服务 Unix socket 路径，Compose 自动设置。 |

通过 HTTPS 反向代理部署时，向应用传递客户端请求的 Host。提交前用国内手机流量和无痕窗口分别检查首页、账号流程及三个分享链接，确认服务重启后生成记录仍能恢复。

`deploy/chromium-seccomp.json` 来自 [Playwright v1.65.1](https://github.com/microsoft/playwright/blob/v1.65.1/utils/docker/seccomp_profile.json)，采用其仓库的 Apache-2.0 许可。该配置允许 Chromium 在用户命名空间中为 zygote 执行 chroot，浏览器容器仍保留全部外层能力丢弃。
