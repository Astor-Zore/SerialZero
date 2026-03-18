# SerialZero

> **SerialZero** — A professional, elegant serial port assistant with a modern Web UI.

[![GitHub](https://img.shields.io/github/stars/Astor-Zore/SerialZero?style=social)](https://github.com/Astor-Zore/SerialZero)

---

## 📌 Overview / 项目概述

<!-- Logo 与介绍区域 - 居中并排布局 -->
<div align="center">
  <div style="
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 30px;
    margin: 20px 0;
    max-width: 900px;
  ">
    <!-- Logo 图片 -->
    <div>
      <img src="https://github.com/Astor-Zore/SerialZero/raw/master/pictures/title.png" 
           alt="SerialZero Logo" 
           width="100%" 
           style="display: block;">
    </div>
  </div>
</div>

---

## 🎨 Screenshots / 截图
 
<p align="center">
  <table>
    <tr>
      <!-- 第一行 -->
      <td align="center">
        <img src="https://github.com/Astor-Zore/SerialZero/blob/master/pictures/ansi.png" width="500" alt=""><br>
        <strong>ANSI</strong>
      </td>
      <td align="center">
        <img src="https://github.com/Astor-Zore/SerialZero/blob/master/pictures/highlight.png" width="500" alt=""><br>
        <strong>Highlight</strong>
      </td>
    </tr>
  </table>
</p>

---

## ✨ Features / 功能亮点

- ✅ **Web UI + 浏览器访问 (Web UI + Browser Access)**  
  &nbsp;&nbsp;&nbsp;&nbsp;*无需安装客户端，使用浏览器即可操作。*  
  &nbsp;&nbsp;&nbsp;&nbsp;*No client installation required, accessible via browser.*
- ✅ **实时串口收发 (Real-time Serial Communication)**  
  &nbsp;&nbsp;&nbsp;&nbsp;*支持高频率（ms 级）数据接收与发送。*  
  &nbsp;&nbsp;&nbsp;&nbsp;*Supports high-frequency (millisecond-level) data transmission and reception.*
...

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
# go install mod
go mod tidy

# Build (Go 1.20+ recommended)
go build -o SerialZero.exe
```

---

## 🤝 Contributing / 贡献

None

---

## 📄 License

本项目遵循 MIT 许可证。

---

> 📌 Repository: https://github.com/Astor-Zore/SerialZero
