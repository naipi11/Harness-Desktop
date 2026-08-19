# Harness 图标、打包与跨客户端发布实施计划

[English](2026-08-18-harness-icon-packaging-docs.md) | 中文

> **供 agentic worker 使用：** 必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项执行本计划。步骤使用复选框（`- [ ]`）记录。

**目标：** 交付原创 B“星轨小鲸鱼”（star-trail little whale）Harness 视觉资产、可安装的 Windows/macOS/Linux 桌面产物、全局 `harness` CLI 包、双语最终用户说明，以及证明三个客户端共用同一个本地 Runtime 的发布证据。

**架构：** 一个可编辑、由仓库拥有的 SVG 是图标唯一权威；确定性的 Node 生成脚本从它派生全部位图、容器和 Web 资产。`electron-builder` 是唯一桌面打包器，其配置只引用生成资产，并分别测试源码、构建输出、打包存档和已安装客户端行为。Runtime 始终是唯一持久化写入者；发布测试从终端、Web 和 Desktop 观察该不变量，不为打包代码增加第二条数据路径。

**技术栈：** Node.js `^22.19.0 || >=24.0.0`、pnpm 11、TypeScript 6、SVG、Sharp、PNG-to-ICO、`@fiahfy/icns`、Electron Builder、NSIS、DMG、AppImage、Debian 包、Vitest、Playwright 与 GitHub Actions 原生 runner。

**规格：** [Harness 统一本地 Runtime 设计](../specs/2026-08-18-harness-unified-local-runtime-design.md)

## 全局约束

- 只使用已批准的原创 B“星轨小鲸鱼”（star-trail little whale）方向：圆润的蓝紫色小鲸鱼、柔粉色高光和小星轨；不得复制 DeepSeek 角色、标志、名称、源图或可识别视觉资产。
- `assets/brand/harness-icon.svg` 是可编辑真源，并声明颜色 token；生成文件不得手工编辑。
- 64 px 及以上保留星轨；32 px 与 16 px 必须保留清晰鲸鱼轮廓和一颗星。
- 从同一 SVG 派生 Windows 多尺寸 `.ico`、macOS `.icns`、Linux PNG/SVG 变体、Web favicon 和 PWA 图标。跨平台原生标记刻意只使用一种适配明暗环境的资产，不声称存在主题成对版本；只有 `apps/web/public/favicon.svg` 含生成的 `prefers-color-scheme` 明暗变体，测试必须断言两者。
- 桌面矩阵是 Windows NSIS、macOS universal DMG、Linux AppImage 与 Linux Deb；本地和 CI 打包命令都传入 `--publish never`。
- 公共 npm 包是 `@harness-desktop/cli`；`harness` 为主命令，`dsh` 保持同一 parser、Runtime 和数据根目录的兼容别名。
- `HARNESS_HOME` 是唯一可写 Harness 数据根目录。默认值为 `%LOCALAPPDATA%\Harness Desktop`、`~/Library/Application Support/Harness Desktop`、以及 `$XDG_DATA_HOME/harness-desktop` 或 `~/.local/share/harness-desktop`。
- `harness`、`harness web` 和 `harness desktop` 是同一台本地 Runtime 的独立客户端；没有客户端可直接修改持久化或拥有私有会话格式。
- `harness web --daemon` 与 `harness web --background` 创建同一种租约；`--status` 不启动 Runtime，`--stop` 只释放该租约。
- Runtime 只绑定 `127.0.0.1`。launcher 所有的一次性、只允许当前用户访问的 bootstrap 目录和 document 具有已验证的仅所有者 POSIX mode 或当前用户 Windows ACL，创建时拒绝权限更宽的位置。其 file URL、launch arguments 和日志干净，而 HTML body 只在 hidden form field 中提交高熵 handoff。其不透明 file origin 有意使顶级向 `/_harness/handoff` 的 `POST` 跨 origin：Runtime 不要求 Origin 相等，只认证被原子消费且未过期的正文 handoff，不发送 CORS permission，并返回干净 Dashboard `303` navigation。launcher 所有、绑定 `expiresAt` 的幂等 cleanup timer 在 dispatch failure、exchange success 或 failure、expiry 及 never-dispatched document 后精确一次删除所属 document 和目录。handoff 绝不出现在 URL、hash、query、header、referrer、history、browser storage、diagnostic、transcript、文档示例、Renderer IPC 或测试输出中。exchange-body verifier 对唯一允许的 body capture 脱敏。交换后的随机或签名会话凭据只出现在 Runtime `Set-Cookie`、浏览器 `Cookie` 请求头和浏览器 HttpOnly cookie jar 中；它使用不带 expiry attribute 的 `HttpOnly; SameSite=Strict; Path=/`，且绝不进入 Dashboard JavaScript、Renderer IPC、脚本存储、应用持久化、诊断、快照或会话记录。
- 每份改动的人类可读文档都有英文和简体中文对侧，并刷新 `.i18n.yaml` 一致性记录。
- 只有指定验证全部通过后，Git push 才在范围内。`npm publish` 和 GitHub Release 创建都需要新的明确用户批准，成功构建、打包或 push 不构成批准。
- 本计划按原样消费 CLI/Web 拥有的 parser、dispatcher、已安装应用 resolver 和 activator；不得创建第二套 resolver/activator，也不得更改 `harness web --stop`：Foundation 定义无 Web lease 时 release 仍为幂等成功。

---

### 任务 1：添加原创可编辑图标与确定性资产生成器

**文件：**
- 新建：`assets/brand/harness-icon.svg`
- 新建：`assets/brand/README.md`
- 新建：`assets/brand/README.zh.md`
- 新建：`assets/brand/README.i18n.yaml`
- 新建：`scripts/generate-product-icons.ts`
- 新建：`scripts/generate-product-icons.spec.ts`
- 新建：`apps/desktop/resources/icons/win/harness-desktop.ico`
- 新建：`apps/desktop/resources/icons/mac/harness-desktop.icns`
- 新建：`apps/desktop/resources/icons/linux/harness-desktop-16.png`
- 新建：`apps/desktop/resources/icons/linux/harness-desktop-32.png`
- 新建：`apps/desktop/resources/icons/linux/harness-desktop-64.png`
- 新建：`apps/desktop/resources/icons/linux/harness-desktop-128.png`
- 新建：`apps/desktop/resources/icons/linux/harness-desktop-256.png`
- 新建：`apps/desktop/resources/icons/linux/harness-desktop-512.png`
- 修改：`apps/web/public/favicon.svg`
- 新建：`apps/web/public/icons/harness-192.png`
- 新建：`apps/web/public/icons/harness-512.png`
- 新建：`apps/web/public/icons/harness-maskable-512.png`
- 修改：`package.json`
- 修改：`apps/web/public/manifest.webmanifest`
- 修改：`apps/web/tests/pwa-manifest.e2e.ts`

**接口：**
- 使用：`assets/brand/harness-icon.svg`、SVG 元素 ID `mark-full`、`mark-compact`、`theme-light`、`theme-dark`，以及颜色自定义属性 `--whale-primary`、`--whale-shadow`、`--whale-highlight`、`--star`、`--background`。
- 产出：`generateProductIcons(options?: { readonly check?: boolean }): Promise<void>` 与 `collectProductIconViolations(root: string): Promise<readonly string[]>`；`--check` 只报告漂移，不写文件。
- 产出：用于 Windows executable 与 NSIS 的 16、20、24、32、40、48、64、128、256 px ICO frame；用于 macOS 应用与 Dock 的 16、32、64、128、256、512、1024 px ICNS representation；Linux `harness-desktop-{16,32,64,128,256,512}.png` 与 `harness-desktop.svg`；以及 192、512 px Web PNG。只有 `favicon.svg` 含明确生成的 `@media (prefers-color-scheme: light)` 与 `dark` 图稿；不得声称存在原生明暗变体。

- [ ] **步骤 1：编写失败的源码与生成资产测试**

