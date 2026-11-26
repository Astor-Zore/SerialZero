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
	"runtime/debug"
	"unicode/utf16"
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
	QuickCommands []QuickCommand `toml:"quick_commands"`
}

// QuickCommand is a user-defined one-click send button (persisted in config).
type QuickCommand struct {
	Name   string `toml:"name" json:"name"`
	Data   string `toml:"data" json:"data"`
	Suffix string `toml:"suffix" json:"suffix"` // "", "\n", "\r\n" (non-shell mode only)
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
	ioDone        chan struct{}
	httpServer    *http.Server
	ctx           context.Context
	cancel        context.CancelFunc
	scriptEngine  *ScriptEngine
	instancePort  int
	instanceTitle string
	configFile    string
	logManager    *LogFileManager
	sessionLog    *SessionLog
}

// ================= SESSION LOG (auto disk logging) =================

/**
 * @brief SessionLog writes the live serial session to a log file in
 *        ./logs (e.g. COM4_20260322_14-33-34.log). One file per connection.
 *        Writes go through a channel so the broadcast hot path never blocks.
 */
type SessionLog struct {
	mu       sync.Mutex
	file     *os.File
	path     string
	writeCh  chan string
	flushCh  chan chan struct{}
	done     chan struct{}
}

// StartSessionLog creates the session log file and starts the writer goroutine.
func StartSessionLog(port, logDir string, timestamp bool) *SessionLog {
	// Anchor relative log dirs to the exe location: a relative "./logs"
	// resolves against the process CWD, which drifts depending on how the
	// app was launched (shortcut, double-click, different shell) — the
	// write side and the export side then look in different places.
	if !filepath.IsAbs(logDir) {
		if exePath, err := os.Executable(); err == nil {
			logDir = filepath.Join(filepath.Dir(exePath), logDir)
		}
	}
	os.MkdirAll(logDir, 0755)
	name := fmt.Sprintf("%s_%s.log", sanitizeLogName(port), time.Now().Format("20060102_15-04-05"))
	path := filepath.Join(logDir, name)
	file, err := os.Create(path)
	if err != nil {
		log.Printf("SessionLog: failed to create %s: %v", path, err)
		return nil
	}
	sl := &SessionLog{
		file:    file,
		path:    path,
		writeCh: make(chan string, 4096),
		flushCh: make(chan chan struct{}, 1),
		done:    make(chan struct{}),
	}
	go sl.writeLoop()
	log.Printf("SessionLog: started %s", path)
	return sl
}

// sanitizeLogName makes the port name safe for a filename.
func sanitizeLogName(port string) string {
	return strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.' {
			return r
		}
		return '_'
	}, port)
}

func (sl *SessionLog) writeLoop() {
	buf := bufio.NewWriter(sl.file)
	for {
		select {
		case s, ok := <-sl.writeCh:
			if !ok {
				buf.Flush()
				sl.file.Close()
				close(sl.done)
				return
			}
			buf.WriteString(s)
			if buf.Buffered() >= 32*1024 {
				buf.Flush()
			}
		case ack := <-sl.flushCh:
			buf.Flush()
			close(ack)
		case <-time.After(500 * time.Millisecond):
			buf.Flush()
		}
	}
}

// Write queues a line for the session log; never blocks.
func (sl *SessionLog) Write(line string) {
	if sl == nil {
		return
	}
	select {
	case sl.writeCh <- line:
	default: // Drop on overflow rather than block the broadcast path
	}
}

// Close flushes and closes the session log (async-safe).
func (sl *SessionLog) Close() {
	if sl == nil {
		return
	}
	sl.mu.Lock()
	defer sl.mu.Unlock()
	if sl.file == nil {
		return
	}
	close(sl.writeCh)
	<-sl.done
	sl.file = nil
}

// Path returns the current session log file path ("" if closed).
func (sl *SessionLog) Path() string {
	if sl == nil {
		return ""
	}
	sl.mu.Lock()
	defer sl.mu.Unlock()
	if sl.file == nil {
		return ""
	}
	return sl.path
}

