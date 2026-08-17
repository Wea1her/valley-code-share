# 峡谷口令互助

一个面向《王者荣耀》玩家的非官方活动口令互助平台。用户无需注册，即可按活动、适用区服和奖励档位分享或领取口令；管理员通过后台维护活动规则、处理异常口令并配置赞助入口。

> 本项目与腾讯及《王者荣耀》官方无关联。口令是否有效、实际奖励和剩余使用次数均以游戏内结果为准。

## 在线地址

- 用户端：<https://valley-code-share.vercel.app>
- 管理后台：<https://valley-code-share.vercel.app/admin>
- GitHub：<https://github.com/Wea1her/valley-code-share>

首次部署会生成一个草稿演示活动。首页没有公开活动时，请进入管理后台编辑并发布活动。

## 核心功能

### 玩家端

- 无需注册，使用浏览器匿名标识记录操作
- 首页按进行中、即将开始、暂停和往期活动分类
- 按奖励档位和适用范围自动分配口令
- 点击复制成功后才确认占用一次领取次数
- 当前浏览器可查看、再次复制历史口令，不重复扣减
- 匿名提交口令，并在原浏览器撤回自己的提交
- 支持“兑换成功”“无效或已满”“奖励与标注不符”反馈

### 管理端

- 创建、编辑、发布、暂停和结束活动
- 独立配置每个活动的奖励档位、适用范围和次数限制
- 支持数值、预设选项和单一奖励三种奖励模式
- 查看口令状态、剩余次数和用户反馈
- 暂停或恢复异常口令
- 配置网站声明、互助规则和赞助二维码

## 口令分配规则

1. 新口令默认进入“待验证”状态。
2. 每个口令默认可以被领取10次，具体数量可按活动配置。
3. 用户选择奖励档位后，系统优先分配剩余次数较少的口令；剩余次数相同时随机选择。
4. 服务端先预留口令，浏览器复制成功后确认领取；复制失败或预留超时会释放次数。
5. 一次成功反馈会把待验证口令标记为已验证。
6. 两名不同访客且来自不同IP的用户报告同一种异常后，口令自动暂停。
7. 活动结束后停止提交和领取；30天后清除完整口令，只保留匿名统计数据。

平台只能统计口令在本站被分配和复制的次数，无法查询口令在游戏内或其他群聊中的真实使用情况。

## 技术架构

```text
浏览器
  │
  ├── HTML / CSS / TypeScript
  │       └── esbuild 编译为浏览器 JavaScript
  │
  └── /api/*
          │
          └── Vercel Serverless Function（TypeScript / Node.js 22）
                    │
                    └── postgres.js
                              │
                              └── Neon PostgreSQL
```

| 层级 | 技术 |
| --- | --- |
| 前端 | TypeScript、原生HTML、原生CSS |
| 前端构建 | esbuild |
| 后端 | TypeScript、Node.js 22 |
| API运行时 | Vercel Serverless Functions |
| 生产数据库 | Neon PostgreSQL |
| 数据库客户端 | postgres.js |
| 类型检查 | TypeScript Compiler |
| 包管理 | npm |
| 部署 | Vercel |
| 代码托管 | GitHub |
| 本地兼容模式 | Python标准库、SQLite、ThreadingHTTPServer |

## 项目结构

```text
.
├── api/
│   └── index.ts                 # Vercel Serverless API入口
├── server/
│   └── database.ts              # PostgreSQL连接、建表与清理逻辑
├── src/
│   ├── app.ts                   # 玩家端TypeScript源码
│   └── admin.ts                 # 管理端TypeScript源码
├── static/
│   ├── index.html               # 玩家端HTML
│   ├── admin.html               # 管理端HTML
│   ├── styles.css               # 玩家端与公共样式
│   ├── admin.css                # 管理端样式
│   ├── app.js                   # 构建生成的本地兼容文件
│   └── admin.js                 # 构建生成的本地兼容文件
├── scripts/
│   ├── build.mjs                # 前端构建脚本
│   └── smoke-production.mjs     # 可自动清理的生产冒烟测试
├── tests/
│   └── test_server.py           # Python本地版本回归测试
├── server.py                    # Python + SQLite本地兼容服务器
├── package.json
├── tsconfig.api.json
├── vercel.json
└── .env.example
```

生产环境以TypeScript版本为准。Python版本拥有独立的SQLite数据库，不会与Neon PostgreSQL自动同步。

## 本地开发

### TypeScript与Vercel模式

要求：

- Node.js 22
- npm
- 一个可用的PostgreSQL数据库

安装依赖：

```powershell
npm install
```

准备环境变量：

```powershell
Copy-Item .env.example .env.local
```

编辑 `.env.local`：

```env
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
ADMIN_PASSWORD=请设置足够长的随机密码
```

检查并构建：

```powershell
npm run check
```

使用Vercel本地运行时启动：

```powershell
npx vercel dev
```

### Python与SQLite兼容模式

需要Python 3.11或更高版本，不需要安装第三方依赖：

```powershell
$env:ADMIN_PASSWORD="请换成你自己的强密码"
python server.py
```

访问：

- 用户端：<http://127.0.0.1:8000>
- 管理后台：<http://127.0.0.1:8000/admin>

