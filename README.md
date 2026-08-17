# 峡谷口令互助

一个移动端优先的非官方玩家口令互助工具。普通用户无需注册，可以按活动和奖励档位提交、复制及反馈口令；管理员负责创建活动、设置档位、暂停异常口令和配置赞助入口。

生产环境使用 TypeScript、Vercel Serverless Functions 和 PostgreSQL；Python + SQLite 版本保留用于无需联网的本地体验。

## 本地运行

需要 Python 3.11 或更高版本，不需要安装第三方依赖。

```powershell
$env:ADMIN_PASSWORD="请换成你自己的强密码"
python server.py
```

然后访问：

- 用户端：http://127.0.0.1:8000
- 管理后台：http://127.0.0.1:8000/admin

如果没有设置 `ADMIN_PASSWORD`，本地开发密码为 `admin123`。正式部署前必须修改。

## Vercel部署

1. 在Vercel创建项目并连接本仓库。
2. 在Vercel Marketplace创建或连接一个PostgreSQL数据库（推荐Neon）。
3. 配置环境变量：

```env
DATABASE_URL=PostgreSQL连接地址
ADMIN_PASSWORD=一个足够长的随机密码
```

4. 重新部署。首次请求会自动创建数据表和草稿演示活动。

Vercel运行入口位于 `api/index.ts`，数据库模块位于 `server/database.ts`，浏览器端TypeScript源码位于 `src/`。运行：

```powershell
npm install
npm run check
```

## 已实现的首版规则

- 多活动卡片和独立活动页
- 数值、预设选项、单一奖励三种奖励模式
- 活动自定义奖励档位和适用范围
- 新口令固定10次，可按活动调整
- 复制成功才确认领取；失败时释放预留次数
- 同浏览器每日领取和提交限额，辅以IP异常限流
- 新口令待验证；成功、失效和奖励不符反馈
- 两个不同访客与IP报告异常后自动暂停
- 本机领取历史和匿名发布者撤回
- 管理员活动、口令、规则与赞助配置
- 活动到期归档，30天后清除完整口令

## 说明

这是非官方玩家互助工具，与腾讯及《王者荣耀》官方无关联。平台只能管理口令在本站被分配和复制的次数，无法读取游戏内的真实剩余次数。
