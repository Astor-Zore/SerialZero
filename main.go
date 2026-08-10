//go:build windows
package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/BurntSushi/toml"
	"github.com/getlantern/systray"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/tarm/serial"
	lua "github.com/yuin/gopher-lua"
	webview "github.com/webview/webview_go"
	"golang.org/x/sys/windows/registry"
)

//go:embed static
var staticEmbed embed.FS
//go:embed index.html
var indexHTML string
//go:embed app.ico
var iconData []byte

// DefaultScrollback defines the default log buffer size.
// Updated to 1,000,000 for deep logging support.
const DefaultScrollback = 1000000

/**
 * @brief Theme configuration structure for UI customization.
 */
type Theme struct {
	Name string `toml:"name"`
	Background string `toml:"background"`
	Foreground string `toml:"foreground"`
	Cursor string `toml:"cursor"`
	Black string `toml:"black"`
	Red string `toml:"red"`
	Green string `toml:"green"`
	Yellow string `toml:"yellow"`
	Blue string `toml:"blue"`
	Magenta string `toml:"magenta"`
	Cyan string `toml:"cyan"`
	White string `toml:"white"`
	BrightBlack string `toml:"brightblack"`
	BrightRed string `toml:"brightred"`
	BrightGreen string `toml:"brightgreen"`
	BrightYellow string `toml:"brightyellow"`
	BrightBlue string `toml:"brightblue"`
	BrightMagenta string `toml:"brightmagenta"`
	BrightCyan string `toml:"brightcyan"`
	BrightWhite string `toml:"brightwhite"`
}

/**
 * @brief Main configuration structure.
 */
type Config struct {
	Serial struct {
		Port string `toml:"port"`
		Baud int `toml:"baud"`
		Databits int `toml:"databits"`
		Stopbits int `toml:"stopbits"`
		Parity string `toml:"parity"`
	} `toml:"serial"`
	Log struct {
		Path string `toml:"path"`
	} `toml:"log"`
	UI struct {
		Font string `toml:"font"`
		FontSize int `toml:"fontsize"`
		Timestamp bool `toml:"timestamp"`
		Shell bool `toml:"shell"`
		Scrollback int `toml:"scrollback"`
	} `toml:"ui"`
	Highlight struct {
		Groups []string `toml:"groups"`
	} `toml:"highlight"`
	Theme Theme `toml:"theme"`
}

/**
 * @brief App main struct holding application state.
 */
type App struct {
	config        Config
	port          *serial.Port
	isConnected   bool
	clients       map[string]*Client
	clientsMu     sync.RWMutex
	sendHistory   []string
	dataMode      string
	writeChan     chan []byte
	receiveChan   chan []byte
	mu            sync.Mutex
	httpServer    *http.Server
	ctx           context.Context
	cancel        context.CancelFunc
	scriptEngine  *ScriptEngine
	instancePort  int
	instanceTitle string
	configFile    string
	logManager    *LogFileManager
}

/**
 * @brief Client wraps websocket connection.
 */
type Client struct {
	conn *websocket.Conn
	mu sync.Mutex
}

/**
 * @brief ScriptEngine manages Lua script execution and state.
 */
type ScriptEngine struct {
	app *App
	state *lua.LState
	ctx context.Context
	cancel context.CancelFunc
	serialDataChan chan string
	isRunning bool
	mu sync.Mutex
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

var ansiRegex = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)

// Win32 API declarations
var (
	modkernel32 = syscall.NewLazyDLL("kernel32.dll")
	procFreeConsole = modkernel32.NewProc("FreeConsole")
	procAllocConsole = modkernel32.NewProc("AllocConsole")
	moduser32 = syscall.NewLazyDLL("user32.dll")
	procFindWindowW = moduser32.NewProc("FindWindowW")
	procSendMessageW = moduser32.NewProc("SendMessageW")
	procLoadIconW = moduser32.NewProc("LoadIconW")
	procGetModuleHandleW = modkernel32.NewProc("GetModuleHandleW")
	procShowWindow = moduser32.NewProc("ShowWindow")
	procMoveWindow = moduser32.NewProc("MoveWindow")
	procGetSystemMetrics = moduser32.NewProc("GetSystemMetrics")
	procEnumChildWindows = moduser32.NewProc("EnumChildWindows")
	procSetWindowLongPtrW = moduser32.NewProc("SetWindowLongPtrW")
	procGetWindowLongPtrW = moduser32.NewProc("GetWindowLongPtrW")
	procSetWindowPos = moduser32.NewProc("SetWindowPos")
	procCallWindowProcW = moduser32.NewProc("CallWindowProcW")
	procGetClientRect = moduser32.NewProc("GetClientRect")
	procGetWindowRect = moduser32.NewProc("GetWindowRect")
	procPostMessageW = moduser32.NewProc("PostMessageW")
	procDefWindowProcW = moduser32.NewProc("DefWindowProcW")
	procIsZoomed = moduser32.NewProc("IsZoomed")
	procSystemParametersInfoW = moduser32.NewProc("SystemParametersInfoW")
)

const (
	SW_HIDE = 0
	SW_SHOW = 5
	SW_MINIMIZE = 6
	SW_MAXIMIZE = 3
	SW_RESTORE = 9
	SM_CXSCREEN = 0
	SM_CYSCREEN = 1

	WS_POPUP = 0x80000000
	WS_CAPTION = 0x00C00000
	WS_SYSMENU = 0x00080000
	WS_THICKFRAME = 0x00040000
	WS_MINIMIZEBOX = 0x00020000
	WS_MAXIMIZEBOX = 0x00010000
	WS_VISIBLE = 0x10000000
	WS_OVERLAPPEDWINDOW = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
	WS_OVERLAPPED = 0x00000000

	SWP_FRAMECHANGED = 0x0020
	SWP_NOZORDER = 0x0004
	SWP_NOMOVE = 0x0002
	SWP_NOSIZE = 0x0001

	WM_NCCALCSIZE = 0x0083
	WM_NCHITTEST = 0x0084
	WM_NCLBUTTONDOWN = 0x00A1
	WM_GETMINMAXINFO = 0x0024
	WM_SYSCOMMAND = 0x0112
	WM_CLOSE = 0x0010
	SC_MINIMIZE = 0xF020
	SC_MAXIMIZE = 0xF030
	SC_RESTORE = 0xF120

	SPI_GETWORKAREA = 0x0030

	WVR_VALIDRECTS = 0x400

	HTLEFT = 10
	HTRIGHT = 11
	HTTOP = 12
	HTTOPLEFT = 13
	HTTOPRIGHT = 14
	HTBOTTOM = 15
	HTBOTTOMLEFT = 16
	HTBOTTOMRIGHT = 17
	HTCAPTION = 2
	HTCLIENT = 1
)

