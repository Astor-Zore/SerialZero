# SerialZero

SerialZero 是一个专业、美观的串口助手应用，专为Windows平台设计。采用扁平化项目结构，开箱即用，功能完备，UI美观专业。

## 特性

- 高端简约优雅的Web界面，线条优雅简单，配色协调一致
- 通过 `config.toml` 配置文件管理串口参数、日志路径和高亮组
- 日志文件按 `COM11_20260317_211634.log` 格式命名
- 统一使用Linux回车显示，不使用^M
- 支持同时输入和输出，类似于shell交互，按Tab直接发送
- 程序 `-h` 参数显示详细帮助信息
- 支持查看历史记录，可选择跟踪最新消息

## 用法

- **F1**: 显示帮助菜单
- **F2**: 连接/断开串口，UI上有连接状态的提示
- **F3**: 扫描串口，列出扫描到的可连接的串口列表，可以通过⬆️⬇️进行选择，回车选中
- **F4**: 弹窗修改波特率，回车确认
- **Esc**: 关闭模态框
- **PageUp/PageDown** 或 **↑↓**: 翻阅历史

## 安装与运行

1. 确保安装了Go语言环境
2. 克隆或下载项目
3. 运行 `go build` 编译
4. 执行 `./SerialZero` 启动服务器
5. 在浏览器中访问 `http://localhost:8080`

## 配置

编辑 `config.toml` 文件：

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
groups = []
```

## 依赖

- github.com/gin-gonic/gin
- github.com/gorilla/websocket
- github.com/BurntSushi/toml
- github.com/tarm/serial

- github.com/rivo/tview
- github.com/tarm/serial
- github.com/BurntSushi/toml