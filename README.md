# [>v<] B.O.A.R.D.

**B**rowser-**O**perated **A**PI **R**endering **D**isplay

……纯前端的 OpenAI 图像生成工具。不需要后端。API Key 只保存在你的浏览器里。

## board:img

当前模块——调用 Responses API 的 `image_generation` 工具生成和编辑图像。

## ……启动方法

```bash
npm install
npm run dev
```

……然后打开 `http://localhost:5173`。

## ……部署

### GitHub Pages

```bash
npm run build
npx gh-pages -d dist
```

### Cloudflare Pages

```bash
npm run build
npx wrangler pages deploy dist
```

……也可以——在 Cloudflare Dashboard 里连接 GitHub 仓库。Build command 填 `npm run build`，output 填 `dist`。

## ……关于 CORS

……直连 `api.openai.com`——OpenAI 支持 CORS——没有问题。

……如果用的是自建网关——需要网关返回正确的 CORS headers：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Allow-Methods: POST, OPTIONS
```

## ……功能

- 直接在浏览器里调用 Responses API
- Base URL / API Key / Model 保存在 localStorage——下次不用重新填
- 支持 streaming——生成过程中显示 partial images
- 支持参考图片上传（拖拽或点击）——配合 `action: edit` 可以编辑图像
- 支持 size / quality / format / compression / action 参数
- Ctrl+Enter 快速提交
- 下载 / 复制 base64 / 新窗口打开

## ……路线图

- `board:mask` — Images API + canvas mask 编辑器
- `board:batch` — 多 prompt 并发生成
- `previous_response_id` — 多轮迭代编辑

## ……技术栈

- React 19 + Vite
- 零运行时依赖（除了 React）
- 纯 CSS

---

……璃奈做的。`[>v<]`