type RECT struct {
	Left, Top, Right, Bottom int32
}

type POINT struct {
	X, Y int32
}

type MINMAXINFO struct {
	ptReserved     POINT
	ptMaxSize      POINT
	ptMaxPosition  POINT
	ptMinTrackSize POINT
	ptMaxTrackSize POINT
}

var appHwnd uintptr = 0
var originalWndProc uintptr = 0
var wndProcCallback uintptr = 0

// Callbacks for hiding/showing child windows recursively
func hideChildWindowProc(hwnd syscall.Handle, lparam uintptr) uintptr {
	procShowWindow.Call(uintptr(hwnd), SW_HIDE)
	return 1
}

func showChildWindowProc(hwnd syscall.Handle, lparam uintptr) uintptr {
	procShowWindow.Call(uintptr(hwnd), SW_SHOW)
	return 1
}

var hideChildCallback = syscall.NewCallback(hideChildWindowProc)
var showChildCallback = syscall.NewCallback(showChildWindowProc)

/**
 * @brief Finds the window by title and sets its icon from the embedded resource.
 * @param title The title of the window to find.
 */
func setWindowIcon(title string) {
	time.Sleep(500 * time.Millisecond) // Wait for window to be created
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	hwnd, _, _ := procFindWindowW.Call(uintptr(0), uintptr(unsafe.Pointer(titlePtr)))
	if hwnd == 0 {
		return
	}
	hInstance, _, _ := procGetModuleHandleW.Call(uintptr(0))
	icon, _, _ := procLoadIconW.Call(hInstance, uintptr(1))
	if icon == 0 {
		return
	}
	procSendMessageW.Call(hwnd, 0x0080, 1, icon) // Set Big Icon
	procSendMessageW.Call(hwnd, 0x0080, 0, icon) // Set Small Icon
}

func hideConsole() {
	procFreeConsole.Call()
}

func showConsole() {
	procAllocConsole.Call()
	outFile, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0)
	if err == nil {
		os.Stdout = outFile
		os.Stderr = outFile
		log.SetOutput(outFile)
	}
	fmt.Println("Console opened. SerialZero is running.")
	fmt.Println("Web UI: http://localhost:8080")
}

func redirectStdoutToNull() {
	nullFile, err := os.OpenFile("NUL", os.O_WRONLY, 0)
	if err == nil {
		os.Stdout = nullFile
		os.Stderr = nullFile
		log.SetOutput(nullFile)
	}
}

/**
 * @brief Window procedure for subclassing. Only handles WM_NCCALCSIZE
 *        to extend the client area into the title bar. All other messages
 *        (including WM_NCHITTEST) are forwarded to the original proc so
 *        WebView2 can handle dragging via -webkit-app-region.
 */
func windowProc(hwnd syscall.Handle, msg uint32, wparam uintptr, lparam uintptr) uintptr {
	if msg == WM_NCCALCSIZE && wparam != 0 {
		return 0
	}
	if msg == WM_GETMINMAXINFO {
		var rect RECT
		procSystemParametersInfoW.Call(uintptr(SPI_GETWORKAREA), 0, uintptr(unsafe.Pointer(&rect)), 0)
		mmi := (*MINMAXINFO)(unsafe.Pointer(lparam))
		mmi.ptMaxPosition.X = rect.Left
		mmi.ptMaxPosition.Y = rect.Top
		mmi.ptMaxSize.X = rect.Right - rect.Left
		mmi.ptMaxSize.Y = rect.Bottom - rect.Top
		return 0
	}
	ret, _, _ := procCallWindowProcW.Call(originalWndProc, uintptr(hwnd), uintptr(msg), wparam, lparam)
	return ret
}

/**
 * @brief Removes the native window frame (title bar, borders) and
 *        subclasses the window procedure to handle WM_NCCALCSIZE.
 */
func makeFrameless(hwnd uintptr) {
	gwlStyle := ^uintptr(15) // GWL_STYLE = -16
	style, _, _ := procGetWindowLongPtrW.Call(hwnd, gwlStyle)
	newStyle := (style & ^uintptr(WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX|WS_MAXIMIZEBOX)) | uintptr(WS_THICKFRAME)
	procSetWindowLongPtrW.Call(hwnd, gwlStyle, newStyle)
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, uintptr(SWP_FRAMECHANGED|SWP_NOZORDER|SWP_NOMOVE|SWP_NOSIZE))

	/** Subclass the window procedure */
	gwlWndProc := ^uintptr(3) // GWL_WNDPROC = -4
	originalWndProc, _, _ = procGetWindowLongPtrW.Call(hwnd, gwlWndProc)
	wndProcCallback = syscall.NewCallback(windowProc)
	procSetWindowLongPtrW.Call(hwnd, gwlWndProc, wndProcCallback)
}

func findAvailablePort(startPort int) (int, error) {
	for port := startPort; port < startPort+100; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			ln.Close()
			return port, nil
		}
	}
	return 0, fmt.Errorf("no available port in range %d-%d", startPort, startPort+99)
}

