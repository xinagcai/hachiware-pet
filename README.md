# 小八 · Hachiware desktop pet

> English: [README.en.md](README.en.md)

小八是只浮在桌面上的宠物，看着 DeepSeek Harness 干活：有会话在跑就呼吸，有工具调用等你审批就变琥珀色、弹气泡、响一声。

它不是渲染在 Harness 窗口里的组件，而是一个独立的小窗（透明、置顶、可拖到屏幕任何位置）。插件只负责**把状态写成文件**，窗口由一支原生小应用持有：macOS 是 Swift/AppKit，Windows 是 C#/WebView2，两边的页面、状态文件、消息协议完全相同。

## 数据流

```
Harness 会话服务                    插件宿主半                  原生小窗
┌──────────────────┐        ┌────────────────────┐      ┌─────────────────────┐
│ ctx.sessions.list│──读───▶│ index.js           │      │ helper/main.swift   │
│ ctx.agents.get() │        │  snapshot() 1.2s   │写    │  poll 0.45s         │
│ session/event    │──事件─▶│  state.json        │─────▶│  → window.__petState│
│ approval/asked   │        │  build + spawn     │      │  WKWebView          │
└──────────────────┘        └────────────────────┘      │   ↓                 │
                                                        │ pet/renderer.js     │
                                                        │   精灵帧动画/面板    │
                                                        └─────────────────────┘
```

为什么分成两半：profile 插件运行在桌面壳的 `ELECTRON_RUN_AS_NODE` 子进程里，拿不到 `electron` 模块，开不了 `BrowserWindow`；而 Harness 的桌面壳又不接收“开个置顶窗”这类请求。所以只能由插件写文件、另起一个自己编译的 App 去画窗口。

## 文件

| 文件 | 作用 |
| --- | --- |
| [index.js](index.js) | 宿主半（298 行）。`inject = ['sessions','agents']`；`snapshot()` 把会话、耗时、待审批拼成 JSON，原子写 `state.json`；源文件比二进制新时调 `build.sh` 重编，然后 `spawn` helper；`ctx.effect` 负责退出时清理。 |
| [helper/main.swift](helper/main.swift) | 原生窗（411 行）。`NSPanel` + `WKWebView`：透明、无边框、`.floating`、跟随所有 Space；每 120ms 读鼠标位置判断命中区，决定是否 `ignoresMouseEvents`；处理 `drag`/`park`/`focusHarness`/`hitbox` 消息；每 0.45s 读状态文件注入页面；父进程死了就退出。 |
| [helper/build.sh](helper/build.sh) | 编译脚本。拷页面 → `swiftc` 编出 `HachiwarePet.app`；`HACHIWARE_PET_UNIVERSAL=1` 时编出 arm64+x86_64 通用二进制并 ad-hoc 签名。 |
| [helper/bin/HachiwarePet.app](helper/bin/HachiwarePet.app) | **发布用预编译产物**：通用二进制、已签名。用户机器不需要安装 Swift；源码比二进制新时才会本地重编。 |
| [pet/index.html](pet/index.html) | 透明舞台，加载 `renderer.js`。内含呼吸、弹跳等 CSS 动画。 |
| [pet/renderer.js](pet/renderer.js) | 页面逻辑：接收 `window.__petSkinApply` 注入的皮肤、精灵帧推进、状态→表情映射、会话面板、提示音、拖动、命中区上报。 |
| `~/Library/Application Support/dsh-hachiware-pet/skins/` | 运行时皮肤目录：`current.json` 记网格与心情行，每个皮肤一个子目录。helper 读盘后以 data URL 注入页面（`file://` 页面不能直接引用外部图片）。 |
| [helper-win/](helper-win) | Windows 原生窗（C# + WebView2）：透明置顶、点击穿透、拖动、注入状态与皮肤；`build.ps1` 输出 `helper/bin/win/HachiwarePet.exe`。 |
| [pet/skins/hachiware-2/](pet/skins/hachiware-2) | 开发用素材（**不进发布包**）：`pet.json`、1536×1872 的 `spritesheet.webp`、`skin.json`。首次运行会复制到运行时皮肤目录。 |

## 精灵动画怎么算

小八的图是 8 列 × 9 行、每格 192×208，但**每一行并不都填满 8 格**（待机 6 帧、挥手 4 帧……）。所以：

```js
framesForRow(row)  // skin.json 手填 > 构建实测 > canvas 兜底
paintSprite()      // frame = spriteFrame % framesForRow(spriteRow)
                   // backgroundPosition = -(frame*76)px -(row*76)px
startSprite()      // 每 1000/fps 毫秒推一帧
```