// Flush asks the writer goroutine to flush its buffer and waits for the ack.
func (sl *SessionLog) Flush() {
	if sl == nil {
		return
	}
	sl.mu.Lock()
	defer sl.mu.Unlock()
	if sl.file == nil {
		return
	}
	ack := make(chan struct{})
	select {
	case sl.flushCh <- ack:
		<-ack
	case <-time.After(time.Second):
	}
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

// logStripRegex strips ANSI CSI/OSC sequences and non-printable control
// characters (except \n, \r, \t) before writing to the session log file.
var logStripRegex = regexp.MustCompile("\x1b\\[[0-?]*[ -/]*[@-~]|\x1b\\][^\\x07\\x1b]*(\x07|\x1b\\\\)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

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
	procIsWindowVisible = moduser32.NewProc("IsWindowVisible")
	procMoveWindow = moduser32.NewProc("MoveWindow")
	procGetSystemMetrics = moduser32.NewProc("GetSystemMetrics")
	procEnumChildWindows = moduser32.NewProc("EnumChildWindows")
	procSetWindowLongPtrW = moduser32.NewProc("SetWindowLongPtrW")
	procGetWindowLongPtrW = moduser32.NewProc("GetWindowLongPtrW")
	procSetWindowPos = moduser32.NewProc("SetWindowPos")
	procCallWindowProcW = moduser32.NewProc("CallWindowProcW")
	procGetClientRect = moduser32.NewProc("GetClientRect")
	procGetWindowRect = moduser32.NewProc("GetWindowRect")
	procGetWindow = moduser32.NewProc("GetWindow")
	procScreenToClient = moduser32.NewProc("ScreenToClient")
	procReleaseCapture = moduser32.NewProc("ReleaseCapture")
	procGetCursorPos = moduser32.NewProc("GetCursorPos")
	procPostMessageW = moduser32.NewProc("PostMessageW")
	procDefWindowProcW = moduser32.NewProc("DefWindowProcW")
	procIsZoomed = moduser32.NewProc("IsZoomed")
	procSystemParametersInfoW = moduser32.NewProc("SystemParametersInfoW")
	procMonitorFromWindow = moduser32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW   = moduser32.NewProc("GetMonitorInfoW")
	procRegisterClassExW              = moduser32.NewProc("RegisterClassExW")
	procCreateWindowExW               = moduser32.NewProc("CreateWindowExW")
	procLoadCursorW                   = moduser32.NewProc("LoadCursorW")
	procPostQuitMessage               = moduser32.NewProc("PostQuitMessage")
	procSetProcessDpiAwarenessContext = moduser32.NewProc("SetProcessDpiAwarenessContext")
	modole32                 = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx        = modole32.NewProc("CoInitializeEx")
	procCoUninitialize        = modole32.NewProc("CoUninitialize")
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
	SWP_NOACTIVATE = 0x0010

	WM_DESTROY = 0x0002
	WM_SIZE = 0x0005
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
	HTTRANSPARENT = 0xFFFFFFFF
	GW_CHILD = 5
	GW_HWNDNEXT = 2
	GWLP_WNDPROC = 0xFFFFFFFC
)

type RECT struct {
	Left, Top, Right, Bottom int32
}

// WNDCLASSEXW for registering our own top-level window class.
type WNDCLASSEXW struct {
	CbSize         uint32
	Style          uint32
	LpfnWndProc    uintptr
	CbClsExtra     int32
	CbWndExtra     int32
	HInstance      uintptr
	HIcon          uintptr
	HCursor        uintptr
	HbrBackground  uintptr
	LpszMenuName   *uint16
	LpszClassName  *uint16
	HIconSm        uintptr
}

// Keep the class-name buffer alive globally (pointer is stored in the OS).
var serialClassName, _ = syscall.UTF16PtrFromString("SerialZeroWnd")

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

// MONITORINFO: cbSize must be set before calling GetMonitorInfoW.
type MONITORINFO struct {
	CbSize    uint32
	RcMonitor RECT
	RcWork    RECT
	DwFlags   uint32
}

const MONITOR_DEFAULTTONEAREST = 2

var appHwnd uintptr = 0

// Manual-maximize state (SW_MAXIMIZE is not used; see toggleMaximizeWindow).
var wasMaximizedManual = false
var maximizedBeforeMaximize = RECT{}

// getWindowRect helper; returns zero RECT on failure.
func getWindowRect(hwnd uintptr) RECT {
	var r RECT
	ret, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	if ret == 0 {
		return RECT{}
	}
	return r
}
var wndProcCallback uintptr = 0

// Callbacks for hiding/showing child windows recursively
func showChildWindowProc(hwnd syscall.Handle, lparam uintptr) uintptr {
	procShowWindow.Call(uintptr(hwnd), SW_SHOW)
	return 1
}

var showChildCallback = syscall.NewCallback(showChildWindowProc)

// Moves the DIRECT child windows to fill the client area of hwnd.
// EnumChildWindows must NOT be used here: it enumerates ALL descendants
// recursively, and forcing Chromium's internal window hierarchy into one
// rectangle corrupts the WebView2 layout (that was the "tiny content after
// restore" bug). We walk only the first-level children via GW_CHILD.
func resizeChildWindows(hwnd uintptr) {
	var rect RECT
	r1, _, _ := procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rect)))
	if r1 == 0 {
		return
	}
	child, _, _ := procGetWindow.Call(hwnd, uintptr(GW_CHILD))
	for child != 0 {
		procMoveWindow.Call(child, 0, 0, uintptr(rect.Right-rect.Left), uintptr(rect.Bottom-rect.Top), 1)
		child, _, _ = procGetWindow.Call(child, uintptr(GW_HWNDNEXT))
	}
}