func main() {
	hideConsole()
	redirectStdoutToNull()

	exePath, _ := os.Executable()
	logDir := filepath.Dir(exePath)
	logFile, err := os.OpenFile(filepath.Join(logDir, "serialzero.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		log.SetOutput(io.MultiWriter(logFile, os.Stderr))
		log.SetFlags(log.LstdFlags | log.Lshortfile)
	} else {
		log.SetOutput(os.Stderr)
	}
	log.Println("SerialZero starting...")

	instancePort, err := findAvailablePort(8080)
	if err != nil {
		log.Fatalf("Failed to find available port: %v", err)
	}
	baseConfigFile := filepath.Join(".", "config.toml")
	runtimeConfigFile := filepath.Join(".", fmt.Sprintf("config_%d.toml", instancePort))

	if _, err := os.Stat(baseConfigFile); err == nil {
		src, err := os.ReadFile(baseConfigFile)
		if err == nil {
			os.WriteFile(runtimeConfigFile, src, 0644)
		}
	}
	instanceTitle := fmt.Sprintf("SerialZero :%d", instancePort)

	ctx, cancel := context.WithCancel(context.Background())
	app := &App{
		clients:        make(map[string]*Client),
		sendHistory:    []string{},
		dataMode:       "ascii",
		writeChan:      make(chan []byte, 1024),
		receiveChan:    make(chan []byte, 32768),
		ctx:            ctx,
		cancel:         cancel,
		instancePort:   instancePort,
		instanceTitle:  instanceTitle,
		configFile:     runtimeConfigFile,
		logManager:     NewLogFileManager(),
	}
	defer os.Remove(runtimeConfigFile)

	app.loadConfig()
	go app.runWebServer()
	go func() {
		systray.Run(func() {
			systray.SetIcon(iconData)
			systray.SetTooltip(instanceTitle)
			mShowConsole := systray.AddMenuItem("Show Console", "Show the console window")
			systray.AddSeparator()
			mQuit := systray.AddMenuItem("Quit", "Exit the application")
			go func() {
				for {
					select {
					case <-mShowConsole.ClickedCh:
						showConsole()
					case <-mQuit.ClickedCh:
						systray.Quit()
						cancel()
						os.Exit(0)
					}
				}
			}()
		}, nil)
	}()
	time.Sleep(500 * time.Millisecond)
	w := webview.New(true)
	defer w.Destroy()

	// 1. Hide window and child windows immediately to prevent white flash
	appHwnd = uintptr(w.Window())
	procShowWindow.Call(appHwnd, SW_HIDE)
	procEnumChildWindows.Call(appHwnd, hideChildCallback, 0)

	makeFrameless(appHwnd)

	w.Bind("minimizeWindow", func() {
		procShowWindow.Call(appHwnd, uintptr(SW_MINIMIZE))
	})
	w.Bind("maximizeWindow", func() {
		procShowWindow.Call(appHwnd, uintptr(SW_MAXIMIZE))
	})
	w.Bind("toggleMaximizeWindow", func() {
		ret, _, _ := procIsZoomed.Call(appHwnd)
		if ret != 0 {
			procShowWindow.Call(appHwnd, uintptr(SW_RESTORE))
		} else {
			procShowWindow.Call(appHwnd, uintptr(SW_MAXIMIZE))
		}
	})
	w.Bind("closeWindow", func() {
		procPostMessageW.Call(appHwnd, uintptr(WM_CLOSE), 0, 0)
	})
	w.Bind("moveWindow", func(deltaX int, deltaY int) {
		var rect RECT
		procGetWindowRect.Call(appHwnd, uintptr(unsafe.Pointer(&rect)))
		procMoveWindow.Call(appHwnd, uintptr(rect.Left+int32(deltaX)), uintptr(rect.Top+int32(deltaY)), uintptr(rect.Right-rect.Left), uintptr(rect.Bottom-rect.Top), 1)
	})
	w.Bind("moveWindowTo", func(x int, y int) {
		var rect RECT
		procGetWindowRect.Call(appHwnd, uintptr(unsafe.Pointer(&rect)))
		procMoveWindow.Call(appHwnd, uintptr(x), uintptr(y), uintptr(rect.Right-rect.Left), uintptr(rect.Bottom-rect.Top), 1)
	})
	w.Bind("resizeWindow", func(direction string, deltaX int, deltaY int) {
		var rect RECT
		procGetWindowRect.Call(appHwnd, uintptr(unsafe.Pointer(&rect)))
		switch direction {
		case "n":
			procMoveWindow.Call(appHwnd, uintptr(rect.Left), uintptr(rect.Top+int32(deltaY)), uintptr(rect.Right-rect.Left), uintptr(rect.Bottom-rect.Top-int32(deltaY)), 1)
		case "s":
			procMoveWindow.Call(appHwnd, uintptr(rect.Left), uintptr(rect.Top), uintptr(rect.Right-rect.Left), uintptr(rect.Bottom-rect.Top+int32(deltaY)), 1)
		case "w":
			procMoveWindow.Call(appHwnd, uintptr(rect.Left+int32(deltaX)), uintptr(rect.Top), uintptr(rect.Right-rect.Left-int32(deltaX)), uintptr(rect.Bottom-rect.Top), 1)
		case "e":
			procMoveWindow.Call(appHwnd, uintptr(rect.Left), uintptr(rect.Top), uintptr(rect.Right-rect.Left+int32(deltaX)), uintptr(rect.Bottom-rect.Top), 1)
		case "nw":
			procMoveWindow.Call(appHwnd, uintptr(rect.Left+int32(deltaX)), uintptr(rect.Top+int32(deltaY)), uintptr(rect.Right-rect.Left-int32(deltaX)), uintptr(rect.Bottom-rect.Top-int32(deltaY)), 1)
		case "ne":
			procMoveWindow.Call(appHwnd, uintptr(rect.Left), uintptr(rect.Top+int32(deltaY)), uintptr(rect.Right-rect.Left+int32(deltaX)), uintptr(rect.Bottom-rect.Top-int32(deltaY)), 1)
		case "sw":
			procMoveWindow.Call(appHwnd, uintptr(rect.Left+int32(deltaX)), uintptr(rect.Top), uintptr(rect.Right-rect.Left-int32(deltaX)), uintptr(rect.Bottom-rect.Top+int32(deltaY)), 1)
		case "se":
			procMoveWindow.Call(appHwnd, uintptr(rect.Left), uintptr(rect.Top), uintptr(rect.Right-rect.Left+int32(deltaX)), uintptr(rect.Bottom-rect.Top+int32(deltaY)), 1)
		}
	})

	// 2. Configure window
	w.SetTitle(instanceTitle)
	width := 1024
	height := 768

	// 3. Center window
	screenW, _, _ := procGetSystemMetrics.Call(uintptr(SM_CXSCREEN))
	screenH, _, _ := procGetSystemMetrics.Call(uintptr(SM_CYSCREEN))
	posX := (int(screenW) - width) / 2
	posY := (int(screenH) - height) / 2
	if posX < 0 {
		posX = 0
	}
	if posY < 0 {
		posY = 0
	}
	procMoveWindow.Call(appHwnd, uintptr(posX), uintptr(posY), uintptr(width), uintptr(height), 0)

	// 4. Fallback: force show after 5 seconds if frontend fails to signal
	go func() {
		time.Sleep(5 * time.Second)
		if appHwnd != 0 {
			procShowWindow.Call(appHwnd, SW_SHOW)
			procEnumChildWindows.Call(appHwnd, showChildCallback, 0)
		}
	}()

	// 5. Navigate and run
	w.Navigate(fmt.Sprintf("http://localhost:%d", instancePort))
	go setWindowIcon(instanceTitle)
	w.Run()
	cancel()
	os.Exit(0)
}

func (a *App) runWebServer() {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	staticFS, err := fs.Sub(staticEmbed, "static")
	if err != nil {
		log.Printf("Failed to get static sub-fs: %v", err)
		return
	}
	r.StaticFS("/static", http.FS(staticFS))
	r.GET("/", func(c *gin.Context) {
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(indexHTML))
	})

	// Endpoint to receive frontend ready signal and show main window smoothly
	r.POST("/ready", func(c *gin.Context) {
		go func() {
			time.Sleep(50 * time.Millisecond) // Slight delay to ensure final render is complete
			if appHwnd != 0 {
				procShowWindow.Call(appHwnd, SW_SHOW)
				procEnumChildWindows.Call(appHwnd, showChildCallback, 0)
			}
		}()
		c.JSON(200, gin.H{"status": "ok"})
	})

	r.GET("/ws", a.handleWebSocket)
	r.POST("/connect", a.handleConnect)
	r.POST("/disconnect", a.handleDisconnect)
	r.POST("/scan", a.handleScan)
	r.POST("/setbaud", a.handleSetBaud)
	r.POST("/send", a.handleSend)
	r.POST("/setport", a.handleSetPort)
	r.POST("/setmode", a.handleSetMode)
	r.POST("/clear", a.handleClear)
	r.POST("/getconfig", a.handleGetConfig)
	r.POST("/saveconfig", a.handleSaveConfig)
	r.POST("/listscripts", a.handleListScripts)
	r.POST("/runscript", a.handleRunScript)
	r.POST("/stopscript", a.handleStopScript)
	r.POST("/exportlog", a.handleExportLog)
	r.POST("/uploadlog", a.handleUploadLog)
	r.POST("/browsefile", a.handleBrowseFile)
	r.POST("/openlog", a.handleOpenLog)
	r.POST("/readlog", a.handleReadLog)
	r.POST("/searchlog", a.handleSearchLog)
	r.POST("/closelog", a.handleCloseLog)

	a.httpServer = &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", a.instancePort), Handler: r}
	go func() {
		if err := a.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP server error: %v", err)
		}
	}()
	<-a.ctx.Done()
}