创建 `scripts/generate-product-icons.spec.ts`。读取 SVG 并要求出现五个精确 color token、`mark-full` 与 `mark-compact`，以及注释 `Original Harness artwork; no DeepSeek-derived assets.`。将生成器输出到临时根目录，要求接口列出的每个文件存在、非空，且 PNG 可解码为声明的尺寸。要求 ICO 同时含 16 px 与 256 px frame，ICNS 同时含 16 px 与 1024 px representation，Linux SVG 由真源生成，且 `favicon.svg` 同时具有不同的生成 light/dark media-query selector。要求 16/32 px 渲染输入引用 `mark-compact`，64 px 及以上引用 `mark-full`。

- [ ] **步骤 2：运行测试并确认生成器不存在**

运行：

```powershell
pnpm exec vitest run scripts/generate-product-icons.spec.ts
```

预期：FAIL，因为 `scripts/generate-product-icons.ts` 和 `assets/brand/harness-icon.svg` 不存在。

- [ ] **步骤 3：绘制并记录可编辑 SVG 真源**

创建基于 viewBox 的 SVG，只使用 path、circle、gradient 和已声明 CSS 自定义属性。`mark-full` 包含蓝紫色鲸鱼、柔粉色高光与三颗星轨；`mark-compact` 包含同一鲸鱼轮廓和一颗星。使用 `<symbol>` 或 `<g>` ID，让生成器无需解析图形几何即可选取两种标记。不得嵌入位图、外部 URL、DeepSeek 名称或第三方图稿。

在双语资产 README 中记录真源路径、token 名、简化/完整阈值、生成命令和“生成输出只能由生成器替换”的规则。运行：

```powershell
pnpm run verify-translation-pairing --write assets/brand/README.md
pnpm run verify-translation-pairing assets/brand/README.md
```

- [ ] **步骤 4：实现确定性生成与漂移报告**

用 `sharp` 以明确 width、height 和 sRGB PNG 输出渲染 SVG buffer。用 `png-to-ico` 合成要求的 Windows frame，用 `@fiahfy/icns` 写入 macOS representation 集。导出 `generateProductIcons`；从仓库根目录解析路径，绝不从调用目录解析。添加等效的根脚本：

```json
{
  "generate:icons": "tsx scripts/generate-product-icons.ts",
  "verify:icons": "tsx scripts/generate-product-icons.ts --check"
}
```

`--check` 必须逐个比较生成字节和已提交文件，并对缺失或过期路径输出稳定诊断，例如 `icon asset: stale apps/web/public/icons/harness-512.png; run pnpm run generate:icons`。检查模式不得写文件。

- [ ] **步骤 5：以生成资产替换 Web 图标元数据**

将当前无关的 `apps/web/public/favicon.svg` 替换为生成 SVG，其中含原创鲸鱼唯一的明暗 media-query 变体。把 `manifest.webmanifest` 的 `icons` 改为 `harness-192.png`、`harness-512.png` 与带 `purpose: "maskable"` 的 `harness-maskable-512.png`。更新 `apps/web/tests/pwa-manifest.e2e.ts`，断言精确路径、尺寸、MIME type、生成源码标记和两种 favicon media-query selector，不再断言旧黑白 path-fill 实现。

- [ ] **步骤 6：运行源码级生成与验证**

运行：

```powershell
pnpm run generate:icons
pnpm exec vitest run scripts/generate-product-icons.spec.ts apps/web/tests/pwa-manifest.e2e.ts
pnpm run verify:icons
```

预期：生成幂等；聚焦测试通过；`verify:icons` 以 0 退出且不修改已跟踪文件。

- [ ] **步骤 7：提交真源与生成图标集**

运行：

```powershell
git add assets/brand scripts/generate-product-icons.ts scripts/generate-product-icons.spec.ts apps/desktop/resources/icons apps/web/public/favicon.svg apps/web/public/icons apps/web/public/manifest.webmanifest apps/web/tests/pwa-manifest.e2e.ts package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(brand): add original Harness icon asset pipeline"
```

### 任务 2：让 Desktop 与 Web 构建消费生成资产

**文件：**
- 新建：`apps/desktop/tests/icon-assets.spec.ts`
- 修改：`apps/desktop/electron-builder.config.mjs`
- 修改：`apps/desktop/package.json`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/renderer/index.html`
- 修改：`apps/desktop/tests/desktop-dashboard.e2e.ts`
- 修改：`apps/desktop/tests/desktop-recovery.e2e.ts`
- 修改：`scripts/desktop-release-config.ts`
- 修改：`scripts/desktop-release-config.spec.ts`
- 修改：`package.json`

**接口：**
- 使用：生成的 `apps/desktop/resources/icons/{win,mac,linux}` 文件和 `apps/web/public` 生成资产。
- 产出：`desktopIconPath(platform: NodeJS.Platform): string`；`win32` 返回 `.ico`，`darwin` 返回 `.icns`，其余返回 512 px Linux PNG；Electron Builder 的 `win.icon`、`mac.icon`、`linux.icon` 均为生成路径。
- 产出：当平台图标缺失或指向 `apps/desktop/resources/icons` 外部时，`collectDesktopReleaseViolations()` 返回 `builderConfig.<platform>.icon: expected <path>`。

- [ ] **步骤 1：编写失败的 Desktop 图标所有权测试**

在 `apps/desktop/tests/icon-assets.spec.ts` 中要求 `desktopIconPath('win32')`、`desktopIconPath('darwin')`、`desktopIconPath('linux')` 返回三条精确生成路径。加载 Electron Builder 配置，要求 `win.icon`、`mac.icon`、`linux.icon` 与之相等。扩展 `scripts/desktop-release-config.spec.ts`，放入 Windows icon 为 `assets/deepseek.ico` 的无效配置 fixture，并要求 `collectDesktopReleaseViolations()` 包含 `builderConfig.win.icon: expected apps/desktop/resources/icons/win/harness-desktop.ico`。

- [ ] **步骤 2：运行测试并观察缺失的图标接口**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/icon-assets.spec.ts scripts/desktop-release-config.spec.ts
```

预期：FAIL，因为 `desktopIconPath` 和 Builder icon 字段尚不存在。

- [ ] **步骤 3：把生成文件接入 Electron 与 Builder**

在 Desktop main bootstrap 旁添加纯 `desktopIconPath(platform)` helper，并以它设置 BrowserWindow `icon`。在配置内设置如下仓库相对路径：

```js
win: { target: ['nsis'], icon: 'resources/icons/win/harness-desktop.ico' },
mac: { target: [{ target: 'dmg', arch: ['universal'] }], icon: 'resources/icons/mac/harness-desktop.icns', category: 'public.app-category.developer-tools' },
linux: { target: ['AppImage', 'deb'], icon: 'resources/icons/linux/harness-desktop-512.png', category: 'Development' }
```

扩展 Builder `files`，加入 `resources/icons/**`。添加 `prepackage` 与 `prepackage:dir` 脚本，调用 `pnpm --dir ../.. run verify:icons`；生成输出过期时，Electron Builder 前必须失败。只有当前生产 renderer 没有加载拥有 favicon 的 Dashboard 文档时，才在 renderer HTML 增加生成 favicon link；不得创建第二个 favicon 权威源。

- [ ] **步骤 4：加固发布配置验证器**

为 `DesktopBuilderConfig` 扩展 Windows、macOS、Linux 的可选 `icon` 字段。拒绝不是精确生成路径的值、缺少平台 icon 的配置和缺少 `resources/icons/**` 的 `files` 列表。保留现有不发布目标检查。命令行诊断必须命名无效配置字段和预期仓库相对路径。