// (Removed: WebView2 window-tree subclassing for HTCAPTION. Hit-test bubbling
// through the Chromium window tree does not work reliably; dragging is
// instead initiated explicitly - see the startWindowDrag bind.)

/**
 * @brief Creates the hidden frameless top-level window that WebView2 embeds into.
 *        Creating it ourselves (without WS_VISIBLE) means webview_go's internal
 *        ShowWindow(SW_SHOW) during webview_create is skipped entirely - that
 *        was the source of the white flash at startup.
 */
func createAppWindow(title string, width, height int) uintptr {
	wndProcCallback = syscall.NewCallback(windowProc)
	hInstance, _, _ := procGetModuleHandleW.Call(uintptr(0))
	arrow, _, _ := procLoadCursorW.Call(uintptr(0), uintptr(32512)) // IDC_ARROW
	wc := WNDCLASSEXW{}
	wc.CbSize = uint32(unsafe.Sizeof(wc))
	wc.LpfnWndProc = wndProcCallback
	wc.HInstance = hInstance
	wc.HCursor = arrow
	wc.LpszClassName = serialClassName
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

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

	// No WS_CAPTION / WS_SYSMENU and no WS_VISIBLE: frameless from birth and
	// hidden until the frontend signals /ready. WS_THICKFRAME keeps the
	// resize borders (JS resize handles drive the actual resizing).
	style := uintptr(WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	hwnd, _, _ := procCreateWindowExW.Call(0,
		uintptr(unsafe.Pointer(serialClassName)),
		uintptr(unsafe.Pointer(titlePtr)),
		style,
		uintptr(posX), uintptr(posY), uintptr(width), uintptr(height),
		0, 0, hInstance, 0)

	// Force a frame recalculation NOW: WM_NCCALCSIZE is only sent during a
	// frame-changing SetWindowPos. Without this the WS_THICKFRAME non-client
	// border keeps its default metrics and stays visible until some later
	// interaction triggers a re-layout.
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0,
		uintptr(SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED))

	return hwnd
}

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
 * @brief Window procedure for our frameless window. WM_NCCALCSIZE->0
 *        extends the client area over the whole window; WM_NCHITTEST maps
 *        the top 32px to HTCAPTION so the OS handles dragging natively
 *        (WebView2 does not support -webkit-app-region: drag).
 */
