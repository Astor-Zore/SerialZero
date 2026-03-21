# SerialZero

> **SerialZero** — A professional, elegant serial port assistant with a modern Web UI.

[![GitHub](https://img.shields.io/github/stars/Astor-Zore/SerialZero?style=social)](https://github.com/Astor-Zore/SerialZero)

---

## 📌 Overview / 项目概述

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
        <strong>SHELL</strong>
      </td>
      <td align="center">
        <img src="https://github.com/Astor-Zore/SerialZero/blob/master/pictures/highlight.png" width="500" alt=""><br>
        <strong>NOMAL</strong>
      </td>
    </tr>
  </table>
</p>


---

## ✨ Features / 功能亮点

- **Elegant UI** / **优雅的UI界面**  
  Access via `localhost:8080`  
  通过对 `localhost:8080` 端口进行访问

- **Terminal Emulation** / **终端模拟功能**  
  Correctly handles ANSI escape codes and terminal control characters, rendering them exactly as they appear  
  能够正确转义 ANSI，对终端的控制字符做到原模原样的呈现

- **Traditional Serial Communication** / **传统串口收发**  
  Filters out control characters and displays messages as-is  
  过滤控制字符后，将消息原模原样呈现

- **Automatic Logging** / **自动日志**  
  Logs are saved in the `./logs` directory with the format `COM4_20260322_14:33:34.log`, where each log file corresponds to a session from connection to disconnection  
  会在目录下 `./logs` 下按照 `COM4_20260322_14:33:34.log` 的格式，以连接端口和断开作为一次日志进行输出

- **Timestamp Support** / **时间戳支持**  
  Option to prepend timestamps to messages  
  可自动控制在消息前是否附加时间戳

- **HEX Support** / **HEX 支持**  
  Supports traditional serial communication with both ASCII and HEX display and sending modes  
  支持传统的串口收发，可按照 ASCII 或是 HEX 进行发送和显示

- **Custom Highlight Groups** / **高亮组自定义**  
  Customizable highlight groups to match personal logging preferences  
  可通过自行定义高亮组，用于配合自己的日志习惯进行呈现

- **Message History** / **消息发送历史**  
  Stores up to 100 past messages; use the `↑` arrow key to quickly reuse the previous command/message  
  会保存近 100 条历史消息，可通过 `↑` 键直接使用上一次的命令/消息

---

## 🚀 Quick Start / 快速开始

1. Run `SerialZero.exe`  
   运行 `SerialZero.exe`

2. Open `localhost:8080` in your browser  
   在浏览器打开 `localhost:8080`

3. Select and open the desired serial port  
   选择并打开串口

---

## ⚙️ Configuration / 配置说明

Edit `config.toml` in the project root (a default file is generated on first run):

```toml
[serial]
  port = "COM43"
  baud = 115200
  databits = 8
  stopbits = 1
  parity = "N"

[log]
  path = "./logs"

[ui]
  font = "CaskaydiaMono NF"
  fontsize = 14
  timestamp = true
  shell = true

[highlight]
  groups = ["ok:#ff0000", "error:#ff0000", "warn:#ffa500", "debug:#00ffff"]

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
| CMD history | `PageUp/PageDown` / `↑/↓` | 翻页查看历史记录 |

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

[Astor-Zero]([Astor-Zore (Astor.Jiang)](https://github.com/Astor-Zore))

---

## 📄 License

本项目遵循 MIT 许可证。

---

> 📌 Repository: https://github.com/Astor-Zore/SerialZero