如果按 8 帧循环，就会走进全透明的空帧，表现就是“一闪一闪”。所以 `current.json` 里没有 `frames` 时，helper 用 CGImage 逐格采样 alpha 自己量一遍（日志 `skin frames: ...`）；`skin.json` 手写的值优先级最高。实测结果是 `[6,8,8,4,5,8,6,6,6]`。

状态到行的映射在 `pet/skins/hachiware-2/skin.json` 的 `moods` 里，改表情不用碰代码。

## 窗口交互

- **拖动**：页面把指针位移以 `drag(dx, dy)` 发给 Swift，后者移动面板并钳制在屏幕可见区域内，停靠位置防抖写 `position.json`。
- **点击穿透**：页面把宠物和面板的矩形上报（`hitbox`），helper 全局轮询鼠标，只有指针进入矩形时才让窗口接收鼠标，其余区域点击直接落到底下的应用。
- **面板**：单击宠物打开，列出各会话标题与状态（待审批在前）。因为它是独立窗口，点行只能把 Harness 窗口带到前台，不能在窗口间跳转会话。
- **回到 Harness**：helper 的父进程是 `ELECTRON_RUN_AS_NODE` 下的 Node 子进程，不是 GUI 应用，所以它先用 `sysctl` 取父进程的父进程，才拿到 `DeepSeek Harness`（bundle id `com.deepseek.dsh`）再 `activate`；插件也会通过 `DSH_HACHIWARE_PET_APP_PID` 直接传应用 pid，两条路互为兜底。

## Windows

原生层有两个实现，页面和状态协议共用一套：

| | macOS | Windows |
| --- | --- | --- |
| 窗口 | `helper/main.swift`（AppKit `NSPanel` + `WKWebView`） | `helper-win/Program.cs`（WinForms + `WebView2`） |
| 产物 | `helper/bin/HachiwarePet.app`（预编译通用二进制，随包发布） | `helper/bin/win/HachiwarePet.exe`（预编译，随包发布） |
| 点击穿透 | `ignoresMouseEvents` | `WS_EX_TRANSPARENT` |
| 数据目录 | `~/Library/Application Support/dsh-hachiware-pet/` | `%APPDATA%\dsh-hachiware-pet\` |

Windows 版本的差异：

- **构建**：发布包已带编译好的 `helper/bin/win/HachiwarePet.exe`（1.2 MB，框架依赖），普通用户无需 SDK。改 C# 后重新出包：在装了 .NET 8 SDK 的机器上 `powershell -NoProfile -ExecutionPolicy Bypass -File helper-win\build.ps1`；加 `-SelfContained` 可编出免运行时的单文件（约 70 MB）。宿主发现 exe 缺失时也会自动跑这个脚本。
- **运行时**：框架依赖版需要 .NET 8 **Desktop** Runtime（`winget install Microsoft.DotNet.DesktopRuntime.8`，缺失时 Windows 会弹下载提示）；WebView2 运行时 Win11 自带，Win10 一般随 Edge 已有。
- **皮肤**：Windows 侧把 `current.json` + 精灵图读成 data URL 注入，**不传帧数**——`data:` 图片在 Chromium 里不会污染 canvas，页面自己逐格采样量帧数；macOS 因为 `file://` 画布被污染，改由 Swift 用 CGImage 量。
- **回前台**：直接对宿主传来的应用 pid 与父进程 pid 尝试 `SetForegroundWindow`，失败再按进程名 `DeepSeek Harness` 找主窗口。

## 安装

已发布到 npm：`hachiware-pet`

- **图形界面**：Plugins → Add plugin → 填 `hachiware-pet`
- **本地开发**：Plugins → Add plugin → 选这个目录（软链，改页面立即生效；宿主 `index.js` 改动需重启应用一次）

装完会在屏幕右下角出现小八；首次运行点面板里的「＋ 新皮肤」下载一套精灵图皮肤。

运行期文件都在 `~/Library/Application Support/dsh-hachiware-pet/`：

- `state.json`：当前会话快照（可 `tail` 观察），含 `skin` 段
- `position.json`：小八停靠位置
- `skins/`：运行时皮肤目录（`current.json` + 每套皮肤一个子目录）
- `command.json`：页面向宿主投递的命令（点「＋ 新皮肤」或皮肤圆片时出现，读完即删）
- `install.log`：petdex 安装的完整输出
- `helper.log`：helper 的日志（排查首选）
- `helper/build.log`：编译输出

