# SerialZero

> **SerialZero** — A professional, elegant serial port assistant with a modern Web UI.

[![GitHub](https://img.shields.io/github/stars/Astor-Zore/SerialZero?style=social)](https://github.com/Astor-Zore/SerialZero)

---

## 📌 Overview / 项目概述

**SerialZero** is a lightweight Windows-focused serial port utility built with Go and a sleek browser-based UI.
It provides a clean, responsive console experience, advanced logging, highlight rules, and reliable high-frequency data handling.

**SerialZero 是一个基于 Go 的 Windows 串口助手，采用现代 Web UI。它提供流畅的终端交互、日志管理、高亮规则以及高频率数据收发支持。**

---

## 🎨 Logo & Screenshots / Logo 与截图

> **Logo:** 请在此位置插入你的 Logo（例如 `docs/logo.png`）

![Logo placeholder](./docs/logo-placeholder.png)

> **Screenshots:** 请在此位置插入使用界面截图。

![UI screenshot placeholder](./docs/screenshot-placeholder.png)

---

## ✨ Features / 功能亮点

- ✅ **Web UI + 浏览器访问**：无需安装客户端，使用浏览器即可操作。
- ✅ **实时串口收发**：支持高频率（ms 级）数据接收与发送。
- ✅ **固定尺寸日志区**：带滚动条的日志区域，支持跟踪最新消息。
- ✅ **高亮规则**：按关键词/正则高亮，可区分大小写。
- ✅ **日志记录**：按 `COMx_YYYYMMDD_HHMMSS.log` 统一命名保存。
- ✅ **配置驱动**：通过 `config.toml` 进行串口、日志、高亮等设置。
- ✅ **命令行参数**：支持 `-h` 查看帮助。

---

## 🚀 Quick Start / 快速开始

```bash
# Clone
git clone https://github.com/Astor-Zore/SerialZero.git
cd SerialZero

# Build
go build -o SerialZero

# Run
./SerialZero

# Open in browser
# -> http://localhost:8080
```

> **Tip:** Run from PowerShell or CMD on Windows.

---

## ⚙️ Configuration / 配置说明

Edit `config.toml` in the project root (a default file is generated on first run):

```toml
[serial]
port = "COM1"
baud = 9600
databits = 8
stopbits = 1
parity = "N"

[log]
path = "./logs"

[highlight]
groups = [
  # Pattern matching is case-insensitive. Format: "pattern:color"
  # Example: "ok:#00ff00" or "ERROR:#ff0000"
]

[ui]
# Font name and size (example: "Consolas" / 12)
font = "Consolas"
fontsize = 12

# Show timestamps in the log output (true / false)
showTimestamp = true
```

---

## 🧭 Usage / 使用说明

### Keybindings / 常用按键

| Action | Key | Description |
|--------|-----|-------------|
| Help menu | `F1` | 显示快捷键说明 |
| Connect / Disconnect | `F2` | 连接/断开串口 |
| Scan ports | `F3` | 扫描可用串口列表 |
| Change baud rate | `F4` | 弹窗修改波特率 |
| Close modal | `Esc` | 关闭当前模态窗口 |
| Scroll history | `PageUp/PageDown` / `↑/↓` | 翻页查看历史记录 |

### Highlight Rules / 高亮规则

- Case-insensitive by default.
- Format: `pattern:color`.
- Example: `ok:#00ff00`, `ERROR:#ff0000`, `warn:#ffaa00`.

---

## 📦 Build & Development / 构建与开发

```bash
# Run tests (if available)
go test ./...

# Build (Go 1.20+ recommended)
go build
```

---

## 🤝 Contributing / 贡献

欢迎 Fork 并提交 PR。请确保：

- 代码风格统一
- 变更有对应说明
- 关键逻辑已测试（如有测试用例）

---

## 📄 License

本项目遵循 MIT 许可证。

---

> 📌 Repository: https://github.com/Astor-Zore/SerialZero
