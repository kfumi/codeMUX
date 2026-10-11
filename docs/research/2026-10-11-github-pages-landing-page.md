# GitHub Pages 用于 CodeMUX 项目落地页的可行性调研

调研日期：2026-10-11

## 结论

GitHub Pages 可以免费托管项目介绍、功能截图、文档入口和下载入口等静态落地页。GitHub Free 个人账户支持从公开仓库发布 Pages；当前 `kfumi/codeMUX` 仓库经 GitHub 官方 API 查询为公开仓库、默认分支为 `master`，因此具备使用免费套餐发布项目站点的条件。项目站点默认地址形式是 `https://<账号>.github.io/<仓库名>/`，本仓库对应的预期地址为 `https://kfumi.github.io/codeMUX/`，需在仓库启用 Pages 并完成首次部署后才可访问。[Pages 站点类型与免费套餐说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)；[仓库 API 信息](https://api.github.com/repos/kfumi/codeMUX)

建议为落地页准备独立的静态文件目录，并通过 GitHub Actions 构建、发布；不要直接把现有 `dist-web/` 当成产品宣传站点发布。GitHub Pages 只提供静态文件托管，而 CodeMUX 现有网页前端是 daemon 客户端，需要连接本机或已配对的 CodeMUX daemon 才能完整工作。

## GitHub Pages 能力与边界

| 项目 | 官方规则与对 CodeMUX 的影响 |
|---|---|
| 免费套餐 | GitHub Free 个人账户和组织可从公开仓库使用 Pages；私有仓库需要 Pro、Team 或 Enterprise 等支持套餐。即使使用允许 Pages 的付费套餐，私有源仓库发布出的站点仍公开可访问，不能用来隐藏页面内容。[套餐与发布源说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)、[发布源配置说明](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) |
| 站点类型 | 项目站点发布在 `https://<账号>.github.io/<仓库名>/`；一个仓库最多一个项目站点。账号/组织主页站点则需使用 `<账号>.github.io` 命名的仓库。[站点类型说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) |
| 发布方式 | 可从分支发布，也可用 GitHub Actions 自定义构建和部署。分支方式只能选源分支根目录或 `/docs`；若希望把源文件独立放在 `landing/`，Actions 更合适。官方流程是检出代码、构建静态文件、上传 Pages artifact、再部署；部署 job 至少要有 `pages: write` 与 `id-token: write` 权限。[发布源配置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)、[自定义 workflow 指南](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) |
| Actions 费用 | 公开仓库使用标准 GitHub 托管 runner 免费；Pages 配额说明也明确自定义 Actions workflow 发布不受每小时 10 次构建的软限制。[Actions 计费](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)、[Pages 配额](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| 静态限制 | Pages 托管 HTML、CSS、JavaScript，可在发布前运行构建流程；它不是常驻后端服务，不能在 Pages 上运行 CodeMUX daemon 或提供动态会话/API 服务。[Pages 定义](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) |
| 使用政策 | Pages 不允许作为免费托管来运行在线业务、电商，或主要用于促成商业交易、提供商业 SaaS；也不应用于密码、信用卡号等敏感交易。以开源桌面项目介绍、文档和下载链接为主的页面与这些用途不同；若页面以后主要承担商业交易或 SaaS 服务，应另选托管方案。[Pages 使用限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| 域名与 HTTPS | 可用 `github.io` 地址，也支持自有域名；Pages 站点支持 HTTPS，可在设置中强制 HTTPS。配置自有域名还需在域名服务商处设置 DNS；DNS 变更传播最长可能需要 24 小时。[自定义域名支持](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages)、[域名 DNS 设置](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)、[HTTPS 设置](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https) |
| 配额 | 源仓库建议不超过 1 GB；发布站点最大 1 GB；单次部署超过 10 分钟会超时；月带宽软限制 100 GB；常规构建软限制每小时 10 次（自定义 Actions workflow 发布不受该构建频率限制）。落地页及图片应保持精简，大型安装包继续使用 GitHub Releases 等发布渠道。[Pages 使用配额](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |

## CodeMUX 仓库现状

- 当前仓库是公开的 `kfumi/codeMUX`，默认分支为 `master`；信息于 2026-10-11 通过 GitHub 官方仓库 API 查询。[仓库 API](https://api.github.com/repos/kfumi/codeMUX)
- 项目根目录的 `npm run build:web` 会构建统一前端到 `dist-web/`（见 [`package.json`](../../package.json)）。这套前端服务于桌面、PC 浏览器和移动浏览器形态，不是单独的宣传落地页。
- Vite 配置没有设置 `base`（见 [`vite.config.ts`](../../vite.config.ts)）；根 [`index.html`](../../index.html) 还使用 `/favicon.png` 这类从域名根路径开始的绝对资源路径。
- 前端入口会挂载 `HostBootstrapGate`，由它引导浏览器/移动端连接 daemon 或进入配对流程（见 [`HostBootstrapGate.tsx`](../../src/components/bootstrap/HostBootstrapGate.tsx)）。因此直接把 `dist-web/` 部署成公开 Pages 页面，并不能把它变成无需 daemon 的宣传站点。

## 推荐操作步骤

1. 在仓库增加独立落地页目录，例如 `landing/`。第一版可以用普通 HTML/CSS/图片，只包含产品介绍、功能截图、GitHub 仓库链接、文档入口和 Releases 下载链接；不要依赖 daemon API。
2. 在 `.github/workflows/` 添加 Pages workflow，监听 `master` 分支推送并提供手动触发入口。workflow 从 `landing/` 生成静态文件（若直接提交已完成的静态文件则跳过构建），上传包含顶层 `index.html` 的 Pages artifact，并用 `actions/deploy-pages` 部署。GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。[官方自定义 workflow 说明](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
3. 首次部署完成后，从 **Settings → Pages** 确认发布地址。默认项目站点地址预计为 `https://kfumi.github.io/codeMUX/`。
4. 如以后绑定自有域名，在 Pages 设置中先登记域名，再按 GitHub 指引配置 CNAME 或 apex 域名 DNS 记录；验证域名并启用 **Enforce HTTPS**。[DNS 配置指引](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)、[HTTPS 指引](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

## Vite 的前缀路径注意点

项目站点位于 `/<仓库名>/` 子路径下，而不是域名根目录。Vite 官方说明：部署在嵌套公共路径时，应通过 `base` 配置构建路径；如果路径在构建时不确定，可以使用相对 `base: "./"`。运行时拼接资源地址时使用 `import.meta.env.BASE_URL`。这些规则可避免脚本、样式和图片请求错误地落到 `https://kfumi.github.io/` 根目录。[Vite 公共 base 路径说明](https://vite.dev/guide/build#public-base-path)

对 CodeMUX 落地页有两种稳妥选择：

- **静态 HTML 方案**：链接和图片使用相对路径，例如 `./assets/hero.webp`。单页锚点导航（`#features`）不要求服务器支持 SPA 路由回退。
- **独立 Vite 落地页方案**：使用独立配置/入口，不改动面向应用的现有构建配置；明确设置 `base: "/codeMUX/"`，或在目录结构允许时使用 `base: "./"`。检查生成后的 `dist` 中 HTML、CSS、favicon、图片及动态资源 URL 均带有正确前缀。避免直接复用现有根 `index.html` 中未检查的 `/favicon.png` 绝对路径。

如果以后要添加可直接访问的多级页面路由，需要确保每个路由都有静态 HTML 文件，或专门设计静态托管可用的路由策略；不应假设 GitHub Pages 会像有服务器端重写规则的 SPA 主机那样自动回退到应用入口。[GitHub Pages 会从发布内容中查找顶层 `index.html`](https://docs.github.com/en/pages/getting-started-with-github-pages/troubleshooting-404-errors-for-github-pages-sites)

## 参考资料

- [What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [Configuring a publishing source for your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [Using custom workflows with GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub Actions billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions)
- [About custom domains and GitHub Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages)
- [Managing a custom domain for your GitHub Pages site](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
- [Securing your GitHub Pages site with HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
- [Vite: Public Base Path](https://vite.dev/guide/build#public-base-path)