## 皮肤从哪来

发布包**不带皮肤**：Chiikawa 素材不好再分发。第一次跑起来只有内置的简笔小八，面板里会出现「＋ 新皮肤」按钮：

1. 点「＋ 新皮肤」→ 页面把 `{"action":"new-skin"}` 写进 `command.json`；
2. 宿主每 1.2s 轮询，取 Petdex 的皮肤库清单（`https://petdex.dev/api/manifest/v2`，5000+ 只，缓存一天在数据目录的 `petdex-catalog.json`），随机挑一只还没装过的（优先 8×11 的 v2 素材）；
3. 跑 `npx --yes petdex@latest install <slug>`（npm 缓存放在数据目录里），成功后复制到运行时皮肤目录并切成当前皮肤；
4. 下一次状态推送带上新的 `skin.version`，helper 读图后以 data URL 注入页面。

失败不弹错：继续用当前皮肤，按钮 title 和 `helper.log` 里能看到原因，petdex 的完整输出在 `install.log`。

装过的皮肤都留在 `~/Library/Application Support/dsh-hachiware-pet/skins/`，面板底部那行小圆片就是它们：

- 点某个圆片 → 页面写 `{"action":"switch-skin","slug":"..."}`，宿主改 `current.json`，helper 重新注入，**离线也能切**；
- 高亮的那片 = 当前皮肤。

本地开发目录里带了 `pet/skins/hachiware-2`，首次运行会自动 seed 到运行时目录。

## 换皮（手动）

1. `npx petdex@latest install <slug>`，素材在 `~/.petdex/pets/<slug>`
2. `cp -R ~/.petdex/pets/<slug> ~/Library/Application\ Support/dsh-hachiware-pet/skins/<slug>`
3. 面板里那排圆片只占一行，横向滑动（鼠标按住拖 / 滚轮）就能看到全部；点圆片切换
4. 圆片右侧的 `×` 两下删除一套皮肤（第一下变「删?」确认，2.5 秒后还原）；删掉当前这套会自动切到剩下一套，全删光就退回简笔小八
5. 也可以直接改 `skins/current.json` 的 `slug`（`moods` 没有就删掉让 helper 重新生成）

开发期换：把素材放进 `pet/skins/<slug>/`，删掉运行时目录的 `current.json` **和 `.seeded`**，重启 Harness —— 宿主会重新 seed（`.seeded` 存在时不再 seed，这样用户删光皮肤后不会被塞回来）。

行数不齐也没关系：帧数由 helper 实测（`skin frames: ...` 日志），`skin.json` 里写死会优先生效。

## 验证发布包

不想相信"装得上"，可以直接跑一遍。脚本从 npm 下载真实的 tarball，在临时目录里逐层验，不写你机器上任何位置：

```sh
npm run verify            # 验 npm 上的 latest
npm run verify -- 0.2.2   # 验指定版本
```

检查顺序：下载 → sha1 与 registry 比对 → 解包核对文件数/必备文件/不含素材 → JS 与 JSON 解析 → 宿主半用假 ctx 跑一遍确认写出 `state.json` → macOS 上再启动包内原生壳、确认 `page finished` 并产出截图。全过输出 `16/16 checks passed`，任何一条失败都会指出是哪层。

## 发布（npm + 插件市场）

1. 改 `package.json`：`name` 换成自己的包名、去掉 `"private": true`、`version` 从 `0.1.0` 起
2. `npm pack --dry-run` 确认清单：**不含** `pet/skins`、`helper/bin`，只有源码与页面
3. `npm publish --access public`
4. 到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 PR 加一条目，市场与站点约一天内收录

发布包里带的是编好的通用二进制（arm64 + x86_64，ad-hoc 签名）：

```sh
HACHIWARE_PET_UNIVERSAL=1 sh helper/build.sh   # 发布前重编
file helper/bin/HachiwarePet.app/Contents/MacOS/HachiwarePet
# Mach-O universal binary with 2 architectures: [x86_64] [arm64]
```

用户机器**不需要** Xcode Command Line Tools。开发机才需要（源码改动后会本地重编）。

两点注意：

- npm 会把包内文件 mtime 统一成 1985 年，所以安装后「源码比二进制新」不成立，不会触发重编；开发时改了 `main.swift` 才会。
- ad-hoc 签名足够运行（npm 安装的文件没有 quarantine 属性）。如果以后改成下载 `.zip` 分发，需要 Developer ID 签名 + 公证，否则会被 Gatekeeper 拦。