func windowProc(hwnd syscall.Handle, msg uint32, wparam uintptr, lparam uintptr) uintptr {
	if msg == WM_NCCALCSIZE && wparam != 0 {
		return 0
	}
	if msg == WM_SIZE {
		// Keep the WebView2 child widget filling the client area.
		resizeChildWindows(uintptr(hwnd))
	}
	if msg == WM_DESTROY {
		// Our own window class: end the webview message loop on close.
		procPostQuitMessage.Call(0)
		return 0
	}
	if msg == WM_GETMINMAXINFO {
		// Use the work area of the monitor the window is on, not the primary
		// monitor's (SPI_GETWORKAREA): on multi-monitor setups maximizing on a
		// secondary monitor would otherwise size the window to the primary
		// monitor's work area — overflowing the statusbar off the screen.
		var rect RECT
		mon, _, _ := procMonitorFromWindow.Call(uintptr(hwnd), uintptr(MONITOR_DEFAULTTONEAREST))
		if mon != 0 {
			mi := MONITORINFO{CbSize: uint32(unsafe.Sizeof(MONITORINFO{}))}
			r1, _, _ := procGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi)))
			if r1 != 0 {
				rect = mi.RcWork
			} else {
				procSystemParametersInfoW.Call(uintptr(SPI_GETWORKAREA), 0, uintptr(unsafe.Pointer(&rect)), 0)
			}
		} else {
			procSystemParametersInfoW.Call(uintptr(SPI_GETWORKAREA), 0, uintptr(unsafe.Pointer(&rect)), 0)
		}
		mmi := (*MINMAXINFO)(unsafe.Pointer(lparam))
		mmi.ptMaxPosition.X = rect.Left
		mmi.ptMaxPosition.Y = rect.Top
		mmi.ptMaxSize.X = rect.Right - rect.Left
		mmi.ptMaxSize.Y = rect.Bottom - rect.Top
		mmi.ptMinTrackSize.X = 200
		mmi.ptMinTrackSize.Y = 100
		return 0
	}
	if msg == WM_NCHITTEST {
		// Let the OS compute the default hit code first: with WS_THICKFRAME and
		// WM_NCCALCSIZE->0 the default proc still returns the resize-edge codes
		// (HTLEFT/HTRIGHT/...) for the window borders, and HTCLIENT inside.
		ret, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wparam, lparam)
		if ret == uintptr(HTCLIENT) {
			// Screen coords are packed in lparam (signed shorts).
			x := int16(uint16(lparam & 0xFFFF))
			y := int16(uint16((lparam >> 16) & 0xFFFF))
			pt := POINT{int32(x), int32(y)}
			procScreenToClient.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&pt)))
			if pt.Y < 32 {
				// Top 32px of the client area acts as the caption bar: the OS
				// then owns dragging natively (DPI-correct across monitors).
				// WebView2 does NOT support -webkit-app-region: drag.
				return uintptr(HTCAPTION)
			}
		}
		return ret
	}
	ret, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wparam, lparam)
	return ret
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

	// Per-monitor DPI awareness: all coordinates (JS screenX, MoveWindow,
	// GetWindowRect) become physical pixels - fixes the window offset when
	// dragging across monitors with different DPI.
	procSetProcessDpiAwarenessContext.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2

	// Initialize COM (STA) on this thread BEFORE creating the webview: with an
	// external HWND, the webview library skips its own CoInitialize, and
	// CreateCoreWebView2Environment requires it.
	procCoInitializeEx.Call(0, uintptr(0x2)) // COINIT_APARTMENTTHREADED

	// Create the hidden frameless window BEFORE webview so it embeds into it
	// without ever showing it (no white flash).
	appHwnd = createAppWindow(instanceTitle, 1024, 768)
	w := webview.NewWindow(true, unsafe.Pointer(appHwnd))
	defer w.Destroy()

	w.Bind("minimizeWindow", func() {
		procShowWindow.Call(appHwnd, uintptr(SW_MINIMIZE))
	})
	w.Bind("maximizeWindow", func() {
		if wasMaximizedManual {
			return
		}
		// Same manual maximize as toggleMaximizeWindow (see comment there).
		mon, _, _ := procMonitorFromWindow.Call(appHwnd, uintptr(MONITOR_DEFAULTTONEAREST))
		if mon == 0 {
			procShowWindow.Call(appHwnd, uintptr(SW_MAXIMIZE))
			return
		}
		mi := MONITORINFO{CbSize: uint32(unsafe.Sizeof(MONITORINFO{}))}
		r1, _, _ := procGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi)))
		if r1 == 0 {
			procShowWindow.Call(appHwnd, uintptr(SW_MAXIMIZE))
			return
		}
		maximizedBeforeMaximize = getWindowRect(appHwnd)
		wasMaximizedManual = true
		procSetWindowPos.Call(
			appHwnd, 0,
			uintptr(mi.RcWork.Left), uintptr(mi.RcWork.Top),
			uintptr(mi.RcWork.Right-mi.RcWork.Left), uintptr(mi.RcWork.Bottom-mi.RcWork.Top),
			uintptr(SWP_NOZORDER|SWP_NOACTIVATE))
		resizeChildWindows(appHwnd)
	})
	w.Bind("toggleMaximizeWindow", func() {
		if wasMaximizedManual {
			wasMaximizedManual = false
			if r := maximizedBeforeMaximize; r != (RECT{}) {
				procSetWindowPos.Call(
					appHwnd, 0,
					uintptr(r.Left), uintptr(r.Top),
					uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top),
					uintptr(SWP_NOZORDER|SWP_NOACTIVATE))
			} else {
				procShowWindow.Call(appHwnd, uintptr(SW_RESTORE))
			}
			resizeChildWindows(appHwnd)
			return
		}
		// Manual maximize instead of SW_MAXIMIZE: with WM_NCCALCSIZE->0 the OS
		// maximizes WS_THICKFRAME windows to the work area PLUS the resize
		// border, so our frameless client spills off-screen (statusbar cut on
		// the primary, whole window off-screen on secondary monitors). Place
		// the window exactly on the work area of its current monitor instead.
		mon, _, _ := procMonitorFromWindow.Call(appHwnd, uintptr(MONITOR_DEFAULTTONEAREST))
		if mon == 0 {
			procShowWindow.Call(appHwnd, uintptr(SW_MAXIMIZE))
			return
		}
		mi := MONITORINFO{CbSize: uint32(unsafe.Sizeof(MONITORINFO{}))}
		r1, _, _ := procGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi)))
		if r1 == 0 {
			procShowWindow.Call(appHwnd, uintptr(SW_MAXIMIZE))
			return
		}
		// Remember the normal position so we can restore it later.
		maximizedBeforeMaximize = getWindowRect(appHwnd)
		wasMaximizedManual = true
		procSetWindowPos.Call(
			appHwnd, 0,
			uintptr(mi.RcWork.Left), uintptr(mi.RcWork.Top),
			uintptr(mi.RcWork.Right-mi.RcWork.Left), uintptr(mi.RcWork.Bottom-mi.RcWork.Top),
			uintptr(SWP_NOZORDER|SWP_NOACTIVATE))
		resizeChildWindows(appHwnd)
	})
	w.Bind("closeWindow", func() {
		procPostMessageW.Call(appHwnd, uintptr(WM_CLOSE), 0, 0)
	})
	// Native drag: called from JS on titlebar mousedown. Enters the OS's
	// modal move loop directly (same as clicking a real caption), bypassing
	// WebView2's hit-test entirely. DPI-correct across monitors.
	w.Bind("startWindowDrag", func() {
		// If manually maximized, un-maximize first so the window can be
		// dragged (a maximized window doesn't move). Restore to the normal
		// position, nudged so the title stays under the cursor.
		if wasMaximizedManual {
			wasMaximizedManual = false
			r := maximizedBeforeMaximize
			var pt POINT
			procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
			if r != (RECT{}) {
				procSetWindowPos.Call(
					appHwnd, 0,
					uintptr(int32(pt.X)-64), uintptr(int32(pt.Y)-16),
					uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top),
					uintptr(SWP_NOZORDER|SWP_NOACTIVATE))
				resizeChildWindows(appHwnd)
			}
		}
		// Execute on the UI thread that owns the window: the modal move loop
		// entered by DefWindowProc(WM_NCLBUTTONDOWN) only behaves correctly on
		// the thread that created the window (Go bind callbacks otherwise run
		// on a webview worker thread).
		w.Dispatch(func() {
			log.Println("drag: dispatched on UI thread, hwnd =", appHwnd)
			procReleaseCapture.Call()
			var pt POINT
			procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
			// lparam for WM_NCLBUTTONDOWN packs the cursor screen coords.
			lparam := uintptr(uint16(uint32(pt.X))) | (uintptr(uint16(uint32(pt.Y))) << 16)
			procSendMessageW.Call(appHwnd, uintptr(WM_NCLBUTTONDOWN), uintptr(HTCAPTION), lparam)
			log.Println("drag: WM_NCLBUTTONDOWN sent at", pt.X, pt.Y)
		})
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
	// The WebView2 widget is created 0x0; stretch it to our client area once.
	resizeChildWindows(appHwnd)

	// 4. Fallback: force show after 5 seconds if frontend fails to signal
	go func() {
		time.Sleep(5 * time.Second)
		if appHwnd != 0 {
			visible, _, _ := procIsWindowVisible.Call(appHwnd)
			if visible == 0 {
				procShowWindow.Call(appHwnd, SW_SHOW)
				procEnumChildWindows.Call(appHwnd, showChildCallback, 0)
			}
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
	// Route gin's own output (incl. panic stack traces from Recovery) to the
	// same log file — stderr is invisible under -H windowsgui.
	if exePath, _ := os.Executable(); exePath != "" {
		if f, err := os.OpenFile(filepath.Join(filepath.Dir(exePath), "serialzero.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644); err == nil {
			gin.DefaultErrorWriter = f
			gin.DefaultWriter = f
		}
	}
	staticFS, err := fs.Sub(staticEmbed, "static")
	if err != nil {
		log.Printf("Failed to get static sub-fs: %v", err)
		return
	}
	r.StaticFS("/static", http.FS(staticFS))
	// Prevent WebView2/browser from serving stale embedded assets (no mtime → heuristic caching)
	r.Use(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/static/") || c.Request.URL.Path == "/" {
			c.Header("Cache-Control", "no-store")
		}
		c.Next()
	})
	r.GET("/", func(c *gin.Context) {
		c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(indexHTML))
	})

	// Endpoint to receive frontend ready signal and show main window smoothly
	r.POST("/ready", func(c *gin.Context) {
		go func() {
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
	r.POST("/listfonts", a.handleListFonts)
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
	r.POST("/exportsession", a.handleExportSession)
	r.POST("/uploadlog", a.handleUploadLog)
	r.POST("/browsefile", a.handleBrowseFile)
	r.POST("/browsesavefile", a.handleBrowseSaveFile)
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
	a.sessionLog = StartSessionLog(a.config.Serial.Port, a.config.Log.Path, a.config.UI.Timestamp)
	a.ioDone = make(chan struct{})
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
	if a.sessionLog != nil {
		a.sessionLog.Close()
		a.sessionLog = nil
	}
	if a.port != nil {
		a.port.Close()
		a.port = nil
	}
	a.isConnected = false
	if a.ioDone != nil {
		close(a.ioDone) // signal reader/processor/writer goroutines to exit
		a.ioDone = nil
	}
	// Do NOT close writeChan/receiveChan: goroutines may still be blocked on
	// them; they exit via ioDone instead. New channels are created on connect.
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

// ================= SYSTEM FONT ENUMERATION =================

var (
	modgdi32                  = syscall.NewLazyDLL("gdi32.dll")
	procEnumFontFamiliesExW   = modgdi32.NewProc("EnumFontFamiliesExW")
	procCreateCompatibleDC    = modgdi32.NewProc("CreateCompatibleDC")
	procDeleteDC              = modgdi32.NewProc("DeleteDC")
)

const (
	FONT_CHARSET_DEFAULT    = 1 // DEFAULT_CHARSET
	TRUETYPE_FONTTYPE        = 0x4
)

// ENUMLOGFONTExW + NEWTEXTMETRICEXW as passed to the EnumFontFamiliesEx
// callback. We only need the names and the font-type flags.
type enumLogFontExW struct {
	elfLogFont    LOGFONTW
	elfFullName   [64 + 4]uint16 // 64 WCHARs, 4-byte aligned
	elfStyle      [32]uint16
	elfScript     [32]uint16
}

type LOGFONTW struct {
	Height         int32
	Width          int32
	Escapement     int32
	Orientation    int32
	Weight         int32
	Italic         uint8
	Underline      uint8
	StrikeOut      uint8
	CharSet        uint8
	OutPrecision   uint8
	ClipPrecision  uint8
	Quality        uint8
	PitchAndFamily uint8
	FaceName       [32]uint16
}

type newTextMetricExW struct {
	// NEWTEXTMETRICW: 13 DWORDs + 3 BYTEs + padding; layout identical for
	// our purposes - we don't read it, only keep the struct size stable.
	_ [76]byte
}

var _ = newTextMetricExW{}

var monoFontList []string
var monoFontOnce sync.Once

// enumFontProc is the callback for EnumFontFamiliesExW: adds every
// TrueType monospaced face to monoFontList.
func enumFontProc(lpLogfont uintptr, lpntm uintptr, dwType uintptr, lParam uintptr) uintptr {
	if dwType&TRUETYPE_FONTTYPE == 0 {
		return 1 // keep enumerating: skip non-TrueType (bitmap/raster) fonts
	}
	elf := (*enumLogFontExW)(unsafe.Pointer(lpLogfont))
	// FIXED_PITCH bit is 0x01 in PitchAndFamily (0 = fixed-pitch; 1 = variable).
	if elf.elfLogFont.PitchAndFamily&0x01 != 0 {
		return 1 // not monospaced
	}
	name := syscall.UTF16ToString(elf.elfLogFont.FaceName[:])
	if name != "" && !seenFonts[name] {
		seenFonts[name] = true
		monoFontList = append(monoFontList, name)
	}
	return 1
}

var seenFonts = map[string]bool{}

func listMonospaceFonts() []string {
	monoFontOnce.Do(func() {
		hdc, _, _ := procCreateCompatibleDC.Call(0)
		if hdc == 0 {
			return
		}
		defer procDeleteDC.Call(hdc)

		lf := LOGFONTW{}
		lf.CharSet = FONT_CHARSET_DEFAULT
		// PitchAndFamily: FIXED_PITCH (2) | FF_DONTCARE (0). In LOGFONT for
		// enumeration, pitch bits: DEFAULT_PITCH=0, FIXED_PITCH=1, VARIABLE=2.
		lf.PitchAndFamily = 0x01 // FIXED_PITCH

		// The callback must be a syscall.Syscall-like function. golang-lazydll
		// syscall.NewCallback gives us one; wrap it here.
		cb := syscall.NewCallback(enumFontProc)
		procEnumFontFamiliesExW.Call(
			hdc,
			uintptr(unsafe.Pointer(&lf)),
			cb,
			0,
			0)
		sort.Strings(monoFontList)
	})
	return monoFontList
}

func (a *App) handleListFonts(c *gin.Context) {
	c.JSON(200, gin.H{"status": "ok", "fonts": listMonospaceFonts()})
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

	if a.sessionLog != nil {
		a.sessionLog.Write(">>> " + logStripRegex.ReplaceAllString(string(sendData), "") + "\n")
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
		select {
		case <-a.ioDone:
			return
		default:
		}
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
			select {
			case a.receiveChan <- data:
			case <-a.ioDone:
				return
			}
		}
	}
}

func (a *App) writeLoop() {
	for {
		select {
		case <-a.ioDone:
			return
		case data := <-a.writeChan:
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
}

func (a *App) processReceiver() {
	const flushInterval = 50 * time.Millisecond
	var pending []byte
	timer := time.NewTimer(flushInterval)
	timer.Stop()
	defer timer.Stop()

	for {
		select {
		case <-a.ioDone:
			if len(pending) > 0 {
				a.processAndBroadcast(pending)
			}
			return
		case b := <-a.receiveChan:
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

	if a.sessionLog != nil {
		clean := logStripRegex.ReplaceAllString(string(data), "")
		if a.config.UI.Shell {
			a.sessionLog.Write(clean)
		} else if a.dataMode == "hex" {
			a.sessionLog.Write(msg + "\n")
		} else {
			a.sessionLog.Write(msg + "\n")
		}
	}

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
			select {
			case se.app.writeChan <- []byte(data):
			case <-se.ctx.Done():
			}
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
		se.app.broadcast(map[string]interface{}{"type": "script_log", "message": "⚠️ A script is already running."})
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
		/* Mark stopped immediately: the script goroutine may take a moment to unwind
		(e.g. blocked inside send()/wait()); without this, a subsequent Run() is silently
		swallowed by the isRunning check while the old goroutine is still exiting. */
		se.isRunning = false
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
 * @brief Copies the current session log file to a user-specified path.
 *        The frontend never assembles the content itself — zero main-thread cost.
 */
func (a *App) handleExportSession(c *gin.Context) {
	var req struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Invalid request: " + err.Error()})
		return
	}
	if req.Path == "" {
		c.JSON(200, gin.H{"status": "error", "message": "File path is required"})
		return
	}
	src := a.sessionLog.Path()
	if src == "" {
		// Session already closed — fall back to the most recent log for this port.
		globDir := a.config.Log.Path
		if !filepath.IsAbs(globDir) {
			if exePath, err := os.Executable(); err == nil {
				globDir = filepath.Join(filepath.Dir(exePath), globDir)
			}
		}
		matches, _ := filepath.Glob(filepath.Join(globDir, sanitizeLogName(a.config.Serial.Port)+"_*.log"))
		if len(matches) > 0 {
			sort.Strings(matches)
			src = matches[len(matches)-1]
		}
	}
	if src == "" {
		c.JSON(200, gin.H{"status": "error", "message": "No session log available (was the port ever connected?)"})
		return
	}
	a.sessionLog.Flush() // ensure buffered lines are on disk before copying
	if err := copyFile(src, req.Path); err != nil {
		c.JSON(200, gin.H{"status": "error", "message": "Failed to copy log: " + err.Error()})
		return
	}
	c.JSON(200, gin.H{"status": "ok", "path": req.Path, "source": src, "lines": nil})
}

// copyFile streams src to dst without loading it all into memory.
func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	buf := make([]byte, 1024*1024)
	_, err = io.CopyBuffer(out, in, buf)
	return err
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
	OFN_OVERWRITEPROMPT = 0x2
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
 * @brief Opens a native Windows Save-As dialog and returns the chosen path.
 */
func (a *App) handleBrowseSaveFile(c *gin.Context) {
	// Catch any panic HERE and write it to serialzero.log — gin.Recovery()
	// returns 500 but its stack trace is lost under -H windowsgui, which is
	// exactly why this bug was invisible so far.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("browsesavefile PANIC: %v\n%s", r, debug.Stack())
			c.JSON(200, gin.H{"status": "error", "message": fmt.Sprintf("panic: %v", r)})
		}
	}()
	log.Printf("browsesavefile: handler entered, appHwnd=%d", appHwnd)
	// The legacy GetSaveFileNameW is forwarded to the COM-based IFileDialog on
	// modern Windows; it silently fails unless this thread has initialized COM.
	// Gin worker goroutines never do, so init here.
	// Only pair CoUninitialize with a genuine S_OK — S_FALSE means the thread
	// was already initialized (someone else owns the balance).
	hr, _, _ := procCoInitializeEx.Call(0, uintptr(0x2)) // COINIT_APARTMENTTHREADED
	if hr == 0 {
		defer func() { procCoUninitialize.Call() }()
	}
	log.Printf("browsesavefile: CoInitializeEx hr=0x%x", hr)
	var modComdlg32 = syscall.NewLazyDLL("comdlg32.dll")
	var procGetSaveFileNameW = modComdlg32.NewProc("GetSaveFileNameW")

	var req struct {
		DefaultName string `json:"defaultName"`
	}
	_ = c.ShouldBindJSON(&req) // optional body

	// syscall.StringToUTF16 PANICS on the embedded NULs that Win32 filter
	// strings require (double-NUL-terminated list) — build it by hand.
	filterUTF16 := func(s string) []uint16 {
		u := make([]uint16, 0, len(s)+1)
		for _, r := range s {
			if r == 0 {
				u = append(u, 0)
			} else {
				u = append(u, utf16.Encode([]rune{r})...)
			}
		}
		return u
	}
	filterParts := []string{"Log Files (*.log;*.txt)", "\x00", "*.log;*.txt", "\x00", "All Files (*.*)", "\x00", "*.*", "\x00", "\x00"}
	var filterBuf []uint16
	for _, p := range filterParts {
		filterBuf = append(filterBuf, filterUTF16(p)...)
	}
	fileBuf := make([]uint16, 32767)
	if req.DefaultName != "" {
		// StringToUTF16 panics on embedded NULs; the frontend can send them
		// (e.g. a stale path in the input). Strip and cap the length.
		name := strings.ReplaceAll(req.DefaultName, "\x00", "")
		if len(name) > 4096 {
			name = name[:4096]
		}
		utf16s := syscall.StringToUTF16(name)
		copy(fileBuf, utf16s)
	}

	ofn := OPENFILENAMEW{
		LStructSize: uint32(unsafe.Sizeof(OPENFILENAMEW{})),
		HwndOwner:   syscall.Handle(appHwnd),
		LpstrFilter: &filterBuf[0],
		LpstrFile:   &fileBuf[0],
		NMaxFile:    uint32(len(fileBuf)),
		Flags:       OFN_OVERWRITEPROMPT | OFN_HIDEREADONLY | OFN_PATHMUSTEXIST,
	}

	ret, _, _ := procGetSaveFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		// Distinguish "user cancelled" from a real failure (e.g. bad struct
		// layout, invalid owner HWND): 0 error code = cancel.
		procCommDlgExtendedError := modComdlg32.NewProc("CommDlgExtendedError")
		errCode, _, _ := procCommDlgExtendedError.Call()
		if errCode != 0 {
			c.JSON(200, gin.H{"status": "error", "message": fmt.Sprintf("dialog failed (CommDlg error %d)", errCode)})
			return
		}
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

