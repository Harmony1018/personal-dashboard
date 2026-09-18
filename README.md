# 个人面板 MVP

一个面向单用户的经营与生活数据面板。第一批包含经营、计划、健康三个领域，支持手动记录、CSV 批量导入、自动化接口、趋势分析和阶段回顾。

## 当前能力

- 响应式 PC / 手机 Web 界面
- 销售额、订单、广告、退款、睡眠、运动、体重、状态、专注时间
- 任务创建、优先级、截止日期和完成状态
- 7 天 / 30 天趋势与规则分析
- 周度 / 月度回顾
- CSV 批量导入和 JSON 全量备份
- Bearer Token 单用户访问保护
- 自动采集 API，供脚本、RPA 和后续平台连接器调用
- Supabase PostgreSQL 云端数据后端，可回退到 SQLite 本地存储
- Supabase 私有图片存储与短时签名链接

## 本机运行

要求 Node.js 22.5 或更高版本，推荐 Node.js 24。

```powershell
$env:DASHBOARD_TOKEN='换成一个足够长的随机令牌'
npm start
```

打开 `http://127.0.0.1:4173`。在“设置”中输入同一个访问令牌。

未设置 `DASHBOARD_TOKEN` 时，接口不进行身份验证，仅适合本机开发。未配置 Supabase 时，程序自动使用本地 SQLite；图片接口会保持关闭。

## 接入 Supabase

1. 在 Supabase 创建项目。
2. 打开 SQL Editor，执行 `supabase/migrations/001_initial.sql`。
3. 在项目设置的 API Keys 页面获取服务端 Secret Key。旧项目中它可能显示为 `service_role` key。
4. 创建 `.env`，填写：

```dotenv
DASHBOARD_TOKEN=换成一个足够长的随机令牌
DATA_BACKEND=supabase
SUPABASE_URL=https://你的项目标识.supabase.co
SUPABASE_SERVICE_ROLE_KEY=只允许保存在服务端的密钥
SUPABASE_STORAGE_BUCKET=personal-images
```

`SUPABASE_SERVICE_ROLE_KEY` 可以绕过 RLS，绝对不能写入浏览器、鸿蒙 App、Git 仓库或公开日志。客户端始终只访问本项目的 `/api/*` 接口。

迁移脚本会创建 `metrics`、`entries`、`tasks`、`reports`、`images` 表和私有 `personal-images` 存储桶，并为数据表开启 RLS。当前单用户架构不向匿名 Supabase 客户端开放任何策略。

## 云服务器部署

服务器安装 Docker 后，在项目目录创建 `.env`：

```dotenv
DASHBOARD_TOKEN=换成一个足够长的随机令牌
```

启动：

```bash
docker compose up -d --build
```

使用 Supabase 后，业务数据和图片保存在 Supabase；Docker 卷仅作为本地回退。生产环境应使用 Caddy 或 Nginx 配置 HTTPS，并只开放 HTTPS 端口；不要直接把未加密的 4173 端口暴露到公网。

## 图片接口

当前只提供 API，不包含上传或相册 UI。支持 JPEG、PNG、WebP、GIF、HEIC、HEIF，单张最大 10 MB。存储桶保持私有。

上传原始图片二进制：

```bash
curl -X POST \
  -H "Authorization: Bearer <dashboard-token>" \
  -H "Content-Type: image/jpeg" \
  -H "X-File-Name: example.jpg" \
  --data-binary @example.jpg \
  "https://your-domain.example/api/images?category=health&note=example"
```

相关接口：

- `POST /api/images`：上传图片二进制和元数据。
- `GET /api/images?limit=50`：列出图片元数据，不返回公开 URL。
- `GET /api/images/:id/url?expiresIn=900`：生成 60 至 3600 秒有效的签名 URL。
- `DELETE /api/images/:id`：同时删除 Storage 对象和数据库元数据。

可选上传参数：`category`、`relatedType`、`relatedId`、`capturedAt`、`note`、`filename`。文件名也可放在 URL 编码后的 `X-File-Name` 请求头中。

图片上传接口验证 MIME 类型、文件签名和 10 MB 大小上限。后续开放 UI 前，建议增加缩略图生成和 EXIF 清理。

## CSV 格式

```csv
recorded_on,metric_key,value,note
2026-09-18,business.revenue,2680,日常销售
2026-09-18,health.sleep,7.5,
```

可用指标键：

- `business.revenue`
- `business.orders`
- `business.ad_spend`
- `business.refunds`
- `health.sleep`
- `health.exercise`
- `health.weight`
- `health.mood`
- `planning.focus`

## 自动采集

自动任务向 `POST /api/automation/entries` 提交单条或批量记录。云端开启令牌时需携带 `Authorization: Bearer <token>`。

```json
{
  "source": "daily-rpa",
  "entries": [
    {
      "metricKey": "business.revenue",
      "value": 2680,
      "recordedOn": "2026-09-18",
      "note": "平台日报"
    }
  ]
}
```

每次最多提交 1000 条；批次中任意一条无效时整批回滚。具体平台连接器需要在确定数据来源后单独实现。

## HarmonyOS NEXT 接入

鸿蒙原生端建议使用 ArkTS + ArkUI，复用现有 HTTPS API：

- 首次启动保存服务器地址和访问令牌。
- 令牌使用系统安全存储，不写入普通偏好设置。
- 首页调用 `/api/bootstrap`。
- 快捷记录调用 `/api/entries`。
- 任务调用 `/api/tasks`。
- 本地使用关系型数据库保存待同步记录，网络恢复后重试。
- 第二阶段增加通知、服务卡片和设备认证。

当前响应式 Web 已适配手机浏览器，可在 ArkTS 客户端开发完成前使用。

## 数据与分析原则

核心指标由数据库查询和固定公式计算。未来接入大模型时，只允许模型读取已计算结果并生成解释，不让模型自行计算经营数字。正式接入财务或健康敏感数据前，应增加数据库备份、传输加密、操作日志和字段级隐私控制。