func (a *App) handleWebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	clientID := uuid.New().String()
	a.clientsMu.Lock()
	a.clients[clientID] = &Client{conn: conn}
	a.clientsMu.Unlock()
	defer func() {
		a.clientsMu.Lock()
		delete(a.clients, clientID)
		a.clientsMu.Unlock()
		conn.Close()
	}()

	a.sendToClient(clientID, map[string]interface{}{
		"type": "config",
		"config": a.config,
		"connected": a.isConnected,
		"mode": a.dataMode,
	})

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var data map[string]interface{}
		if err := json.Unmarshal(message, &data); err == nil {
			if data["type"] == "input" {
				if inputData, ok := data["data"].(string); ok {
					if a.isConnected {
						select {
						case a.writeChan <- []byte(inputData):
						default:
						}
					}
				}
			}
		}
	}
}

func (a *App) broadcast(message interface{}) {
	data, _ := json.Marshal(message)
	a.clientsMu.RLock()
	clientsCopy := make(map[string]*Client, len(a.clients))
	for id, c := range a.clients {
		clientsCopy[id] = c
	}
	a.clientsMu.RUnlock()

	for id, client := range clientsCopy {
		if client == nil {
			continue
		}
		client.mu.Lock()
		client.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
		err := client.conn.WriteMessage(websocket.TextMessage, data)
		client.mu.Unlock()
		if err != nil {
			a.clientsMu.Lock()
			if cur, ok := a.clients[id]; ok && cur == client {
				delete(a.clients, id)
			}
			a.clientsMu.Unlock()
			client.conn.Close()
		}
	}
}

func (a *App) sendToClient(clientID string, message interface{}) {
	data, _ := json.Marshal(message)
	a.clientsMu.RLock()
	client, ok := a.clients[clientID]
	a.clientsMu.RUnlock()
	if !ok || client == nil {
		return
	}
	client.mu.Lock()
	client.conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
	err := client.conn.WriteMessage(websocket.TextMessage, data)
	client.mu.Unlock()
	if err != nil {
		a.clientsMu.Lock()
		if cur, ok := a.clients[clientID]; ok && cur == client {
			delete(a.clients, clientID)
		}
		a.clientsMu.Unlock()
		client.conn.Close()
	}
}

func (a *App) handleConnect(c *gin.Context) {
	if a.isConnected {
		c.JSON(200, gin.H{"status": "already connected"})
		return
	}
	cfg := &serial.Config{
		Name: a.config.Serial.Port,
		Baud: a.config.Serial.Baud,
		Size: byte(a.config.Serial.Databits),
		StopBits: serial.StopBits(a.config.Serial.Stopbits),
		Parity: serial.Parity(a.config.Serial.Parity[0]),
		ReadTimeout: time.Millisecond * 100,
	}
	port, err := serial.OpenPort(cfg)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}
	a.port = port
	a.isConnected = true
	a.writeChan = make(chan []byte, 1024)
	a.receiveChan = make(chan []byte, 32768)
	go a.readData()
	go a.processReceiver()
	go a.writeLoop()
	a.broadcast(map[string]interface{}{"type": "status", "message": fmt.Sprintf("Serial port %s connected", a.config.Serial.Port)})
	c.JSON(200, gin.H{"status": "connected"})
}