- [ ] **步骤 5：验证源码、构建与 unpacked Desktop 资产**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/icon-assets.spec.ts scripts/desktop-release-config.spec.ts apps/desktop/tests/desktop-dashboard.e2e.ts apps/desktop/tests/desktop-recovery.e2e.ts
pnpm run verify:icons
pnpm run verify:desktop-release-config
pnpm run desktop:build
pnpm --filter @harness-desktop/dsh-desktop run package:dir
```

预期：源码断言通过；构建保留 favicon；unpacked 应用包含所选平台图标，启动时显示鲸鱼图标而非系统默认图标。

- [ ] **步骤 6：提交生成资产消费接线**

运行：

```powershell
git add apps/desktop apps/web scripts/desktop-release-config.ts scripts/desktop-release-config.spec.ts package.json pnpm-lock.yaml
git diff --cached --check
git commit -m "build(desktop): package generated Harness icons"
```

### 任务 3：添加分层包和原生安装器 smoke 测试

**文件：**
- 新建：`apps/desktop/tests/packaged-artifacts.spec.ts`
- 新建：`apps/desktop/tests/installed-artifacts.e2e.ts`
- 新建：`apps/desktop/tests/support/installed-artifact-fixture.ts`
- 新建：`apps/cli/tests/packed-install.e2e.ts`
- 新建：`apps/cli/tests/standalone-archive.e2e.ts`
- 新建：`scripts/release/build-cli-standalone.ts`
- 新建：`scripts/release/build-cli-standalone.spec.ts`
- 新建：`scripts/release/node-runtime-checksums.json`
- 新建：`scripts/release/verify-desktop-artifacts.ts`
- 新建：`scripts/release/verify-cli-standalone.ts`
- 修改：`apps/desktop/package.json`
- 修改：`apps/cli/package.json`
- 修改：`package.json`
- 修改：`scripts/run-gates.ts`
- 修改：`.github/workflows/desktop-artifacts.yml`

**接口：**
- 使用：Desktop-host 计划提供的干净源码/构建/unpacked Desktop 层、`apps/desktop/release/`、一个打包的 `apps/cli` tarball、共享无密钥 Runtime/Dashboard fixture 和当前 OS installer 工具。
- 产出：`verifyDesktopArtifacts(input: { readonly platform: NodeJS.Platform; readonly releaseDirectory: string }): Promise<readonly string[]>`；空数组表示当前 runner 的原生产物具有预期安装器和图标资源。
- 产出：`pnpm run release:verify-desktop-artifacts`、`pnpm run release:verify-packed-cli` 与 `pnpm run release:verify-cli-standalone`，均为不发布检查。打包 CLI 包含完整 Runtime dependency graph：`harness` 或 `dsh` 可达的每个 workspace dependency 都被 bundle 或列为能在全新 offline prefix 中解析的 package payload dependency；源码、测试、凭据和 Desktop artifact 仍被排除。
- 产出：`pnpm run release:smoke-installed-desktop`，它执行隔离的已安装或挂载产物启动，在已认证 Dashboard bootstrap 后消费 Desktop-host 计划精确的、脱敏且 process-observable 的 ready acknowledgement，验证生成图标，并证明卸载不删除 fixture 的 `HARNESS_HOME` sentinel。
- 产出：`buildCliStandalone(input: { readonly platform: NodeJS.Platform; readonly arch: string; readonly version: string; readonly nodeRuntimeRoot: string; readonly outputDirectory: string }): Promise<readonly string[]>`，确定性生成 `harness-cli-${version}-${platform}-${arch}.zip`、`harness-cli-${version}-${platform}-${arch}.tar.gz` 和 `harness-cli-${version}-${platform}-${arch}.sha256`。每份 archive 都包含 `manifest.json`、匹配的 pinned Node distribution、完整 CLI runtime graph、`harness` 与 `dsh`；每条命令均从没有 system Node 或 network 的空工作目录中运行。
- 产出：`scripts/release/node-runtime-checksums.json`，按精确 Node version、platform、architecture 和 distribution filename 键控的已审查 SHA-256 allowlist。producer 仅复制 allowlisted 的本地 Node distribution，缺少或 hash 不匹配即拒绝而非下载，在 `manifest.json` 中记录确定性排序的逐文件 digest map，并从 source date epoch 固定 archive timestamp、ordering、ownership 与 mode。
- 产出：target-specific native-module closure：每个 runtime `.node` 文件必须匹配请求的 platform 与 architecture，出现在 dependency-closure manifest 与 digest map 中，并在 bundled Node runtime 下加载。producer 对另一 target 的 optional 或 transitive native module 直接拒绝，不打包 host build。

- [ ] **步骤 1：编写失败的打包内容测试**

为 `verifyDesktopArtifacts` 创建临时伪 release tree 单测。要求 Windows 只接受一个 NSIS setup `.exe` 加一个带 `resources/app.asar` 的 unpacked `.exe`，缺少 setup 时拒绝并输出 `desktop artifact: missing Windows NSIS installer`，缺少 icon 资源时输出 `desktop artifact: missing generated Windows icon`。要求 macOS 识别 universal `.dmg`，对已挂载 app binary 运行 `lipo -info` 并要求同时存在 `x86_64` 与 `arm64`。要求 Linux 同时识别 `.AppImage` 和 `.deb`；缺少产物时必须产生平台专属诊断。

创建 `apps/cli/tests/packed-install.e2e.ts`：运行 `pnpm pack --pack-destination <temp>`，在全新临时 npm prefix 和空 npm cache 中以 `npm install --offline --ignore-scripts <tarball>` 安装，再执行 `<prefix>/bin/harness --help` 与 `<prefix>/bin/dsh --help`。要求均以 0 退出，主命令帮助以 `Usage: harness` 开始，别名以 `Usage: dsh` 开始。在帮助断言前让 installed prefix 中的 Runtime 命令 import 每个 bundled workspace dependency，避免扁平化或意外本地 workspace resolution 通过测试。

创建 `scripts/release/build-cli-standalone.spec.ts`、`apps/cli/tests/standalone-archive.e2e.ts` 和 `scripts/release/verify-cli-standalone.ts`。向 producer 提供 fixture Node distribution 与 packed CLI graph，然后要求同一 source date epoch 的两次运行生成 byte-identical ZIP/tar 输出、精确 `harness-cli-${version}-${platform}-${arch}` 名称、匹配的排序 digest manifest，并拒绝缺少或 hash 不匹配的 Node checksum 或 foreign-architecture `.node` 文件。在每个原生 release runner 上，要求匹配的 `.zip` 和 `.tar.gz` 含平台 Node executable、完整 packaged CLI graph 和两个 command launcher。分别解压到空工作目录，其中 `PATH` 仅保留平台基础项且不含 system Node 所在目录，通过 launcher 运行 `harness --help` 和 `dsh --help`，并要求记录的 `process.execPath` 位于解压的 bundled runtime 内。要求没有 package-manager、registry 或 network invocation。该 archive 测试是 artifact 测试，不是上传授权证据。

先创建 `apps/desktop/tests/installed-artifacts.e2e.ts`。其 fixture 只在临时 `HARNESS_HOME` 中写入 sentinel，启动与 Desktop-host 计划相同的无密钥 Runtime 和 Dashboard，并且只在 Dashboard 认证后消费该计划精确的、脱敏且 process-observable 的 ready acknowledgement。Windows 中静默安装 NSIS 产物到隔离目录，启动其 installed executable，验证 Dashboard 功能和生成图标，静默卸载，并要求 sentinel 保留。macOS 中挂载 DMG，验证 `lipo` 报告两个架构，将 app 拷贝到隔离 Applications 目录，启动后移除该 app copy，并保留 sentinel。Linux 中启动提取/挂载的 AppImage，并把 Deb 安装到隔离 root 后分别启动各 executable；每条路径都必须连接同一 Runtime、认证 Dashboard、显示生成图标，并在移除后保留 sentinel。绝不把 archive inspection 或单独 Electron process 视为已安装产物成功。

- [ ] **步骤 2：运行测试并确认发布验证器不存在**

运行：

```powershell
pnpm exec vitest run apps/desktop/tests/packaged-artifacts.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/packed-install.e2e.ts
```

预期：FAIL，因为 artifact verifier、packed-install fixture 和确定性 standalone producer 不存在，或暴露当前 npm payload 缺陷。

- [ ] **步骤 3：实现产物检查与包 payload 闭包**

实现带平台选择的精确文件名模式和存档/内容检查：NSIS 用 `7z l`，DMG 用 `hdiutil imageinfo`、挂载镜像检查和 `lipo -info`，AppImage 在可用处用 `bsdtar -tf`，Deb 用 `dpkg-deb --contents`。测试 adapter 必须隔离工具调用，fixture 单测不依赖真实安装器；`installed-artifacts.e2e.ts` 拥有真实原生安装/挂载操作。

更新 `apps/cli/package.json` 与 release pack 路径，使 `npm pack --dry-run` 包含所有已构建 `lib/**`、随附 `config/**`，以及 `harness` 和 `dsh` transitively 所需的每份 Runtime asset 与 workspace dependency，同时排除源码、测试、凭据和 Desktop release artifact。不得将 `apps/desktop` 放入 npm payload。从 package metadata 构建显式 dependency-closure manifest，遇到未解析的 `@harness-desktop/*` runtime import 即失败；不得依赖开发 checkout、hoisting 或在线 registry resolution。在宣布包可安装前证明安装 tarball 可在全新 offline prefix 启动。

在 packed dependency closure 存在后实现 `build-cli-standalone.ts`。将该 closure staging 到新 target directory，复制 checksum-verified 的本地 Node distribution 和仅匹配 target 的 native modules，从排序 relative paths 与 SHA-256 digests 生成 `manifest.json`，并在不联系 registry 的情况下写出两种 archive format 与精确 checksum sidecar。launcher 解析同级 bundled Node executable，而不是从 `PATH` 解析 `node`；verifier 在调用两个 help command 前用该 executable 加载每个声明的 native module。保持 producer、archive verifier 与 npm pack verifier 分离，因此 npm packaging 永不成为隐式 archive producer。

- [ ] **步骤 4：添加不发布 release 命令和 CI 证据**

添加先构建、但绝不发布的根命令：

```json
{
  "release:verify-desktop-artifacts": "tsx scripts/release/verify-desktop-artifacts.ts",
  "release:verify-packed-cli": "pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/packed-install.e2e.ts",
  "release:build-cli-standalone": "tsx scripts/release/build-cli-standalone.ts",
  "release:verify-cli-standalone": "tsx scripts/release/verify-cli-standalone.ts",
  "release:smoke-installed-desktop": "pnpm exec playwright test --config apps/desktop/playwright.config.ts apps/desktop/tests/installed-artifacts.e2e.ts"
}
```

在 `.github/workflows/desktop-artifacts.yml` 中明确平台所有权：`windows-2025` 负责 NSIS install/uninstall、Windows ZIP/tar CLI archive 生成后解压和 Windows installer-tile/icon 检查；`macos-15` 负责 universal-DMG mount/copy/uninstall 加 `lipo`、Dock/ICNS 检查和 macOS archive 生成后解压；`ubuntu-24.04` 负责 AppImage 与 Deb mount/install/removal、Linux PNG/SVG 检查和 Linux archive 生成后解压。每个 native job 按顺序运行 `pnpm run generate:icons`、`pnpm run verify:icons`、当前 runner 的 `package`、`release:verify-desktop-artifacts`、`release:verify-packed-cli`、`release:build-cli-standalone`、`release:verify-cli-standalone` 和 `release:smoke-installed-desktop`，并只上传已检查产物、checksum sidecar 和脱敏日志。PR 和常规 smoke workflow 始终使用 `--publish never`；不得 cross-simulate 安装器，也不得添加 `NODE_AUTH_TOKEN`、`npm publish`、`gh release create`、签名凭据、notarization 凭据、update-server 凭据或 environment deployment。

- [ ] **步骤 5：运行源码、打包和平台原生 smoke 验证**

在每个匹配原生 runner 上运行：

```powershell
pnpm run build
pnpm run generate:icons
pnpm run verify:icons
pnpm --filter @harness-desktop/dsh-desktop run package
pnpm run release:verify-desktop-artifacts
pnpm run release:verify-packed-cli
pnpm run release:build-cli-standalone
pnpm run release:verify-cli-standalone
pnpm run release:smoke-installed-desktop
```

预期：源码、构建、unpacked、installed、npm-prefix 与 standalone 层保持彼此独立。Windows 生成 NSIS 并执行隔离 install/uninstall；macOS 生成经 `lipo` 验证的 universal DMG 并执行 mount/copy/removal；Linux 生成并分别启动 AppImage 与 Deb 路径。每个已启动产物都连接 Runtime、认证真实 Dashboard、显示生成图标，并在卸载后保留 `HARNESS_HOME`。全新 offline npm prefix 与每份匹配 standalone archive 都无需开发 checkout import 即暴露两个命令。没有命令发布任何内容。

- [ ] **步骤 6：提交发布 smoke 覆盖**

运行：

```powershell
git add apps/desktop/tests/packaged-artifacts.spec.ts apps/desktop/tests/installed-artifacts.e2e.ts apps/desktop/tests/support/installed-artifact-fixture.ts apps/cli/tests/packed-install.e2e.ts apps/cli/tests/standalone-archive.e2e.ts scripts/release/build-cli-standalone.ts scripts/release/build-cli-standalone.spec.ts scripts/release/node-runtime-checksums.json scripts/release/verify-desktop-artifacts.ts scripts/release/verify-cli-standalone.ts apps/desktop/package.json apps/cli/package.json package.json scripts/run-gates.ts .github/workflows/desktop-artifacts.yml pnpm-lock.yaml
git diff --cached --check
git commit -m "test(release): smoke packaged desktop and CLI artifacts"
```

### 任务 4：在发布验收中消费已完成的公共客户端入口

**文件：**
- 修改：`apps/desktop/tests/installed-artifacts.e2e.ts`
- 修改：`apps/desktop/tests/support/installed-artifact-fixture.ts`
- 修改：`apps/cli/tests/packed-install.e2e.ts`

**接口：**
- 使用：CLI/Web 计划唯一拥有的 parser 和 dispatcher、`InstalledDesktopActivator`、`DesktopNotInstalledError` 与 `runDesktopInvocation`；Foundation Runtime client 的幂等 Web-lease release；以及 Desktop-host 计划精确的、脱敏且 process-observable 的 Desktop-ready acknowledgement。
- 产出：通过这些已完成公共接口调用已安装 `harness`、`harness web --status`、`harness web --stop` 与 `harness desktop` 的发布测试。本任务不得定义 resolver、activator、parser、dispatcher 或 ready type。

- [ ] **步骤 1：编写只消费接口的失败验收测试**

在 installed-prefix 测试中，对无 Runtime 执行 `harness web --status`，要求其既有类型化 `runtime unavailable` 非零结果且不创建文件、lock、endpoint、browser 或 child。对同一 lease 释放后执行两次 `harness web --stop`，要求两次均成功且活跃 terminal session 仍保持 attach。仅对 CLI/Web 计划的 installed-app fixture 执行 `harness desktop`，要求只 activation 一次；其 unavailable fixture 必须渲染该计划的平台 route，且不得创建 Runtime 或 Electron substitute。

在 native installer fixture 中，只在 Runtime attach 和 Dashboard authenticated bootstrap 之后等待 Desktop-host 计划精确的、脱敏且 process-observable 的 acknowledgement。不得通过 recovery preload IPC 检查 project/session 数据，也不得复制 CLI 已安装应用 detection。

- [ ] **步骤 2：在客户端入口完成前运行面向发布的测试**

运行：

```powershell
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/packed-install.e2e.ts
pnpm run release:smoke-installed-desktop
```

预期：直到已完成 CLI/Web 与 Desktop 计划提供其所有权接口、安装器 fixture 消费它们前均为 FAIL。

- [ ] **步骤 3：连接到所有权接口且不改变其行为**

通过 fixture injection 传递完成的 CLI/Web activator 与 parser；不得在 CLI package import Electron，也不得在 Desktop 重做 installed-app probing。把无 lease 的 `web --stop` 视为 Foundation 的幂等成功，不得视为 `background lease unavailable`。原样消费 Desktop 所有的 acknowledgement，仅将其作为同步信号；断言其精确脱敏字段不暴露 endpoint、token、handoff、cookie、path 或 process 字段，且绝不添加 release 所有的 IPC channel 或 readiness type。

- [ ] **步骤 4：验证已安装入口语义**

运行：

```powershell
pnpm run release:verify-packed-cli
pnpm run release:smoke-installed-desktop
```

预期：package 与 native artifact 测试只证明批准的既有命令行为；两者均不成为 routing、app activation 或 Runtime lifecycle 的第二所有者。

- [ ] **步骤 5：提交发布入口消费**

运行：

```powershell
git add apps/desktop/tests/installed-artifacts.e2e.ts apps/desktop/tests/support/installed-artifact-fixture.ts apps/cli/tests/packed-install.e2e.ts
git diff --cached --check
git commit -m "test(release): consume public client entries"
```

### 任务 5：添加跨客户端 Runtime 验收 fixture

**文件：**
- 新建：`apps/cli/tests/cross-client-runtime.e2e.ts`
- 新建：`apps/web/tests/cross-client-runtime.e2e.ts`
- 新建：`apps/desktop/tests/cross-client-runtime.e2e.ts`
- 新建：`packages/test-support/cross-client-runtime/package.json`，包名为 `@harness-desktop/dsh-cross-client-runtime`
- 新建：`packages/test-support/cross-client-runtime/tsconfig.json`
- 新建：`packages/test-support/cross-client-runtime/tsdown.config.ts`
- 新建：`packages/test-support/cross-client-runtime/src/index.ts`
- 新建：`packages/test-support/cross-client-runtime/src/cross-client-fixture.ts`
- 新建：`packages/test-support/cross-client-runtime/src/invariant.ts`
- 新建：`packages/test-support/cross-client-runtime/tests/cross-client-fixture.host.spec.ts`
- 新建：`packages/test-support/cross-client-runtime/README.md`
- 新建：`packages/test-support/cross-client-runtime/README.zh.md`
- 新建：`packages/test-support/cross-client-runtime/README.i18n.yaml`
- 修改：`packages/test-support/README.md`
- 修改：`packages/test-support/README.zh.md`
- 修改：`packages/test-support/README.i18n.yaml`
- 修改：`tsconfig.base.json`
- 修改：`tsconfig.host.json`
- 修改：`vitest.e2e.config.ts`
- 修改：`apps/desktop/playwright.config.ts`

**接口：**
- 使用：`HARNESS_HOME`、Node process/filesystem API、公共 CLI、Web/Desktop 计划提供的已认证 Dashboard DOM/test hook、Electron test-process launch support，以及 CLI/Web 计划的仅测试用途 unpacked activation adapter。`packages/test-support/client-runtime` 仍是 browser-side source-only infrastructure，只可由 Web DOM feature test 使用；该 host package 和 native process fixture 均不得 import 它。
- 产出：host-only `createCrossClientFixture(): Promise<CrossClientFixture>`，具有 `home`、`workspace`、`runCli(args)`、`openWeb()`、`openDesktop()`、`readProjects()`、`readSessions()`、`stopRuntime()`、`dispose()`。其 published Node entry 和 built `lib/` output 是 CLI、Web process 与 Electron e2e runner 所用的唯一 fixture entry。
- 产出：类型化 fixture 观察值 `{ readonly projectId: ProjectId; readonly sessionId: SessionId }`；测试不直接访问 SQLite、lock file 或凭据存储。

- [ ] **步骤 1：编写失败的 host-fixture、共享状态与恢复测试**

在 app test 之前创建 `packages/test-support/cross-client-runtime/tests/cross-client-fixture.host.spec.ts`。以注入的 child-process、filesystem、Runtime-health、Dashboard 与 Electron adapter，要求 host fixture 只创建自己的临时 home/workspace，等待显式脱敏 Runtime-health 响应，并在删除目录前 dispose 它启动的每个 child。要求其 invariant 通过 `started`、`health-confirmed` 和恰好一次 `stopped` lifecycle event 观察每个 owned child；缺少 stop event 必须使 invariant 失败。该测试必须 import Node entry，并拒绝经由 `packages/test-support/client-runtime` 取得 browser compiler face、Node import 或 Electron import。

分别以每个客户端为创建者写同一验收序列：选择一个临时工作区，从创建者新建项目与会话，再要求另外两个客户端看到相同不透明 project/session ID，并向该会话追加可见工作。由 CLI 发起 session operation，要求 Web 的并发 operation 收到带活动 `sessionId` 的 `session busy`，绝不出现第二个 writer。

加入恢复覆盖：由 Desktop 开始工作，只意外终止该客户端进程，验证 CLI 与 Web 保持 Runtime 与会话，然后重新连接 Desktop 并看到同一历史。断言 fixture 输出不含 `HARNESS_HOME` 凭据、访问 token、handoff 密钥或 session cookie 值。

- [ ] **步骤 2：运行测试并确认跨客户端 harness 不存在**

运行：

```powershell
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/cross-client-runtime.e2e.ts apps/web/tests/cross-client-runtime.e2e.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- cross-client-runtime.e2e.ts
```

预期：FAIL，因为已注册的 host fixture 不存在，且客户端尚不能连接一个 Runtime。

- [ ] **步骤 3：注册并实现 host-only public-API fixture**

创建完整的 `packages/test-support/cross-client-runtime` host package：Node `tsconfig.json` 扩展 `../../../tsconfig.base.json`、host `tsdown.config.ts`、为 `.` 与 `./invariant` 提供 exports 的 `package.json`、源码 `index.ts`、`cross-client-fixture.ts` 与 `invariant.ts`、聚焦 host test，以及成对 package README/i18n record。在任一 app test import 之前，向 `tsconfig.base.json` 添加精确的 `@harness-desktop/dsh-cross-client-runtime` 与 `/invariant` source alias，向 `tsconfig.host.json` 添加 project reference，并在成对 `packages/test-support/README*` table 中加入其职责。该 package 没有 client aggregate reference 和 browser entry。

每个测试获得新 `HARNESS_HOME` 与工作区，但只通过终端 JSON protocol、已认证 Dashboard DOM/test hook 和受支持 Runtime test API 观察状态。Desktop project/session 状态从已认证 Dashboard DOM 或该 Runtime test API 读取，绝不从 recovery preload IPC 读取。fixture 等待显式脱敏 Runtime health 响应；不得通过 PID、文件路径或端口扫描推测就绪。清理使用公共 stop/dispose 路径，并在 owned process registry 观察到所有 child exit 后只删除它明确创建的临时目录。

- [ ] **步骤 4：让三个原生客户端测试共享 fixture**

CLI 测试拥有终端 JSON 断言，Web 测试拥有浏览器渲染与 handoff-cookie 行为，Desktop dashboard/recovery 测试拥有 Electron 激活和 renderer isolation。公共项目/会话断言放在 host fixture helper。每个测试都必须证明 Dashboard 与 Desktop 展示真实、已认证应用而非本地 placeholder，并证明一个客户端退出不会终止其他客户端的活动工作。Web DOM-only assertion 可在 browser test 内使用现有 client-runtime helper；process、filesystem、health 或 Electron orchestration 不得回迁到该 client package。

- [ ] **步骤 5：在干净输出树上运行跨客户端验收**

运行：

```powershell
pnpm run clean
pnpm run build
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/cross-client-runtime.e2e.ts apps/web/tests/cross-client-runtime.e2e.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- cross-client-runtime.e2e.ts
```

预期：三个创建者都收敛到一个 Runtime 与持久历史；竞争被拒绝；意外客户端退出可安全恢复；测试输出没有 secret。

- [ ] **步骤 6：提交跨客户端验收覆盖**

运行：

```powershell
git add apps/cli/tests/cross-client-runtime.e2e.ts apps/web/tests/cross-client-runtime.e2e.ts apps/desktop/tests/cross-client-runtime.e2e.ts packages/test-support/cross-client-runtime packages/test-support/README.md packages/test-support/README.zh.md packages/test-support/README.i18n.yaml tsconfig.base.json tsconfig.host.json vitest.e2e.config.ts apps/desktop/playwright.config.ts pnpm-lock.yaml
git diff --cached --check
git commit -m "test(runtime): cover shared clients and recovery"
```

### 任务 6：发布双语安装与共享 Runtime 文档

**文件：**
- 修改：`README.md`
- 修改：`README.zh.md`
- 修改：`README.i18n.yaml`
- 修改：`apps/cli/README.md`
- 修改：`apps/cli/README.zh.md`
- 修改：`apps/cli/README.i18n.yaml`
- 新建：`apps/desktop/README.md`
- 新建：`apps/desktop/README.zh.md`
- 新建：`apps/desktop/README.i18n.yaml`
- 修改：`docs/user/guide/index.md`
- 修改：`docs/user/guide/index.zh.md`
- 修改：`docs/user/guide/index.i18n.yaml`

**接口：**
- 使用：已验证 CLI grammar、数据根目录行为、Foundation 拥有的 legacy detection/result 和持久用户 decision state、Desktop 安装器名称和公共类型化错误。
- 产出：英文和简体中文 quick start，涵盖全局安装、源码执行、`harness`、`harness web`、`harness desktop`、共享本地根目录/import、Web daemon/status/stop、Windows/macOS/Linux 安装/卸载，以及三个客户端可见的首次 legacy-import decision。

- [ ] **步骤 1：编写失败的文档断言**

扩展 `scripts/product-identity.spec.ts` 或新增 `scripts/runtime-release-docs.spec.ts`，要求两份根 README 都包含 `npm install -g @harness-desktop/cli`、`harness`、`harness web --daemon`、`harness web --status`、`harness web --stop`、`harness desktop`、`HARNESS_HOME`、`DSH_HOME`、`dsh`、`NSIS`、`DMG`、`AppImage`、`Deb`。要求两种语言都说明 `npm publish` 与 GitHub Release 创建需要明确批准。

- [ ] **步骤 2：运行文档测试并确认当前说明已过期**

运行：

```powershell
pnpm exec vitest run scripts/product-identity.spec.ts scripts/runtime-release-docs.spec.ts
```

预期：FAIL，因为当前 README 描述固定 Web port 和 profile-only 行为，而非统一本地 Runtime 命令与生命周期。

- [ ] **步骤 3：围绕三个客户端重写根 quick start**

在两份根 README 中以全局安装开始：

```sh
npm install -g @harness-desktop/cli
harness
harness "fix the failing tests"
harness web
harness desktop
```

记录 `harness run "task" --json`、`harness web --daemon`、`harness web --background --no-open`、`harness web --status`、`harness web --stop`。说明三个客户端共用本地 Runtime 与 `HARNESS_HOME`；给出精确平台默认值。不得把 legacy import 写成静默 helper：消费 Foundation detection/result 和 decision record 作为真源，并说明首次启动 offer、明确的用户 accept/reject、记录的 decision/outcome、collision correction/retry，以及保留双方 `DSH_HOME` 与 `HARNESS_HOME` 的 failure。

- [ ] **步骤 3a：规定三个客户端可见的 legacy-import 流程**

对于 interactive CLI，当 Foundation 报告已检测 legacy root、未决 decision 且 target 为空时，在正常 session entry 前渲染首次 offer：`Import supported data from DSH_HOME into HARNESS_HOME? [y/N]`。`y` 调用 Foundation import operation 并打印类型化结果；`N` 经 Foundation decision path 记录拒绝并以空 target 继续。`target-not-empty` collision 输出 correction，保持双方 root 不变，并在用户清空或选择另一个 `HARNESS_HOME` 后给出明确 retry；`{ kind: 'failed', retained }` 只输出脱敏 diagnostic identifier 与 retained-root 提示，绝不删除任一 root。

对于 Web，已认证 Dashboard 的首次启动 screen 在 workspace selection 前显示同一已检测 source/empty-target offer。其 Import 与 Not now control 通过受支持 Runtime API 提交 Foundation decision，随后渲染 imported、rejected、collision 或 failure record。collision view 在修正后提供 Retry；它绝不执行 client-side copy。浏览器 reload 读取持久 decision/result，不得对已完成或已拒绝 import 再次 offer。

对于 Desktop，Dashboard authentication 后的真实 Dashboard 渲染同一首次启动 card；Desktop Main 与 recovery preload 不实现迁移也不暴露 legacy path。接受、拒绝、collision/retry 与 failure 使用上面的已认证 Dashboard 流程。安装器和 recovery 测试断言可见 Dashboard state 与 Foundation-recorded outcome，而不是 filesystem inspection 或 recovery IPC。

- [ ] **步骤 4：添加平台安装、卸载与发布边界**

只记录已验证路径：Windows 运行下载的 NSIS setup，通过 Installed Apps 或 NSIS uninstaller 卸载；macOS 打开 universal DMG、将 Harness Desktop 移到 Applications、从 Applications 移除以卸载；Linux 用发行版 package manager 安装 `.deb`，或先赋可执行权限后运行 AppImage，再移除选用的 artifact/package 卸载。说明卸载应用不会删除 `HARNESS_HOME`；将备份或删除作为明确独立操作展示。不得把 application uninstall 叙述为接受、拒绝、完成或删除 legacy import。

把 CLI package contract 细节保留在 `apps/cli/README*`，Desktop build/installer contract 细节保留在 `apps/desktop/README*`，面向产品的步骤留在 `docs/user/guide/*`，以链接替代重复。每个 pair 完成后运行 `verify-translation-pairing --write` 刷新所有列出的 `.i18n.yaml`。

- [ ] **步骤 5：运行文档与链接验证**

运行：

```powershell
pnpm run verify-translation-pairing --write README.md
pnpm run verify-translation-pairing --write apps/cli/README.md
pnpm run verify-translation-pairing --write apps/desktop/README.md
pnpm run verify-translation-pairing --write docs/user/guide/index.md
pnpm exec vitest run scripts/product-identity.spec.ts scripts/runtime-release-docs.spec.ts
pnpm run doc-sync
git diff --check
```

预期：四个 pair 都已记录且通过；文档测试、链接、换行和站点构建通过。

- [ ] **步骤 6：提交双语发布指南**

运行：

```powershell
git add README.md README.zh.md README.i18n.yaml apps/cli/README.md apps/cli/README.zh.md apps/cli/README.i18n.yaml apps/desktop/README.md apps/desktop/README.zh.md apps/desktop/README.i18n.yaml docs/user/guide/index.md docs/user/guide/index.zh.md docs/user/guide/index.i18n.yaml scripts/product-identity.spec.ts scripts/runtime-release-docs.spec.ts
git diff --cached --check
git commit -m "docs: explain Harness installation and shared Runtime"
```

### 任务 7：实现本地 Desktop 与 standalone CLI 更新和回滚

**文件：**
- 新建：`packages/host/local-runtime/src/update-preferences.ts`
- 新建：`packages/host/local-runtime/tests/update-preferences.spec.ts`
- 修改：`packages/host/local-runtime/src/runtime-client.ts`
- 修改：`packages/host/local-runtime/src/control-service.ts`
- 新建：`apps/desktop/src/main/update/channel.ts`
- 新建：`apps/desktop/src/main/update/manifest.ts`
- 新建：`apps/desktop/src/main/update/staged-install.ts`
- 新建：`apps/desktop/src/main/update/service.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 新建：`apps/desktop/tests/desktop-updater.spec.ts`
- 新建：`apps/desktop/tests/desktop-updater.e2e.ts`
- 新建：`apps/desktop/tests/support/update-fixture.ts`
- 新建：`apps/cli/src/update.ts`
- 修改：`apps/cli/src/command.ts`
- 新建：`apps/cli/tests/update.e2e.ts`
- 修改：`apps/desktop/package.json`
- 修改：`apps/cli/package.json`
- 修改：`package.json`
- 修改：`scripts/run-gates.ts`

**接口：**
- 使用：Foundation Runtime 的唯一 writer settings service、Desktop-host 计划精确的、脱敏且 process-observable 的 Desktop-ready acknowledgement、任务 3 的 packaged artifact name，以及编译进程序的 update-manifest public-key allowlist。Desktop Main 拥有 fetch、signature/digest validation、staging、install handoff 和 rollback orchestration；channel selection 保持为已认证 Dashboard application setting，Main 只报告脱敏 native status，绝不暴露 manifest URL、token、staging path 或 signing key。
- 产出：`DesktopUpdateChannel = 'stable' | 'beta' | 'nightly'`；Foundation 所有的 `RuntimeClient.getDesktopUpdateChannel()` 与 `RuntimeClient.setDesktopUpdateChannel(channel)` 通过 Runtime settings service 持久化该选择，不使用 Electron user data。`RuntimeClient.recordDesktopUpdateOutcome(...)` 只记录脱敏 version/channel/outcome 和 last-known-good version；绝不记录 URL、token、manifest body 或 installation path。
- 产出：`DesktopUpdateService.checkAndStage(): Promise<DesktopUpdateResult>` 与 `applyStagedUpdate(): Promise<DesktopUpdateResult>`。结果仅为带稳定脱敏 code 的 `up-to-date`、`staged`、`applied`、`rolled-back` 或 `failed`。service 只接受 selected channel 中较新的 artifact，唯一例外是显式回滚到保留的、兼容的先前 stable version。它验证 HTTPS allowlisted origin、channel、精确 version、platform/architecture、signature、SHA-256 digest、archive member path 和 staged executable，然后保留 current version、stage candidate 并请求 restart。
- 产出：按 install form 唯一所有者划分的 `harness update` 行为。npm-installed CLI 报告 `managed-by-npm` 和精确 package-manager command，绝不编辑其 installation。standalone archive 通过同一 signed-manifest/digest policy 验证、stage、health-check、atomically switch 至并可 restore 自己匹配的 CLI archive；它绝不调用 npm 或 self-update npm prefix。

- [ ] **步骤 1：编写失败的 updater、malicious-manifest、health、rollback 和 CLI-form 测试**

创建 `packages/host/local-runtime/tests/update-preferences.spec.ts`，证明 update-channel selection 与脱敏 outcome 由 Runtime settings service 串行化，且不能创建私有 Desktop persistence writer。创建带本地 fake HTTPS/download、signature、installer 与 process adapter 的 `apps/desktop/tests/desktop-updater.spec.ts`。拒绝 bad signature 或 checksum、non-HTTPS/non-allowlisted URL、path traversal archive member、错误 platform/architecture、channel mismatch、duplicate version、downgrade、cross-channel rollback，以及尝试替换保留 current artifact 的 manifest。要求有效的 stable、beta 和 nightly manifest 只选择各自 channel 中较新的 artifact。

创建带真实 packaged-app launch fixture 的 `apps/desktop/tests/desktop-updater.e2e.ts`。保留 current version，stage 已验证 candidate，restart 它，并且仅在 authenticated Dashboard boot 后收到 Desktop-host 计划不变的、脱敏且 process-observable acknowledgement 时接受它。要求缺失、malformed 或 failure acknowledgement 将 candidate 标记为 failed、restart 保留 version、通过 Runtime settings 记录脱敏 rollback outcome，并保留 `HARNESS_HOME`。创建带 npm-prefix fixture 和 extracted archive fixture 的 `apps/cli/tests/update.e2e.ts`：npm 报告 `managed-by-npm` 而不修改文件或运行 package manager；archive 在提供其本地 manifest/download fixture 后完成 verified stage/switch/health/rollback，且不使用 system Node、npm 或 network。

- [ ] **步骤 2：运行聚焦测试并确认 updater 不存在**

运行：

```powershell
pnpm exec vitest run packages/host/local-runtime/tests/update-preferences.spec.ts apps/desktop/tests/desktop-updater.spec.ts apps/cli/tests/update.e2e.ts
pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- desktop-updater.e2e.ts
```

预期：FAIL，因为不存在 Runtime 所有的 channel/outcome API、Desktop Main updater、staged health/rollback 行为或按 install-form 区分的 CLI update path。

- [ ] **步骤 3：实现本地 signed update、staged health 和 rollback 所有权**

先添加 Runtime setting/control implementation，使 selected channel 和脱敏 result 使用现有共享 Runtime 并在 client restart 后保留。在 Desktop Main 中将 manifest 解析为精确 allowlisted schema，在 extraction 前验证 detached signature 和 SHA-256，写入前拒绝 unsafe member，并在 candidate 启动且 authenticated Dashboard boot 后收到 Desktop 所有 acknowledgement 前保持运行中的 artifact 不变。仅在该 acknowledgement 后 commit candidate；否则记录 failed version、restore retained executable，并只暴露稳定脱敏 failure/rollback result。manual rollback 选择保留的兼容先前 stable artifact，并遵守同一 staged verification 和 acknowledgement 规则。

在 install-form detection 后实现 `harness update`：npm path 打印 managed command 并无 mutation 退出；standalone path 使用 bundled Node、target-specific archive manifest 和 sibling replacement adapter。它在 atomic switch 前验证同一 channel、version、signature、digest 和 native module target，随后通过新 bundled runtime 启动 `harness --help` 作为 CLI health check，并在失败时 restore retained archive。不得添加 background updater、direct renderer filesystem access、新的 ready IPC channel、secret-bearing diagnostic 或未经验证的 downgrade。

- [ ] **步骤 4：添加不发布 updater 命令和聚焦证据**

添加等价的根命令：

```json
{
  "release:verify-update-manifests": "tsx scripts/release/verify-update-manifests.ts",
  "desktop:test-updater": "pnpm --filter @harness-desktop/dsh-desktop run test:e2e -- desktop-updater.e2e.ts",
  "release:test-cli-update": "pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/update.e2e.ts"
}
```

使 updater test 只使用 local fixture 和 fake key。它们可以验证 local test server 产生的 manifest 或 downloader，但绝不 sign release、upload manifest、publish npm、notarize 或创建 release。将聚焦命令加入 archive production 之后、任何 release-candidate workflow action 之前的 release gate。

- [ ] **步骤 5：运行源码、构建、打包和 rollback 验证**

运行：

```powershell
pnpm run build
pnpm run release:build-cli-standalone
pnpm run release:verify-update-manifests
pnpm run release:test-cli-update
pnpm run desktop:test-updater
```

预期：源码和构建 Desktop path 拒绝 malicious manifest，staged install 在 authenticated Dashboard boot 后证明精确 Desktop acknowledgement，failed candidate rollback 时不删除 `HARNESS_HOME`，npm installation 保持 package-manager-owned，standalone archive 通过其 bundled runtime 更新/回滚。没有命令 sign、upload、publish 或创建 release。

- [ ] **步骤 6：提交本地 updater 和 rollback 覆盖**

运行：

```powershell
git add packages/host/local-runtime apps/desktop/src/main apps/desktop/tests apps/cli/src/update.ts apps/cli/src/command.ts apps/cli/tests/update.e2e.ts apps/desktop/package.json apps/cli/package.json package.json scripts/run-gates.ts pnpm-lock.yaml
git diff --cached --check
git commit -m "feat(release): stage verified local updates with rollback"
```

### 任务 8：运行发布验收，然后只 push 已验证改动

**文件：**
- 修改：`.github/workflows/desktop-artifacts.yml`
- 修改：`scripts/run-gates.ts`
- 新建：`.github/workflows/release-candidates.yml`
- 修改：`scripts/release/verify-update-manifests.ts`
- 修改：`scripts/release/verify-update-manifests.spec.ts`
- 验证：`assets/brand/harness-icon.svg`
- 验证：`apps/desktop/release/`
- 验证：`apps/cli/package.json`
- 验证：`README.md`
- 验证：`README.zh.md`

**接口：**
- 使用：任务 1–7 的源码、构建、打包、已安装和本地 staged-update 检查。
- 产出：一个不发布的 pull-request release-smoke workflow、stable/beta/nightly update channel 的本地 signed-manifest fixture、驱动任务 7 Desktop/CLI consumer 的 rollback verification，以及独立的 approval-gated release-candidate workflow。已验证分支可 `git push`，但不可公开发布。

- [ ] **步骤 1：编写失败的 release-smoke workflow 断言**

扩展 Desktop release workflow 测试或 `scripts/desktop-release-config.spec.ts`，要求每个原生 runner 运行 `generate:icons`、`verify:icons`、desktop package、`release:verify-desktop-artifacts`、packed CLI verification、standalone archive production 后 verification、任务 7 updater check 和平台适用的 Desktop smoke。要求 pull-request workflow 不含 `npm publish`、`gh release create`、signing、notarization 或 update-manifest upload。扩展 `scripts/release/verify-update-manifests.spec.ts`，包含 stable、beta、nightly signed-manifest fixture：每份只含预期 channel artifact name、version ordering、checksum、signature reference 与 rollback predecessor。要求 downgrade/rollback fixture 选择上一份兼容 signed stable artifact，而不是 beta 或 nightly build，并驱动任务 7 staging consumer；测试使用 fake signature，绝不联系 release service。

- [ ] **步骤 2：运行 workflow 检查并观察缺失的端到端覆盖**

运行：

```powershell
pnpm exec vitest run scripts/desktop-release-config.spec.ts
```

预期：在 workflow 执行全部源码、构建、打包、安装、offline-prefix、standalone、staged-update 与 rollback 验收层，且每个 update-channel fixture 都完成 signed-manifest 与 consumer validation 前均为 FAIL。

- [ ] **步骤 3：添加不发布 release smoke workflow**

在 `windows-2025`、`macos-15` 和 `ubuntu-24.04` 上，使用 frozen pnpm installation，构建仓库，生成并验证图标，只以 `--publish never` 打包当前 native target，检查其产物，安装并运行 packed CLI，构建后验证全新 offline standalone archive，运行隔离的 Desktop Dashboard-to-Runtime smoke，并运行任务 7 的本地 staged update/rollback fixture。Windows 负责 NSIS install/uninstall，macOS 负责 universal-DMG mount/copy/uninstall 加 `lipo`，Ubuntu 负责 AppImage 和 Deb install/removal；任何 job 都不得将其他平台的 archive inspection 视为 native evidence。上传已检查产物和脱敏日志。workflow 权限设为 `contents: read`；不得配置 signing、notarization、npm 凭据、publication、update upload 或 GitHub Release creation。

新建独立、手动 dispatch 的 `release-candidates.yml` workflow，其中每项外部操作都要求明确 `approval` input：`sign-windows`、`notarize-macos`、`sign-update-manifests`、`publish-npm`、`create-github-release`。它拒绝空白或合并 approval，所有 action 默认 false，且绝不在 pull request 运行。stable、beta、nightly 选择不同的 immutable channel label 和 update-manifest location；全部消费同一个已验证 artifact matrix。signing/notarization 仅在其匹配 approval 后产出 channel-specific signed update manifest，上传前对 fixture 验证 signature，并保留上一份 signed stable manifest/artifact 作为 rollback target。`npm publish` 与 GitHub Release creation 各自需要新提交的 approval，且只在 package、native artifact、signature、update-manifest 和 rollback verification 后运行。rollback dispatch 选择保留的上一份 signed stable release，不发布新 package，也不修改 `HARNESS_HOME`。

- [ ] **步骤 4：运行与变更表面相符的最终本地检查**

运行：

```powershell
pnpm run generate:icons
pnpm run verify:icons
pnpm exec vitest run scripts/generate-product-icons.spec.ts scripts/desktop-release-config.spec.ts apps/desktop/tests/icon-assets.spec.ts apps/desktop/tests/packaged-artifacts.spec.ts apps/web/tests/pwa-manifest.e2e.ts scripts/product-identity.spec.ts scripts/runtime-release-docs.spec.ts
pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/built-bin.e2e.ts apps/cli/tests/packed-install.e2e.ts apps/cli/tests/cross-client-runtime.e2e.ts apps/web/tests/cross-client-runtime.e2e.ts
pnpm run build
pnpm run desktop:e2e
pnpm --filter @harness-desktop/dsh-desktop run package
pnpm run release:verify-desktop-artifacts
pnpm run release:verify-packed-cli
pnpm run release:build-cli-standalone
pnpm run release:verify-cli-standalone
pnpm run release:smoke-installed-desktop
pnpm run release:verify-update-manifests
pnpm run release:test-cli-update
pnpm run desktop:test-updater
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

预期：每条命令在支持的本地平台上以 0 退出。另两个操作系统的原生安装器由要求的原生 CI runner 验证，不能从 Windows 模拟。update-manifest 测试仅通过 local consumer 与 fixture 证明 stable/beta/nightly routing、malicious-manifest rejection、staged acknowledgement 和 rollback；本地或 PR 命令不得 signing、notarize、upload、publish 或创建 release。

- [ ] **步骤 5：审查最终 diff 并 push 已验证分支**

运行：

```powershell
git status --short
git diff --check
git log --oneline --decorate codex/harness-desktop-design..HEAD
git push -u origin HEAD
```

预期：工作树除 Git 忽略的刻意本地 release artifacts 外干净；只在步骤 4 成功后 push。push 后停止。不得运行 signing、notarization、update upload、`npm publish`、`pnpm run release:publish` 或 `gh release create`；每项外部操作均要求其单独更新的明确批准。

## 计划自检

- 规格覆盖：任务 1–2 实现原创可编辑 B 图稿、原生图标 provenance 与刻意仅限 Web 的明暗 favicon pair；任务 2–3 实现 NSIS、universal DMG、AppImage、Deb、npm dependency-closure/offline-prefix 检查、确定性 standalone Node archive 和 target-native module check；任务 4 消费而非重定义主 CLI/Desktop 入口和 Desktop 所有的 ready acknowledgement；任务 5 通过 host-side test package 证明共享 Runtime 状态和安全客户端恢复；任务 6 提供双语安装、生命周期和可见 legacy-import 说明；任务 7 实现本地 channel selection、verified staging、health acknowledgement、rollback 和 npm-versus-archive CLI update；任务 8 在授权 push 前验证原生产物和 approval-gated stable/beta/nightly release workflow。
- 错误覆盖：过期生成资产、无效 Builder icon 路径、缺少原生安装器/icon、Runtime 不可用、无 lease 的幂等 release、未安装 Desktop、并发 session 使用、legacy-import collision/retry/failure、dependency closure、缺少或不匹配的 bundled Node、foreign native module、malicious update manifest、failed update acknowledgement 和 rollback 都有命名预期诊断或所属测试。
- 类型一致性：生成资产名称、`desktopIconPath`、`verifyDesktopArtifacts`、CLI/Web 拥有的 activation interface、Desktop-host 计划精确的 ready acknowledgement、`CrossClientFixture`、`DesktopUpdateChannel` 和 `DesktopUpdateService` 都只从各自所有者计划消费。
- 占位符扫描：没有延后实施标记；每项任务均指定精确文件、接口、RED/GREEN 检查与验证命令。

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-08-18-harness-icon-packaging-docs.zh.md`。使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项执行；没有本操作对应的单独新批准，不得 signing、notarize、upload update manifest、发布 npm 或创建 GitHub Release。
