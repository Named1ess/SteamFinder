# SteamFinder

基于 TypeScript 的 Steam 好友关系探索工具：按层采集好友、持久化缓存、交互关系图、共同好友和最短连接路径。前端、API、采集 Worker、数据库全部通过 Docker Compose 运行。

## 启动

需要 Docker Desktop（Linux containers）或 Docker Engine + Compose。无需本机安装 Node.js、PostgreSQL 或 Redis。

```sh
docker compose up --build -d
```

打开 <http://localhost:8080>。默认是**演示模式**：页面中的昵称和关系为虚构数据，使用相同的数据库和后台任务流程，不调用 Steam。点击页面上的演示按钮开始探索。

## 连接真实 Steam 数据

1. 将 `.env.example` 复制为 `.env`。
2. 从 <https://steamcommunity.com/dev/apikey> 获取自己的 Steam Web API Key。
3. 在 `.env` 中设置：

```dotenv
STEAM_MODE=live
STEAM_API_KEY=你的密钥
```

4. 应用配置：

```sh
docker compose up -d --force-recreate api worker
```

输入 `76561199521553744`、`https://steamcommunity.com/profiles/76561199521553744/`，或 `/id/自定义名字` 形式的完整 Steam 主页地址。API Key 仅由后端使用，不进入前端构建和 Git。演示数据与真实数据分开存储。

## 使用和数据语义

- 默认 2 层、最多 1000 个节点、500 次请求，可调整至最多 3 层、10000 个节点及10000次请求。
- 显示上限独立于采集上限；小范围画面不代表数据库只有这些数据。
- 打开历史记录、刷新浏览器、切换筛选条件只读取数据库。只有新建任务、显式刷新或继续采集会触发采集。
- 任务在后台执行，关闭浏览器不会取消任务。达到预算后可以增加预算并继续；可取消正在进行的任务。
- 好友不可见、请求失败、尚未展开分别标识；未知不等于没有好友。
- 共同好友、路径、社群和排行均基于本次已采集的图。没有找到路径不代表 Steam 上一定不存在路径；深度边界和隐私设置可能造成缺失。
- 点击刷新会重新查询允许范围内的数据；刷新失败保留之前成功的数据和时间戳。
- 好友关系并非树，重复出现的 SteamID 会合并。SteamID 始终以字符串传输。

## 服务

| 服务 | 职责 |
| --- | --- |
| web | Nginx 静态前端和 `/api` 反向代理，默认端口8080 |
| api | Fastify 查询接口、任务管理、SSE进度 |
| worker | pg-boss 持久任务队列、限速和分层采集 |
| db | PostgreSQL 16，数据存入命名卷 |
| migrate | 每次启动检查并初始化数据库，成功退出后 API 才启动 |

技术栈：React / Vite / Tailwind / shadcn 风格自有组件 / TanStack Query / G6 / ECharts / Fastify / Drizzle / PostgreSQL / pg-boss / Graphology。

```sh
docker compose ps
docker compose logs -f api worker
docker compose stop
docker compose start
docker compose down
```

`stop`、`start` 和普通 `down` 保留数据库。**`docker compose down -v` 会删除数据库卷及所有已采集数据。**

默认只监听本机 `127.0.0.1:8080`。本版面向个人使用，尚未提供登录和多人权限；需要公网部署时，应先在反向代理增加认证和 HTTPS，再更改监听地址。数据库不暴露宿主机端口。

## 验证

```sh
docker compose --profile tools run --rm test npm test
docker compose --profile tools run --rm test npm run typecheck
docker compose --profile tools run --rm test npm run build
# 启动 web 后，仅在演示模式运行集成验证（会创建演示查询记录）：
docker compose --profile tools run --rm test npm run test:integration
# PostgreSQL 集成测试（会创建并清理测试查询）：
docker compose --profile tools run --rm -e RUN_DATABASE_TESTS=true test npm test -- apps/api/tests/database.test.ts
# Windows / PowerShell：打断正在运行的演示任务并重建容器，验证恢复和数据卷
./scripts/verify-restart.ps1
```

集成验证覆盖数据库持久图、环与去重、共同好友、路径、私密/边界状态、显示截断、重复查询不新增调用、预算限制及继续采集。真实 Steam 联通性需要配置有效 Key 后验证。

本地交付验证：26 项测试通过（包含真实 PostgreSQL 集成测试），TypeScript 检查和 Docker 生产构建通过。已验证 500 个直接好友的分批采集、Worker 被强制终止后的恢复，以及重建数据库/API 容器后的数据保留；桌面和手机布局已在浏览器检查。500 好友场景使用模拟接口验证采集逻辑，不代表真实 Steam 请求速度或万节点图谱性能。

## 项目结构

```text
apps/api/src/        API、数据库、采集、图分析
apps/web/src/        页面和交互组件
packages/shared/    前后端共享契约
scripts/            Docker 集成验证
docs/superpowers/   设计和实施记录
```

Steam 官方参考：[用户接口](https://partner.steamgames.com/doc/webapi/ISteamUser)、[API 条款](https://steamcommunity.com/dev/apiterms)。私密好友无法读取；采集速度受 Steam 实际限制影响。数据库容量与渲染上限需按实际设备、网络密度及部署资源压测，本项目未宣称百万节点性能。