func (a *App) handleDisconnect(c *gin.Context) {
	if !a.isConnected {
		c.JSON(200, gin.H{"status": "not connected"})
		return
	}
	if a.port != nil {
		a.port.Close()
		a.port = nil
	}
	a.isConnected = false
	if a.writeChan != nil {
		close(a.writeChan)
		a.writeChan = nil
	}
	if a.receiveChan != nil {
		close(a.receiveChan)
		a.receiveChan = nil
	}
	a.broadcast(map[string]interface{}{"type": "status", "message": "Serial port disconnected"})
	c.JSON(200, gin.H{"status": "disconnected"})
}

func (a *App) handleScan(c *gin.Context) {
	var ports []string
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DEVICEMAP\SERIALCOMM`, registry.QUERY_VALUE)
	if err == nil {
		defer k.Close()
		names, _ := k.ReadValueNames(0)
		for _, name := range names {
			val, _, err := k.GetStringValue(name)
			if err == nil {
				ports = append(ports, val)
			}
		}
		sort.Strings(ports)
	}
	c.JSON(200, gin.H{"status": "ok", "ports": ports})
}

func (a *App) handleSetBaud(c *gin.Context) {
	baudStr := c.PostForm("baud")
	baud, err := strconv.Atoi(baudStr)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Invalid baud rate"})
		return
	}
	a.config.Serial.Baud = baud
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleSetPort(c *gin.Context) {
	port := c.PostForm("port")
	if port != "" {
		a.config.Serial.Port = port
	}
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleSetMode(c *gin.Context) {
	mode := c.PostForm("mode")
	if mode == "ascii" || mode == "hex" {
		a.dataMode = mode
		a.broadcast(map[string]interface{}{"type": "mode", "mode": a.dataMode})
	}
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleClear(c *gin.Context) {
	a.broadcast(map[string]interface{}{"type": "clear"})
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleGetConfig(c *gin.Context) {
	c.JSON(200, gin.H{"config": a.config, "connected": a.isConnected, "mode": a.dataMode, "sendHistory": a.sendHistory})
}

func (a *App) handleSaveConfig(c *gin.Context) {
	var newConfig Config
	if err := c.ShouldBindJSON(&newConfig); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to parse configuration: " + err.Error()})
		return
	}

	// Apply defaults if missing
	if newConfig.Serial.Port == "" { newConfig.Serial.Port = "COM1" }
	if newConfig.Serial.Baud == 0 { newConfig.Serial.Baud = 9600 }
	if newConfig.Serial.Databits == 0 { newConfig.Serial.Databits = 8 }
	if newConfig.Serial.Stopbits == 0 { newConfig.Serial.Stopbits = 1 }
	if newConfig.Serial.Parity == "" { newConfig.Serial.Parity = "N" }
	if newConfig.UI.Font == "" { newConfig.UI.Font = "Cascadia Code" }
	if newConfig.UI.FontSize == 0 { newConfig.UI.FontSize = 14 }
	if newConfig.UI.Scrollback == 0 { newConfig.UI.Scrollback = DefaultScrollback }
	if newConfig.Log.Path == "" { newConfig.Log.Path = "./logs" }
	if newConfig.Highlight.Groups == nil { newConfig.Highlight.Groups = []string{"error:#ff0000", "warn:#ffa500", "ok:#00ff00"} }
	if newConfig.Theme.Name == "" { newConfig.Theme.Name = "Default" }

	a.config = newConfig
	file, err := os.Create(a.configFile)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to create config file: " + err.Error()})
		return
	}
	defer file.Close()
	if err := toml.NewEncoder(file).Encode(a.config); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to write config: " + err.Error()})
		return
	}
	baseFile, err := os.Create("config.toml")
	if err == nil {
		defer baseFile.Close()
		toml.NewEncoder(baseFile).Encode(a.config)
	}
	a.broadcast(map[string]interface{}{"type": "config", "config": a.config, "connected": a.isConnected, "mode": a.dataMode})
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleSend(c *gin.Context) {
	data := c.PostForm("data")
	if !a.isConnected || a.port == nil {
		c.JSON(200, gin.H{"status": "error", "message": "Serial port not connected"})
		return
	}

	var sendData []byte
	if a.dataMode == "hex" {
		clean := strings.ReplaceAll(data, " ", "")
		var err error
		sendData, err = hex.DecodeString(clean)
		if err != nil {
			c.JSON(200, gin.H{"status": "error", "message": "Invalid HEX data"})
			return
		}
	} else {
		sendData = []byte(data)
	}

	if len(sendData) == 0 {
		c.JSON(200, gin.H{"status": "error", "message": "Empty payload"})
		return
	}

	select {
	case a.writeChan <- sendData:
	default:
		c.JSON(200, gin.H{"status": "error", "message": "Write queue full"})
		return
	}

	if data != "" && (len(a.sendHistory) == 0 || a.sendHistory[len(a.sendHistory)-1] != data) {
		a.sendHistory = append(a.sendHistory, data)
		if len(a.sendHistory) > 100 {
			a.sendHistory = a.sendHistory[1:]
		}
	}
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) readData() {
	buf := make([]byte, 4096)
	for {
		if a.port == nil {
			return
		}
		n, err := a.port.Read(buf)
		if err != nil {
			if a.port == nil {
				return
			}
			if err == io.EOF {
				return
			}
			if strings.Contains(err.Error(), "timeout") {
				if n == 0 {
					time.Sleep(10 * time.Millisecond)
					continue
				}
			} else {
				time.Sleep(10 * time.Millisecond)
				continue
			}
		}
		if n > 0 {
			data := make([]byte, n)
			copy(data, buf[:n])
			if a.receiveChan != nil {
				a.receiveChan <- data
			}
		}
	}
}

func (a *App) writeLoop() {
	for data := range a.writeChan {
		if a.port == nil {
			continue
		}
		remaining := data
		for len(remaining) > 0 {
			n, err := a.port.Write(remaining)
			if err != nil {
				break
			}
			if n == 0 {
				time.Sleep(5 * time.Millisecond)
			}
			remaining = remaining[n:]
		}
	}
}

func (a *App) processReceiver() {
	const flushInterval = 50 * time.Millisecond
	var pending []byte
	timer := time.NewTimer(flushInterval)
	timer.Stop()
	defer timer.Stop()

	for {
		select {
		case b, ok := <-a.receiveChan:
			if !ok {
				if len(pending) > 0 {
					a.processAndBroadcast(pending)
				}
				return
			}
			pending = append(pending, b...)
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(flushInterval)
			for {
				idx := bytes.IndexByte(pending, '\n')
				if idx < 0 {
					break
				}
				line := pending[:idx+1]
				a.processAndBroadcast(line)
				pending = pending[idx+1:]
			}
		case <-timer.C:
			if len(pending) > 0 {
				a.processAndBroadcast(pending)
				pending = nil
			}
		}
	}
}

func (a *App) processAndBroadcast(data []byte) {
	if len(data) == 0 {
		return
	}
	var msg string
	if a.config.UI.Shell {
		msg = string(data)
	} else {
		if a.dataMode == "hex" {
			hexStr := hex.EncodeToString(data)
			var sb strings.Builder
			for i, r := range hexStr {
				if i > 0 && i%2 == 0 {
					sb.WriteByte(' ')
				}
				sb.WriteRune(r)
			}
			msg = sb.String()
		} else {
			msg = strings.ToValidUTF8(string(data), "")
		}
		if a.config.UI.Timestamp {
			timestamp := time.Now().Format("15:04:05.000")
			msg = fmt.Sprintf("[%s] %s", timestamp, msg)
		}
	}
	a.broadcast(map[string]interface{}{"type": "message", "message": msg})

	if a.scriptEngine != nil && a.scriptEngine.isRunning {
		cleanData := ansiRegex.ReplaceAllString(string(data), "")
		select {
		case a.scriptEngine.serialDataChan <- cleanData:
		default:
		}
	}
}

func (a *App) loadConfig() {
	if _, err := toml.DecodeFile(a.configFile, &a.config); err != nil {
		a.config.Serial.Port = "COM1"
		a.config.Serial.Baud = 9600
		a.config.Serial.Databits = 8
		a.config.Serial.Stopbits = 1
		a.config.Serial.Parity = "N"
		a.config.Log.Path = "./logs"
		a.config.UI.Font = "Cascadia Code"
		a.config.UI.FontSize = 14
		a.config.UI.Timestamp = true
		a.config.UI.Shell = true
		a.config.UI.Scrollback = DefaultScrollback
		a.config.Highlight.Groups = []string{"error:#ff0000", "warn:#ffa500", "ok:#00ff00"}
		a.config.Theme = GetDefaultTheme()
	}

	// Ensure defaults if partially missing
	if a.config.UI.Font == "" { a.config.UI.Font = "Cascadia Code" }
	if a.config.UI.FontSize == 0 { a.config.UI.FontSize = 14 }
	if a.config.UI.Scrollback == 0 { a.config.UI.Scrollback = DefaultScrollback }
	if a.config.Theme.Name == "" { a.config.Theme = GetDefaultTheme() }

	os.MkdirAll(a.config.Log.Path, 0755)
	os.MkdirAll("./scripts", 0755)
}

// ================= SCRIPT ENGINE IMPLEMENTATION =================

/**
 * @brief Creates a new ScriptEngine instance.
 */
func (a *App) NewScriptEngine() *ScriptEngine {
	return &ScriptEngine{
		app: a,
		serialDataChan: make(chan string, 100),
		isRunning: false,
	}
}

/**
 * @brief Registers custom Lua API functions.
 */
func (se *ScriptEngine) registerAPIs(L *lua.LState) {
	// send(data)
	L.SetGlobal("send", L.NewFunction(func(L *lua.LState) int {
		select {
		case <-se.ctx.Done():
			return 0
		default:
		}
		data := L.CheckString(1)
		if se.app.isConnected {
			se.app.writeChan <- []byte(data)
		}
		return 0
	}))

	// delay(ms)
	L.SetGlobal("delay", L.NewFunction(func(L *lua.LState) int {
		ms := L.CheckInt(1)
		select {
		case <-time.After(time.Duration(ms) * time.Millisecond):
		case <-se.ctx.Done():
		}
		return 0
	}))

	// log(msg)
	L.SetGlobal("log", L.NewFunction(func(L *lua.LState) int {
		msg := L.CheckString(1)
		se.app.broadcast(map[string]interface{}{"type": "script_log", "message": msg})
		return 0
	}))

	// wait(target, timeout_ms)
	L.SetGlobal("wait", L.NewFunction(func(L *lua.LState) int {
		target := L.CheckString(1)
		timeoutMs := L.CheckInt(2)
		timeout := time.Duration(timeoutMs) * time.Millisecond
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		for {
			select {
			case data := <-se.serialDataChan:
				if strings.Contains(data, target) {
					L.Push(lua.LBool(true))
					return 1
				}
			case <-timer.C:
				L.Push(lua.LBool(false))
				return 1
			case <-se.ctx.Done():
				L.Push(lua.LBool(false))
				return 1
			}
		}
	}))
}

/**
 * @brief Runs a Lua script from file.
 */
func (se *ScriptEngine) Run(filename string) {
	se.mu.Lock()
	if se.isRunning {
		se.mu.Unlock()
		return
	}
	se.isRunning = true
	se.mu.Unlock()

	se.ctx, se.cancel = context.WithCancel(context.Background())
	L := lua.NewState()
	se.state = L
	se.registerAPIs(L)

	go func() {
		defer func() {
			se.mu.Lock()
			se.isRunning = false
			se.mu.Unlock()
			L.Close()
			se.app.broadcast(map[string]interface{}{"type": "script_log", "message": "🏁 Script execution finished."})
		}()

		if err := L.DoFile(filepath.Join("./scripts", filename)); err != nil {
			se.app.broadcast(map[string]interface{}{"type": "script_log", "message": "❌ Script Error: " + err.Error()})
			return
		}

		mainFn := L.GetGlobal("main")
		if mainFn.Type() == lua.LTFunction {
			if err := L.CallByParam(lua.P{Fn: mainFn, NRet: 0, Protect: true}); err != nil {
				se.app.broadcast(map[string]interface{}{"type": "script_log", "message": "❌ Runtime Error: " + err.Error()})
			}
		}
	}()
}

/**
 * @brief Stops the currently running script.
 */
func (se *ScriptEngine) Stop() {
	se.mu.Lock()
	defer se.mu.Unlock()
	if se.isRunning && se.cancel != nil {
		se.cancel()
		se.app.broadcast(map[string]interface{}{"type": "script_log", "message": "🛑 Script forcefully stopped."})
	}
}

// ================= SCRIPT & THEME HTTP HANDLERS =================

func (a *App) handleListScripts(c *gin.Context) {
	var scripts []string
	files, err := os.ReadDir("./scripts")
	if err == nil {
		for _, f := range files {
			if !f.IsDir() && strings.HasSuffix(f.Name(), ".lua") {
				scripts = append(scripts, f.Name())
			}
		}
	}
	c.JSON(200, gin.H{"status": "ok", "scripts": scripts})
}

func (a *App) handleRunScript(c *gin.Context) {
	filename := c.PostForm("filename")
	if filename == "" {
		c.JSON(200, gin.H{"status": "error", "message": "No filename provided"})
		return
	}
	if a.scriptEngine == nil {
		a.scriptEngine = a.NewScriptEngine()
	}
	a.scriptEngine.Run(filename)
	c.JSON(200, gin.H{"status": "ok"})
}

func (a *App) handleStopScript(c *gin.Context) {
	if a.scriptEngine != nil {
		a.scriptEngine.Stop()
	}
	c.JSON(200, gin.H{"status": "ok"})
}

/**
 * @brief Handles log export to a user-specified file path.
 */
func (a *App) handleExportLog(c *gin.Context) {
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Invalid request: " + err.Error()})
		return
	}
	if req.Path == "" {
		c.JSON(200, gin.H{"status": "error", "message": "File path is required"})
		return
	}

	dir := filepath.Dir(req.Path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to create directory: " + err.Error()})
		return
	}

	if err := os.WriteFile(req.Path, []byte(req.Content), 0644); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to write file: " + err.Error()})
		return
	}

	c.JSON(200, gin.H{"status": "ok", "path": req.Path})
}

/**
 * @brief Returns the default dark theme configuration.
 */
func GetDefaultTheme() Theme {
	return Theme{
		Name: "Default",
		Background: "#1e1e1e",
		Foreground: "#cccccc",
		Cursor: "#ffffff",
		Black: "#000000",
		Red: "#cd3131",
		Green: "#0dbc79",
		Yellow: "#e5e510",
		Blue: "#2472c8",
		Magenta: "#bc3fbc",
		Cyan: "#11a8cd",
		White: "#e5e5e5",
		BrightBlack: "#666666",
		BrightRed: "#f14c4c",
		BrightGreen: "#23d18b",
		BrightYellow: "#f5f543",
		BrightBlue: "#3b8eea",
		BrightMagenta: "#d670d6",
		BrightCyan: "#29b8db",
		BrightWhite: "#ffffff",
	}
}

// ================= LOG FILE MANAGER =================

/**
 * @brief OPENFILENAMEW structure for the native Windows file open dialog.
 */
type OPENFILENAMEW struct {
	LStructSize    uint32
	HwndOwner      syscall.Handle
	HInstance      syscall.Handle
	LpstrFilter    *uint16
	LpstrCustomFilter *uint16
	NMaxCustFilter uint32
	NFilterIndex   uint32
	LpstrFile      *uint16
	NMaxFile       uint32
	LpstrFileTitle *uint16
	NMaxFileTitle  uint32
	LpstrInitialDir *uint16
	LpstrTitle     *uint16
	Flags          uint32
	NFileOffset    uint16
	NFileExtension uint16
	LpstrDefExt    *uint16
	LCustData      uintptr
	LpfnHook       uintptr
	LpTemplateName *uint16
	PvReserved     unsafe.Pointer
	DwReserved     uint32
	FlagsEx        uint32
}

const (
	OFN_FILEMUSTEXIST = 0x1000
	OFN_HIDEREADONLY = 0x4
	OFN_PATHMUSTEXIST = 0x800
)

/**
 * @brief LogFile holds an open file handle and its line byte-offset index.
 */
type LogFile struct {
	path       string
	file       *os.File
	lineIndex  []int64
	totalLines int
}

/**
 * @brief LogFileManager manages multiple open log files, keyed by tab ID.
 */
type LogFileManager struct {
	mu    sync.RWMutex
	files map[string]*LogFile
}

/**
 * @brief Creates a new LogFileManager instance.
 */
func NewLogFileManager() *LogFileManager {
	return &LogFileManager{
		files: make(map[string]*LogFile),
	}
}

/**
 * @brief Opens a file and builds its line index.
 */
func (m *LogFileManager) Open(tabID, path string) (*LogFile, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.files[tabID]; ok {
		existing.file.Close()
		delete(m.files, tabID)
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}

	lf := &LogFile{path: path, file: file}
	lf.lineIndex = buildLineIndex(file)
	lf.totalLines = len(lf.lineIndex)
	m.files[tabID] = lf
	return lf, nil
}

/**
 * @brief Reads a range of lines from the open file.
 */
func (m *LogFileManager) ReadLines(tabID string, start, end int) ([]string, error) {
	m.mu.RLock()
	lf, ok := m.files[tabID]
	m.mu.RUnlock()
	if !ok {
		log.Printf("ReadLines: tab %s not found", tabID)
		return nil, fmt.Errorf("log file not open for tab %s", tabID)
	}
	log.Printf("ReadLines: tab=%s range=[%d,%d) totalLines=%d", tabID, start, end, lf.totalLines)
	if start < 0 || end > lf.totalLines || start >= end {
		log.Printf("ReadLines: invalid range [%d, %d) totalLines=%d", start, end, lf.totalLines)
		return nil, fmt.Errorf("invalid range [%d, %d)", start, end)
	}
	return readLines(lf.file, lf.lineIndex, start, end)
}

/**
 * @brief Searches the entire file for lines matching a regex pattern.
 */
func (m *LogFileManager) Search(tabID, pattern string) ([]map[string]interface{}, error) {
	m.mu.RLock()
	lf, ok := m.files[tabID]
	m.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("log file not open for tab %s", tabID)
	}
	return searchLog(lf.file, pattern)
}

/**
 * @brief Closes a log file and frees its index.
 */
func (m *LogFileManager) Close(tabID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if lf, ok := m.files[tabID]; ok {
		lf.file.Close()
		delete(m.files, tabID)
	}
}

/**
 * @brief Scans a file and builds a byte-offset index for each line start.
 */
func buildLineIndex(file *os.File) []int64 {
	file.Seek(0, 0)
	buf := make([]byte, 64*1024)
	index := []int64{0}
	var offset int64
	for {
		n, err := file.Read(buf)
		for i := 0; i < n; i++ {
			if buf[i] == '\n' {
				index = append(index, offset+int64(i)+1)
			}
		}
		offset += int64(n)
		if n == 0 || err != nil {
			break
		}
	}
	file.Seek(0, 0)
	return index
}

/**
 * @brief Reads lines [start, end) from the file using the line index.
 */
func readLines(file *os.File, index []int64, start, end int) ([]string, error) {
	startOffset := index[start]
	var endOffset int64
	if end < len(index) {
		endOffset = index[end]
	} else {
		info, _ := file.Stat()
		endOffset = info.Size()
	}
	log.Printf("readLines: offsets [%d, %d) len=%d", startOffset, endOffset, endOffset-startOffset)
	file.Seek(startOffset, 0)
	buf := make([]byte, endOffset-startOffset)
	n, err := file.Read(buf)
	log.Printf("readLines: read %d bytes, err=%v", n, err)
	if err != nil && err != io.EOF {
		return nil, err
	}
	text := string(buf[:n])
	lines := strings.Split(text, "\n")
	if len(lines) > (end - start) {
		lines = lines[:end-start]
	}
	log.Printf("readLines: returning %d lines", len(lines))
	return lines, nil
}

/**
 * @brief Searches the entire file for lines matching a regex pattern.
 */
func searchLog(file *os.File, pattern string) ([]map[string]interface{}, error) {
	if pattern == "" {
		return nil, nil
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, err
	}
	file.Seek(0, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	var results []map[string]interface{}
	lineNum := 0
	for scanner.Scan() {
		line := scanner.Text()
		if re.MatchString(line) {
			results = append(results, map[string]interface{}{
				"n":    lineNum,
				"text": line,
			})
			if len(results) >= 100000 {
				break
			}
		}
		lineNum++
	}
	file.Seek(0, 0)
	return results, scanner.Err()
}

// ================= LOG FILE HTTP HANDLERS =================

/**
 * @brief Receives file content from the frontend, writes to a temp file,
 *        and builds the line index.
 */
func (a *App) handleUploadLog(c *gin.Context) {
	var req struct {
		TabID   string `json:"tabId"`
		Name    string `json:"name"`
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	tmpPath := filepath.Join(os.TempDir(), fmt.Sprintf("serialzero_%s_%s", req.TabID, req.Name))
	log.Printf("Uploading log: tabId=%s, name=%s, size=%d, tmp=%s", req.TabID, req.Name, len(req.Content), tmpPath)
	if err := os.WriteFile(tmpPath, []byte(req.Content), 0644); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	lf, err := a.logManager.Open(req.TabID, tmpPath)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"status":     "ok",
		"totalLines": lf.totalLines,
	})
}

/**
 * @brief Opens a native Windows file dialog and returns the selected path.
 */
func (a *App) handleBrowseFile(c *gin.Context) {
	var modComdlg32 = syscall.NewLazyDLL("comdlg32.dll")
	var procGetOpenFileNameW = modComdlg32.NewProc("GetOpenFileNameW")

	filterStr := syscall.StringToUTF16("Log Files (*.log;*.txt)\x00*.log;*.txt\x00All Files (*.*)\x00*.*\x00\x00")
	fileBuf := make([]uint16, 32767)

	ofn := OPENFILENAMEW{
		LStructSize: uint32(unsafe.Sizeof(OPENFILENAMEW{})),
		HwndOwner:   syscall.Handle(appHwnd),
		LpstrFilter: &filterStr[0],
		LpstrFile:   &fileBuf[0],
		NMaxFile:    uint32(len(fileBuf)),
		Flags:       OFN_FILEMUSTEXIST | OFN_HIDEREADONLY | OFN_PATHMUSTEXIST,
	}

	ret, _, _ := procGetOpenFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		c.JSON(200, gin.H{"status": "ok", "path": ""})
		return
	}

	path := syscall.UTF16ToString(fileBuf)
	c.JSON(200, gin.H{"status": "ok", "path": path})
}

/**
 * @brief Opens a log file and builds its line index.
 */
func (a *App) handleOpenLog(c *gin.Context) {
	var req struct {
		TabID string `json:"tabId"`
		Path  string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	lf, err := a.logManager.Open(req.TabID, req.Path)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"status":     "ok",
		"totalLines": lf.totalLines,
		"fileSize":   getFileSize(req.Path),
	})
}

/**
 * @brief Reads a range of lines from an open log file.
 */
func (a *App) handleReadLog(c *gin.Context) {
	var req struct {
		TabID string `json:"tabId"`
		Start int    `json:"start"`
		End   int    `json:"end"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	lines, err := a.logManager.ReadLines(req.TabID, req.Start, req.End)
	log.Printf("ReadLog: tabId=%s, range=[%d,%d), lines=%d, err=%v", req.TabID, req.Start, req.End, len(lines), err)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	result := make([]map[string]interface{}, len(lines))
	for i, line := range lines {
		result[i] = map[string]interface{}{
			"n":    req.Start + i,
			"text": line,
		}
	}

	c.JSON(200, gin.H{"status": "ok", "lines": result})
}

/**
 * @brief Searches an open log file for lines matching a regex.
 */
func (a *App) handleSearchLog(c *gin.Context) {
	var req struct {
		TabID   string `json:"tabId"`
		Pattern string `json:"pattern"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	matches, err := a.logManager.Search(req.TabID, req.Pattern)
	if err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	c.JSON(200, gin.H{"status": "ok", "matches": matches})
}

/**
 * @brief Closes an open log file and frees its resources.
 */
func (a *App) handleCloseLog(c *gin.Context) {
	var req struct {
		TabID string `json:"tabId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": err.Error()})
		return
	}

	a.logManager.Close(req.TabID)
	c.JSON(200, gin.H{"status": "ok"})
}

/**
 * @brief Returns the file size in bytes.
 */
func getFileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

