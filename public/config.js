// 个人面板的运行时配置。纯静态文件，不参与构建，改完刷新页面即可生效。
//
// apiBase：接口服务地址。
//   本地 `npm start`：留空字符串。页面和接口同源，走相对路径 /api/...
//   静态托管（GitHub Pages 等）：填 Edge Function 地址，例如
//     https://<project-ref>.supabase.co/functions/v1/personal-dashboard
//   填到 personal-dashboard 为止，不要带 /api —— 代码会自动拼上 /api/...
//
// 放在这个文件里而不是写死在 app.js，是为了以后 supabase.co 不通、
// 需要换中转地址时，只改这一个文件，不用动业务代码。
window.PERSONAL_DASHBOARD_CONFIG = {
  apiBase: ''
};
