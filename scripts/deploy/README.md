# macOS 常驻部署（源码 + launchd）

适合把 Codex Proxy 长期跑在一台 Mac（如 Mac mini）上：开机/登录自动启动、崩溃自动拉起，
并且可以直接沿用桌面版（DMG）已有的账号数据和 TLS 原生组件。

脚本：[`scripts/deploy/macos.sh`](./macos.sh)

## 一次性安装

```bash
git clone https://github.com/<你的账号>/codex-proxy.git ~/codex-proxy
cd ~/codex-proxy
scripts/deploy/macos.sh install          # 仅本机访问
# 或
scripts/deploy/macos.sh install --lan    # 允许局域网其它设备访问
scripts/deploy/macos.sh install --switch # 桌面版正在提供服务时：空闲后无缝接管（见下文）
```

`install` 会依次：

1. **检查 Node.js 22.13+**，没有时可选择用 Homebrew 安装（`-y` 自动同意）。
2. **确认桌面版没在运行**——两者默认都用 8080 端口和同一套数据，请先退出桌面版，并在
   「系统设置 → 通用 → 登录项」中关闭它的开机启动。使用 `--switch` 时跳过这一步（见下文）。
3. **准备 TLS 原生组件**，按顺序尝试：
   - 仓库里已有且可加载 → 直接用；
   - 从 `/Applications/Codex Proxy.app` 复制（无需 Rust）；
   - 已安装 Rust → 自动编译；
   - 都不行 → 提示安装 Rust 后重跑。
4. **安装依赖并构建**（`npm ci` + `npm run build`）。
5. **迁移账号数据**：把 `~/Library/Application Support/@codex-proxy/electron/data`
   **复制**到仓库的 `./data`（账号、分发 Key、设置都在里面）。桌面版的数据保持不动，随时可以切回去。
   `./data` 已存在时跳过；`--migrate-data` 会先把现有 `./data` 备份再重新复制；`--no-migrate` 完全跳过。
6. **`--lan`**：在 `data/local.yaml` 写入 `server.host: 0.0.0.0`。若尚未设置 API 密钥会提示确认——
   没有密钥时局域网内任何人都能使用代理和打开面板。
7. **写入 LaunchAgent** `~/Library/LaunchAgents/com.codex-proxy.plist` 并启动，等待 `/health` 正常后
   打印面板地址。

## 从正在运行的桌面版切换（`--switch`）

桌面版还在给客户端提供服务时，用 `install --switch`，把停机时间压到几秒：

1. 先在桌面版继续运行的情况下完成依赖安装、构建和 TLS 组件准备；
2. 轮询桌面版的 `/health`，等 `pool.used_slots` 连续 `CODEX_PROXY_IDLE_SECONDS`（默认 5）秒为 0，
   **不会打断进行中的请求**。默认一直等；`CODEX_PROXY_IDLE_TIMEOUT=秒数` 可设上限，超时则不做任何改动直接退出；
3. 向桌面版发送 SIGTERM（它的「退出」菜单/AppleScript 在 macOS 上只会隐藏到托盘），等端口释放；
4. **此时才复制数据**——桌面版运行期间会轮换账号的 refresh token，提前复制会拿到旧 token。
   已有的 `./data` 会先备份；
5. 启动 LaunchAgent。若 `/health` 不正常，自动移除 LaunchAgent 并重新打开桌面版（回滚）。

## 日常管理

```bash
scripts/deploy/macos.sh status      # 运行状态 + 健康检查
scripts/deploy/macos.sh logs        # 跟踪日志（logs/codex-proxy.log）
scripts/deploy/macos.sh restart     # 重启（改了 data/local.yaml 后用）
scripts/deploy/macos.sh stop        # 停止（下次登录仍会自动启动）
scripts/deploy/macos.sh update      # git pull --ff-only → 重新构建 → 重启
scripts/deploy/macos.sh uninstall   # 移除 LaunchAgent（保留代码和 data/）
```

`update` 要求工作区没有未提交的改动。

## 注意事项

- **LaunchAgent 在用户登录后才启动。** Mac mini 当服务器用时，建议在「系统设置 → 用户与群组」开启自动登录，
  并在「系统设置 → 能耗」里关闭自动休眠，否则机器睡眠后服务不可用。
- **数据位置**：部署后数据在仓库的 `./data`，与桌面版目录相互独立。想回到桌面版时，先
  `scripts/deploy/macos.sh stop`（或 `uninstall`），再打开桌面版即可（桌面版看到的是迁移前的数据）。
- **桌面版组件不兼容时**：如果桌面版版本与当前代码差异较大，复制来的 TLS 组件可能无法加载，脚本会自动删除它并尝试用 Rust 编译。
- **通过 nvm / volta 等安装的 Node**：LaunchAgent 记录的是 Node 的绝对路径，切换 Node 版本后请重新执行 `install`。
- **其它会拉起桌面版的工具**：如果你自己装过「桌面版退出就自动重开」的守护脚本或定时更新桌面版的任务，
  切换后要停用或改成检查本服务，否则它们会再次启动桌面版，与本服务抢端口。
- **自定义**：`CODEX_PROXY_LAUNCHD_LABEL` 改服务名（可在同一台机器部署多份），
  `CODEX_PROXY_HEALTH_TIMEOUT` 调整启动等待秒数（默认 90）。端口在 `data/local.yaml` 的 `server.port` 修改。