如果没有设置 `ADMIN_PASSWORD`，本地兼容模式会使用开发密码 `admin123`。请勿用该默认密码公开部署。

## 环境变量

| 变量 | 必需 | 用途 |
| --- | --- | --- |
| `DATABASE_URL` | 生产必需 | PostgreSQL连接地址，推荐使用Neon提供的池化连接地址 |
| `ADMIN_PASSWORD` | 必需 | 管理后台密码，Vercel中应保存为Sensitive变量 |
| `HOST` | Python模式可选 | 本地服务器监听地址，默认 `127.0.0.1` |
| `PORT` | Python模式可选 | 本地服务器端口，默认 `8000` |
| `TRUST_PROXY` | Python部署可选 | 是否信任反向代理的 `X-Forwarded-For`，默认关闭 |

`.env.local`、Vercel配置、数据库文件和本地认证信息均已加入 `.gitignore`。不要把真实密码或数据库地址提交到Git。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 编译前端TypeScript并生成 `public/` 部署目录 |
| `npm run check` | 检查服务端TypeScript并构建前端 |
| `npm run smoke:production` | 对生产环境执行提交、领取、确认和反馈测试，完成后自动删除测试活动 |
| `python -m unittest discover -s tests -v` | 运行Python兼容版本回归测试 |
| `npx vercel dev` | 启动Vercel本地开发环境 |
| `npx vercel deploy --prod` | 部署到Vercel生产环境 |

生产冒烟测试默认请求 `https://valley-code-share.vercel.app`。测试其他地址时可以设置 `BASE_URL`。

## 部署到Vercel

### 1. 登录并关联项目

```powershell
npx vercel login
npx vercel link
```

### 2. 创建PostgreSQL数据库

可以在Vercel Marketplace中安装Neon，也可以使用已有PostgreSQL数据库：

```powershell
npx vercel integration add neon
```

Neon连接成功后，Vercel会自动配置 `DATABASE_URL` 等环境变量。

### 3. 设置管理员密码

建议在Vercel项目设置中创建Sensitive环境变量，也可以使用CLI：

```powershell
npx vercel env add ADMIN_PASSWORD "production,preview" --sensitive
```

### 4. 构建与部署

```powershell
npm run check
npx vercel build --yes
npx vercel deploy --prod --yes
```

首次访问API时会自动创建数据表、默认设置和一个草稿演示活动。

### 5. 自动部署

在Vercel项目的Git设置中连接GitHub仓库，并授权Vercel GitHub App访问私有仓库。连接后，推送到 `main` 会自动触发生产部署，其他分支会生成预览部署。

## 主要API

### 公开接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/bootstrap` | 获取网站设置和活动列表 |
| `GET` | `/api/activities/:id` | 获取活动、档位及口令池统计 |
| `POST` | `/api/activities/:id/codes` | 匿名提交口令 |
| `POST` | `/api/activities/:id/claim` | 预留并取得一个口令 |
| `POST` | `/api/claims/:id/confirm` | 确认剪贴板复制成功 |
| `POST` | `/api/claims/:id/cancel` | 复制失败并释放预留次数 |
| `POST` | `/api/claims/:id/feedback` | 提交兑换反馈 |
| `POST` | `/api/my/submissions` | 查询当前浏览器拥有管理凭证的提交 |
| `POST` | `/api/codes/:id/withdraw` | 匿名发布者撤回口令 |

### 管理接口

管理接口通过 `HttpOnly`、`Secure`、`SameSite=Strict` Cookie鉴权，入口包括登录、活动管理、口令审核和网站设置。

## 安全与隐私

- 不收集王者荣耀账号、密码、验证码或游戏角色信息
- 浏览器标识和IP在保存前使用服务端密钥进行HMAC哈希
- 管理员会话Cookie启用 `HttpOnly`、`Secure` 和 `SameSite=Strict`
- 数据库操作使用参数化查询
- 口令分配使用数据库事务和行锁，避免并发超发
- 提交和领取均设置浏览器/IP频率限制
- 口令预留有超时时间，未确认会自动释放
- 活动结束30天后删除完整口令

匿名模式无法完全阻止用户清除浏览器数据、更换设备或网络后重复操作。当前限制属于降低滥用成本，而不是强身份认证。

## 测试与验收

提交代码前建议执行：

```powershell
npm run check
npm audit --omit=dev
python -m unittest discover -s tests -v
```

部署后执行：

```powershell
npm run smoke:production
```

冒烟测试会创建临时活动，依次验证口令提交、领取、确认和成功反馈，并在 `finally` 阶段删除测试活动及其关联数据。

## 已知限制

- 平台无法读取游戏内真实剩余领取次数。
- 口令可能已在QQ群、微信群等站外渠道被使用。
- 匿名浏览器标识可以被主动清除或伪造。
- Python/SQLite与TypeScript/PostgreSQL是两套独立数据源。
- Vercel Serverless Function冷启动时，首次请求可能略慢。
- 当前没有普通用户账号系统，因此领取历史只保存在当前浏览器。

## 品牌与内容边界

网站采用原创的深青、金色、紫色游戏活动页风格，不应直接复制官方英雄、皮肤、活动插画或使用“官方平台”等可能引发误解的描述。
