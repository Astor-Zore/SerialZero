// app.js
let ws;
let historyList = [];
let historyIndex = 0;
let isConnected = false;
let currentMode = 'ascii';
let shellEnabled = false;
let timestampEnabled = true;
let pendingMessages = [];
let updateTimer = null;
let outputMessages = [];
let term = null;
let fitAddon = null;
let xtermLoaded = false;
let userActionLock = false;
let isScriptRunning = false;
let timeGutter = null;

// --- Filter Feature State ---
let isFilterEnabled = false;
let filterRegex = null;
let filterUpdateTimer = null;

// --- Log Tab State ---
let currentTab = 'main';
let logTabs = {};

// --- Highlight performance optimization ---
let combinedHighlightRegex = null;
let highlightColorMap = [];

// --- Performance Config ---
const MAX_OUTPUT_LINES = 50000;
const FLUSH_BATCH_SIZE = 100;
let outputTrimOffset = 0;

// --- DOM References ---
let termContainer = document.getElementById('terminal-container');
let outputContainer = document.getElementById('output-container');
let inputArea = document.getElementById('input-area');
let shellArea = document.getElementById('shell-area');
let timeGutterEl = document.getElementById('time-gutter');
let filterPanel = document.getElementById('filter-panel');
let filterOutput = document.getElementById('filter-output');
let filterInput = document.getElementById('filter-input');

const DEFAULT_FONT_STACK = "Consolas, 'Cascadia Code', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";

const themePresets = {
    "Default": { Background: "#1e1e1e", Foreground: "#cccccc", Cursor: "#ffffff", Black: "#000000", Red: "#cd3131", Green: "#0dbc79", Yellow: "#e5e510", Blue: "#2472c8", Magenta: "#bc3fbc", Cyan: "#11a8cd", White: "#e5e5e5", BrightBlack: "#666666", BrightRed: "#f14c4c", BrightGreen: "#23d18b", BrightYellow: "#f5f543", BrightBlue: "#3b8eea", BrightMagenta: "#d670d6", BrightCyan: "#29b8db", BrightWhite: "#ffffff" },
    "Dracula": { Background: "#282a36", Foreground: "#f8f8f2", Cursor: "#f8f8f2", Black: "#21222c", Red: "#ff5555", Green: "#50fa7b", Yellow: "#f1fa8c", Blue: "#bd93f9", Magenta: "#ff79c6", Cyan: "#8be9fd", White: "#f8f8f2", BrightBlack: "#6272a4", BrightRed: "#ff6e6e", BrightGreen: "#69ff94", BrightYellow: "#ffffa5", BrightBlue: "#d6acff", BrightMagenta: "#ff92df", BrightCyan: "#a4ffff", BrightWhite: "#ffffff" },
    "Monokai": { Background: "#272822", Foreground: "#f8f8f2", Cursor: "#f8f8f0", Black: "#272822", Red: "#f92672", Green: "#a6e22e", Yellow: "#f4bf75", Blue: "#66d9ef", Magenta: "#ae81ff", Cyan: "#a1efe4", White: "#f8f8f2", BrightBlack: "#75715e", BrightRed: "#fd971f", BrightGreen: "#a6e22e", BrightYellow: "#e6db74", BrightBlue: "#66d9ef", BrightMagenta: "#ae81ff", BrightCyan: "#a1efe4", BrightWhite: "#f9f8f5" },
    "Solarized": { Background: "#002b36", Foreground: "#839496", Cursor: "#93a1a1", Black: "#073642", Red: "#dc322f", Green: "#859900", Yellow: "#b58900", Blue: "#268bd2", Magenta: "#d33682", Cyan: "#2aa198", White: "#eee8d5", BrightBlack: "#002b36", BrightRed: "#cb4b16", BrightGreen: "#586e75", BrightYellow: "#657b83", BrightBlue: "#839496", BrightMagenta: "#6c71c4", BrightCyan: "#93a1a1", BrightWhite: "#fdf6e3" },
    "Gruvbox": { Background: "#282828", Foreground: "#ebdbb2", Cursor: "#ebdbb2", Black: "#282828", Red: "#cc241d", Green: "#98971a", Yellow: "#d79921", Blue: "#458588", Magenta: "#b16286", Cyan: "#689d6a", White: "#a89984", BrightBlack: "#928374", BrightRed: "#fb4934", BrightGreen: "#b8bb26", BrightYellow: "#fabd2f", BrightBlue: "#83a598", BrightMagenta: "#d3869b", BrightCyan: "#8ec07c", BrightWhite: "#ebdbb2" },
    "Nord": { Background: "#2e3440", Foreground: "#d8dee9", Cursor: "#d8dee9", Black: "#3b4252", Red: "#bf616a", Green: "#a3be8c", Yellow: "#ebcb8b", Blue: "#81a1c1", Magenta: "#b48ead", Cyan: "#88c0d0", White: "#e5e9f0", BrightBlack: "#4c566a", BrightRed: "#bf616a", BrightGreen: "#a3be8c", BrightYellow: "#ebcb8b", BrightBlue: "#81a1c1", BrightMagenta: "#b48ead", BrightCyan: "#8fbcbb", BrightWhite: "#eceff4" }
};

document.addEventListener('DOMContentLoaded', function() {
    try { if (typeof Terminal !== 'undefined' && typeof FitAddon !== 'undefined') { xtermLoaded = true; } else { xtermLoaded = false; console.error('xterm.js or FitAddon not found!'); } } catch (e) { xtermLoaded = false; }
    syncShellUI(shellEnabled);
    initWebSocket();
    setupEventListeners();
    setupKeyboardShortcuts();
    loadConfig();
    addConfigChangeListeners();
    setupSmartCopy();
    setupSidebarFocusManagement();
    listScripts();
    setupFilterPanel();
    setupHighlightTools();
});

// ================= HIGHLIGHT TOOLS LOGIC =================
function setupHighlightTools() {
    const colorPicker = document.getElementById('color-picker');
    const hint = document.getElementById('color-picker-hint');
    colorPicker.addEventListener('input', (e) => {
        const color = e.target.value;
        navigator.clipboard.writeText(color).then(() => {
            hint.textContent = `Copied ${color}`;
            setTimeout(() => hint.textContent = "Click to copy HEX", 2000);
        });
    });
    setupHighlightPreview();
}

function setupHighlightPreview() {
    const textarea = document.getElementById('highlight-input');
    const previewStrip = document.getElementById('highlight-preview-strip');
    textarea.addEventListener('input', renderHighlightPreviewStrip);
    textarea.addEventListener('scroll', () => { previewStrip.scrollTop = textarea.scrollTop; });
}

function renderHighlightPreviewStrip() {
    const textarea = document.getElementById('highlight-input');
    const previewStrip = document.getElementById('highlight-preview-strip');
    if(!textarea || !previewStrip) return;
    const lines = textarea.value.split('\n');
    previewStrip.innerHTML = '';
    lines.forEach(line => {
        const block = document.createElement('div');
        block.className = 'preview-color-block';
        const parts = line.split(':');
        if (parts.length >= 2) {
            let color = parts[parts.length - 1].trim();
            if (color.startsWith('#') || color.startsWith('rgb') || color.startsWith('hsl')) { block.style.backgroundColor = color; }
        }
        previewStrip.appendChild(block);
    });
}

// ================= TAB LOGIC =================
function switchTab(tabId) {
    currentTab = tabId;
    const terminalWrapper = document.getElementById('terminal-wrapper');
    const logContainer = document.getElementById('log-views-container');
    const sidebar = document.getElementById('sidebar');
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`.tab[data-tab="${tabId}"]`);
    if (activeTab) activeTab.classList.add('active');
    Object.keys(logTabs).forEach(id => { const view = document.getElementById(id); if (view) view.style.display = 'none'; });
    if (tabId === 'main') {
        terminalWrapper.style.display = 'flex'; logContainer.style.display = 'none'; sidebar.style.display = 'flex'; sidebar.classList.remove('disabled');
        if (inputArea) inputArea.style.display = shellEnabled ? 'none' : 'flex';
    } else {
        terminalWrapper.style.display = 'none'; logContainer.style.display = 'flex'; sidebar.style.display = 'none';
        if (inputArea) inputArea.style.display = 'none';
        const logView = document.getElementById(tabId); if (logView) logView.style.display = 'flex';
    }
}

function createLogTab(fileName) {
    const tabBar = document.getElementById('tab-bar');
    const logContainer = document.getElementById('log-views-container');
    const tabId = `log_${Date.now()}`;
    const newTab = document.createElement('div'); newTab.className = 'tab'; newTab.dataset.tab = tabId;
    newTab.innerHTML = `${fileName} <span class="tab-close">×</span>`;
    tabBar.appendChild(newTab);
    const currentFont = document.getElementById('font-input').value;
    const currentFontSize = document.getElementById('fontsize-input').value;
    const fullFont = getFullFontStack(currentFont);
    const logWrapper = document.createElement('div'); logWrapper.id = tabId; logWrapper.className = 'terminal-wrapper'; logWrapper.style.display = 'none';
    logWrapper.innerHTML = `
        <div class="output-container" style="flex: 1; padding: 0;"> <div id="${tabId}_output" class="log-output" style="font-family: ${fullFont}; font-size: var(--log-font-size);"></div> </div>
        <div id="${tabId}_filter_panel" class="filter-panel collapsed"> <div class="filter-resize-handle"></div> <button class="toggle-panel-btn">▼ Filter</button> <div class="panel-content"> <div class="filter-controls"> <input type="text" id="${tabId}_filter_input" placeholder="Search Log..."> <button id="${tabId}_filter_toggle" class="tool-btn" style="width: 50px;">OFF</button> <button id="${tabId}_filter_clear" class="tool-btn" style="width: 50px;">Clear</button> </div> <div id="${tabId}_filter_output" class="filter-output" style="font-family: ${fullFont}; font-size: var(--log-font-size);"></div> </div> </div>
    `;
    logContainer.appendChild(logWrapper);
    logTabs[tabId] = { messages: [], trimOffset: 0, name: fileName };
    setupSpecificLogFilter(tabId);
    switchTab(tabId);
    return tabId;
}

function closeLogTab(tabId) {
    const tabBtn = document.querySelector(`.tab[data-tab="${tabId}"]`); if (tabBtn) tabBtn.remove();
    const view = document.getElementById(tabId); if (view) view.remove();
    delete logTabs[tabId]; if (currentTab === tabId) switchTab('main');
}

// ================= FILTER PANEL IMPLEMENTATION =================
function setupFilterPanel() {
    const panel = document.getElementById('filter-panel');
    const mainToggleBtn = document.getElementById('filter-main-toggle');
    const handle = panel.querySelector('.filter-resize-handle');
    const applyBtn = document.getElementById('filter-apply-btn');
    let lastHeight = '200px';

    mainToggleBtn.addEventListener('click', () => {
        const isCollapsed = panel.classList.toggle('collapsed');
        if (isCollapsed) { panel.style.height = ''; mainToggleBtn.textContent = '▼ Filter'; }
        else { panel.style.height = lastHeight; mainToggleBtn.textContent = '▲ Filter'; }
        if(term && fitAddon) fitAddon.fit();
    });

    let isResizing = false;
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); isResizing = true; document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none';
        panel.style.transition = 'none'; panel.classList.remove('collapsed');
        if (!panel.style.height) panel.style.height = '200px';
        mainToggleBtn.textContent = '▲ Filter';
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const parentRect = panel.parentElement.getBoundingClientRect();
        const minMainHeight = 50; // Reserve space for main log
        // Calculate max height allowed
        const maxAllowed = parentRect.height - minMainHeight;
        
        let h = parentRect.bottom - e.clientY;
        // Clamp: Min 100px for filter, Max (ParentHeight - ReservedMainHeight)
        h = Math.max(100, Math.min(h, maxAllowed > 100 ? maxAllowed : parentRect.height - 10));
        
        panel.style.height = `${h}px`;
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; panel.style.transition = '';
            lastHeight = panel.style.height;
            if(term && fitAddon) fitAddon.fit();
        }
    });

    filterInput.addEventListener('input', (e) => {
        const pattern = e.target.value.trim();
        try { filterRegex = new RegExp(pattern, 'gi'); filterInput.style.borderColor = pattern ? 'var(--accent-color)' : 'var(--border-color)'; } catch (e) { filterRegex = null; filterInput.style.borderColor = 'var(--danger-color)'; }
        runFullFilter();
    });

    applyBtn.addEventListener('click', (e) => {
        e.stopPropagation(); isFilterEnabled = !isFilterEnabled;
        applyBtn.textContent = isFilterEnabled ? 'ON' : 'OFF';
        applyBtn.style.backgroundColor = isFilterEnabled ? 'var(--success-color)' : '';
        runFullFilter();
    });

    document.getElementById('filter-clear-btn').addEventListener('click', () => { filterOutput.innerHTML = ''; });
    filterOutput.addEventListener('click', (e) => {
        const row = e.target.closest('.filter-row'); if (row) { const lineIndex = parseInt(row.dataset.lineIndex); if (!isNaN(lineIndex)) jumpToLine(lineIndex, 'main'); }
    });
}

function setupSpecificLogFilter(tabId) {
    const panel = document.getElementById(`${tabId}_filter_panel`);
    const input = document.getElementById(`${tabId}_filter_input`);
    const toggleBtn = document.getElementById(`${tabId}_filter_toggle`);
    const clearBtn = document.getElementById(`${tabId}_filter_clear`);
    const outputEl = document.getElementById(`${tabId}_filter_output`);
    const mainToggleBtn = panel.querySelector('.toggle-panel-btn');
    const handle = panel.querySelector('.filter-resize-handle');
    let isEnabled = false; let regex = null;

    mainToggleBtn.addEventListener('click', () => {
        const isCollapsed = panel.classList.toggle('collapsed');
        if (isCollapsed) panel.style.height = '';
        mainToggleBtn.textContent = `${isCollapsed ? '▼' : '▲'} Filter`;
    });

    let isResizing = false;
    handle.addEventListener('mousedown', (e) => { e.preventDefault(); isResizing = true; document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none'; panel.style.transition = 'none'; panel.classList.remove('collapsed'); mainToggleBtn.textContent = '▲ Filter'; });
    document.addEventListener('mousemove', (e) => { if (!isResizing) return; const rect = panel.parentElement.getBoundingClientRect(); let h = rect.bottom - e.clientY; h = Math.max(100, Math.min(h, 600)); panel.style.height = `${h}px`; });
    document.addEventListener('mouseup', () => { if (isResizing) { isResizing = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; panel.style.transition = ''; } });

    input.addEventListener('input', (e) => {
        const pattern = e.target.value.trim();
        try { regex = new RegExp(pattern, 'gi'); input.style.borderColor = pattern ? 'var(--accent-color)' : 'var(--border-color)'; } catch (e) { regex = null; input.style.borderColor = 'var(--danger-color)'; }
        if (isEnabled) runFullLogFilter(regex, outputEl, tabId);
    });
    toggleBtn.addEventListener('click', (e) => { isEnabled = !isEnabled; toggleBtn.textContent = isEnabled ? 'ON' : 'OFF'; toggleBtn.style.backgroundColor = isEnabled ? 'var(--success-color)' : ''; if (isEnabled) runFullLogFilter(regex, outputEl, tabId); });
    clearBtn.addEventListener('click', () => { outputEl.innerHTML = ''; });
    outputEl.addEventListener('click', (e) => { const row = e.target.closest('.filter-row'); if (row) { const lineIndex = parseInt(row.dataset.lineIndex); if (!isNaN(lineIndex)) jumpToLine(lineIndex, tabId); } });
}

function runFullLogFilter(regex, outputEl, tabId) { outputEl.innerHTML = ''; if (!regex) return; const tabData = logTabs[tabId]; if (!tabData) return; updateGlobalLineNumWidth(tabData.messages.length + tabData.trimOffset); tabData.messages.forEach((msg, index) => { if (regex.test(msg)) { appendToSpecificFilterOutput(msg, index + tabData.trimOffset, outputEl, tabId); regex.lastIndex = 0; } }); }
function getDigitWidth(digits) { return String(digits).length * 8 + 16; }
function updateGlobalLineNumWidth(maxCount) { const width = getDigitWidth(maxCount); document.documentElement.style.setProperty('--line-num-width', `${width}px`); document.querySelectorAll('.filter-line-num').forEach(el => { el.style.width = `${width}px`; }); document.querySelectorAll('.log-row-num').forEach(el => { el.style.width = `${width}px`; }); }
function stripAnsi(str) { return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); }
function scheduleFilterUpdate() { if (!isFilterEnabled) return; if (filterUpdateTimer) clearTimeout(filterUpdateTimer); filterUpdateTimer = setTimeout(() => { runFullFilter(); filterUpdateTimer = null; }, 100); }
function appendToSpecificFilterOutput(text, lineIndex, outputEl, sourceType) { const div = document.createElement('div'); div.className = 'filter-row'; div.dataset.lineIndex = lineIndex; const numSpan = document.createElement('span'); numSpan.className = 'filter-line-num'; numSpan.style.width = `var(--line-num-width)`; numSpan.textContent = lineIndex + 1; const textSpan = document.createElement('span'); textSpan.className = 'filter-text'; textSpan.innerHTML = processLogLine(text); div.appendChild(numSpan); div.appendChild(textSpan); outputEl.appendChild(div); if (outputEl.scrollHeight - outputEl.scrollTop <= outputEl.clientHeight + 50) { outputEl.scrollTop = outputEl.scrollHeight; } }
function jumpToLine(index, type) { if (type.startsWith('log_')) { let output, trimOffset; output = document.getElementById(`${type}_output`); trimOffset = logTabs[type].trimOffset; const realIndex = index - trimOffset; if (realIndex >= 0 && realIndex < output.children.length) { const target = output.children[realIndex]; target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('flash-highlight'); setTimeout(() => target.classList.remove('flash-highlight'), 1000); } } else if (shellEnabled && term) { const currentY = term.buffer.active.viewportY; term.scrollLines(index - currentY); if (timeGutter) timeGutter.flashLine(index); } else { let output = document.getElementById('output'); let trimOffset = outputTrimOffset; const realIndex = index - trimOffset; if (realIndex >= 0 && realIndex < output.children.length) { const target = output.children[realIndex]; target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('flash-highlight'); setTimeout(() => target.classList.remove('flash-highlight'), 1000); } } }
function runFullFilter() { filterOutput.innerHTML = ''; if (!filterRegex) return; if (!isFilterEnabled) return; if (shellEnabled && term) { const buffer = term.buffer.active; updateGlobalLineNumWidth(buffer.length); for (let i = 0; i < buffer.length; i++) { const line = buffer.getLine(i); if (line) { const text = line.translateToString(true); const cleanText = stripAnsi(text); if (filterRegex.test(cleanText)) { appendToSpecificFilterOutput(cleanText, i, filterOutput, 'main'); filterRegex.lastIndex = 0; } } } } else { updateGlobalLineNumWidth(outputMessages.length + outputTrimOffset); outputMessages.forEach((msg, index) => { if (filterRegex.test(msg)) { appendToSpecificFilterOutput(msg, index + outputTrimOffset, filterOutput, 'main'); filterRegex.lastIndex = 0; } }); } }

// ================= TIME GUTTER =================
class TimeGutter {
    constructor(element) { this.el = element; this.markers = []; this.lineTimestamps = []; this.cellHeight = 0; this.term = null; this.viewport = null; this.renderPending = false; }
    bindTerminal(term) { this.term = term; this.viewport = term.element.querySelector('.xterm-viewport'); if (!this.viewport) return; this.tryGetCellHeight(); this.syncFont(); term.onLineFeed(() => { const buffer = this.term.buffer.active; const completedIndex = buffer.baseY + buffer.cursorY - 1; if (completedIndex < 0) return; let logicalStart = completedIndex; while (logicalStart > 0) { const line = buffer.getLine(logicalStart); if (line && line.isWrapped) { logicalStart--; } else { break; } } const startLine = buffer.getLine(logicalStart); if (startLine && !startLine.isWrapped) { const lineText = startLine.translateToString(true).trim(); if (lineText.length > 0) { const now = new Date(); const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}.${now.getMilliseconds().toString().padStart(3,'0')}`; const offset = logicalStart - (buffer.baseY + buffer.cursorY); let marker = null; try { if (typeof this.term.registerMarker === 'function') { marker = this.term.registerMarker(offset); } else if (typeof this.term.addMarker === 'function') { marker = this.term.addMarker(offset); } } catch(e) {} if (marker) { this.markers.push({ marker, ts }); marker.onDispose(() => { this.markers = this.markers.filter(m => m.marker !== marker); this.scheduleRender(); }); } else { while (this.lineTimestamps.length <= logicalStart) { this.lineTimestamps.push(''); } this.lineTimestamps[logicalStart] = ts; } } } this.scheduleRender(); }); this.viewport.addEventListener('scroll', () => this.scheduleRender()); term.onResize(() => { this.tryGetCellHeight(); this.syncFont(); this.scheduleRender(); }); }
    syncFont() { const userFont = document.getElementById('font-input').value; this.el.style.fontFamily = getFullFontStack(userFont); }
    tryGetCellHeight() { if (!this.term || !this.term.element) return; try { this.cellHeight = this.term._core._renderService.dimensions.actualCellHeight; } catch(e) {} if (!this.cellHeight || this.cellHeight <= 0) { const row = this.term.element.querySelector('.xterm-rows > div'); if (row) this.cellHeight = row.getBoundingClientRect().height; } if (!this.cellHeight || this.cellHeight <= 0) { setTimeout(() => this.tryGetCellHeight(), 100); } }
    reset() { this.markers.forEach(m => { try { m.marker.dispose(); } catch(e) {} }); this.markers = []; this.lineTimestamps = []; this.el.innerHTML = ''; }
    flashLine(lineIndex) { const lines = this.el.querySelectorAll('.gutter-line'); lines.forEach(line => { const numEl = line.querySelector('.line-num-col'); if (numEl && parseInt(numEl.textContent) === lineIndex + 1) { line.classList.add('flash-highlight'); setTimeout(() => line.classList.remove('flash-highlight'), 1000); } }); }
    scheduleRender() { if (!this.renderPending) { this.renderPending = true; requestAnimationFrame(() => { this.render(); this.renderPending = false; }); } }
    render() { if (!this.term || !this.cellHeight || !this.viewport) return; const buffer = this.term.buffer.active; const scrollTop = this.viewport.scrollTop; const startRow = Math.round(scrollTop / this.cellHeight); const viewportHeight = this.viewport.clientHeight; const rowCount = Math.ceil(viewportHeight / this.cellHeight) + 2; const endRow = startRow + rowCount; const maxLine = buffer.length; const numWidth = getDigitWidth(maxLine); const timeWidth = timestampEnabled ? 90 : 0; this.el.style.width = `${numWidth + timeWidth}px`; updateGlobalLineNumWidth(maxLine); if (timestampEnabled) this.el.classList.add('has-timestamps'); else this.el.classList.remove('has-timestamps'); const markerMap = {}; this.markers.forEach(m => { if (!m.marker.isDisposed) markerMap[m.marker.line] = m.ts; }); let html = ''; for (let i = startRow; i < endRow; i++) { if (i < 0) continue; const top = (i * this.cellHeight) - scrollTop; const lineNum = i + 1; let ts = markerMap[i] || this.lineTimestamps[i] || ''; html += `<div class="gutter-line" style="top: ${top}px; height: ${this.cellHeight}px;"><span class="line-num-col" style="width: ${numWidth}px">${lineNum}</span>${timestampEnabled ? `<span class="time-col">${ts}</span>` : ''}</div>`; } this.el.innerHTML = html; }
}

// ================= CORE LOGIC =================
function getFullFontStack(userFont) { if (!userFont || userFont.trim() === '') { return DEFAULT_FONT_STACK; } return `${userFont}, ${DEFAULT_FONT_STACK}`; }
function syncShellUI(enabled) { if (enabled) { outputContainer.style.display = 'none'; shellArea.style.display = 'flex'; inputArea.style.display = 'none'; updateGutterVisibility(); } else { outputContainer.style.display = 'flex'; shellArea.style.display = 'none'; inputArea.style.display = 'flex'; } }
function updateGutterVisibility() { if (!timeGutterEl) return; timeGutterEl.style.display = 'block'; if(timeGutter) timeGutter.render(); if(term && fitAddon) fitAddon.fit(); }
function initWebSocket() { const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'; ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`); ws.onopen = () => console.log('WebSocket connected'); ws.onmessage = (event) => { try { const data = JSON.parse(event.data); switch(data.type) { case 'message': if (shellEnabled) { if (term) { let msg = data.message.replace(/\r?\n/g, '\r\n'); term.write(applyShellHighlight(msg)); scheduleFilterUpdate(); } else addToOutput(data.message); } else { addToOutput(data.message); } break; case 'script_log': appendToScriptConsole(data.message); break; case 'config': if (data.config) updateConfig(data.config); if (data.connected !== undefined) updateConnectionStatus(data.connected); if (data.mode) updateMode(data.mode); break; case 'status': console.log('Status:', data.message); break; case 'mode': updateMode(data.mode); break; case 'clear': clearOutput(false); break; } } catch (error) { console.error('Parse error:', error); } }; ws.onclose = () => setTimeout(initWebSocket, 1000); ws.onerror = (error) => console.error('WS error:', error); }
function setupSidebarFocusManagement() { document.querySelectorAll('#sidebar input, #sidebar select, #sidebar textarea').forEach(el => { el.addEventListener('mousedown', function(e) { if (term) term.blur(); }); el.addEventListener('focus', function() { if (term) term.blur(); }); }); }
function setupEventListeners() { document.getElementById('tab-bar').addEventListener('click', (e) => { const tab = e.target.closest('.tab'); if (tab) { if (e.target.classList.contains('tab-close')) { closeLogTab(tab.dataset.tab); } else { switchTab(tab.dataset.tab); } } }); document.getElementById('connect-btn').addEventListener('click', toggleConnection); document.getElementById('scan-btn').addEventListener('click', scanPorts); document.getElementById('clear-btn').addEventListener('click', () => clearOutput(true)); document.getElementById('export-btn').addEventListener('click', exportLog); document.getElementById('send-btn').addEventListener('click', sendData); document.getElementById('save-config-btn').addEventListener('click', saveConfig); document.getElementById('input').addEventListener('keydown', handleInputKeydown); document.getElementById('toggle-sidebar-btn').addEventListener('click', () => { document.getElementById('sidebar').classList.toggle('collapsed'); setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 250); }); document.getElementById('send-toggle-btn').addEventListener('click', function() { const area = document.getElementById('input-area'); area.classList.toggle('collapsed'); this.textContent = area.classList.contains('collapsed') ? '▼ Send' : '▲ Send'; }); document.getElementById('toggle-script-btn').addEventListener('click', () => { const panel = document.getElementById('script-panel'); panel.classList.toggle('collapsed'); setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 250); }); document.getElementById('refresh-scripts-btn').addEventListener('click', listScripts); document.getElementById('run-script-btn').addEventListener('click', runScript); document.getElementById('stop-script-btn').addEventListener('click', stopScript); document.getElementById('ascii-mode').addEventListener('change', function() { if (this.checked) setMode(this.value); }); document.getElementById('hex-mode').addEventListener('change', function() { if (this.checked) setMode(this.value); }); document.getElementById('timestamp-on').addEventListener('change', function() { if (this.checked) setTimestamp(true); }); document.getElementById('timestamp-off').addEventListener('change', function() { if (this.checked) setTimestamp(false); }); document.getElementById('shell-on').addEventListener('change', function() { if (this.checked) setShellEnabled(true); }); document.getElementById('shell-off').addEventListener('change', function() { if (this.checked) setShellEnabled(false); }); document.getElementById('theme-preset-select').addEventListener('change', handleThemePresetChange); document.getElementById('theme-bg').addEventListener('input', handleCustomThemeChange); document.getElementById('theme-fg').addEventListener('input', handleCustomThemeChange); document.getElementById('theme-cursor').addEventListener('input', handleCustomThemeChange); document.querySelector('.close').addEventListener('click', closeModal); window.addEventListener('click', (event) => { if (event.target == document.getElementById('modal')) closeModal(); }); document.getElementById('import-log-btn').addEventListener('click', () => { document.getElementById('import-log-input').click(); }); document.getElementById('import-log-input').addEventListener('change', function(e) { if (this.files.length > 0) { handleImportLog(this.files[0]); this.value = ''; } }); }
function handleImportLog(file) { if (!file) return; const tabId = createLogTab(file.name); const tabData = logTabs[tabId]; const reader = new FileReader(); reader.onload = (e) => { const text = e.target.result; const lines = text.split('\n'); const tsRegex = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s(.*)$/; const numWidth = getDigitWidth(lines.length); updateGlobalLineNumWidth(lines.length); let i = 0; const outputEl = document.getElementById(`${tabId}_output`); function processChunk() { const chunk = lines.slice(i, i + 500); chunk.forEach(line => { const match = line.match(tsRegex); let content = line.replace(/\r$/, ''); if (match) content = match[2]; tabData.messages.push(content); const rowDiv = document.createElement('div'); rowDiv.className = 'log-row'; const numSpan = document.createElement('div'); numSpan.className = 'log-row-num'; numSpan.textContent = tabData.messages.length; numSpan.style.width = `var(--line-num-width)`; const textSpan = document.createElement('div'); textSpan.className = 'log-row-text'; textSpan.innerHTML = processLogLine(content); rowDiv.appendChild(numSpan); rowDiv.appendChild(textSpan); outputEl.appendChild(rowDiv); }); outputEl.scrollTop = outputEl.scrollHeight; i += 500; if (i < lines.length) setTimeout(processChunk, 5); } processChunk(); }; reader.readAsText(file); }
function addToOutput(text) { outputMessages.push(text); pendingMessages.push(text); scheduleOutputUpdate(); if (isFilterEnabled && filterRegex && filterRegex.test(text)) { appendToSpecificFilterOutput(text, outputMessages.length - 1 + outputTrimOffset, filterOutput, 'main'); } }
function scheduleOutputUpdate() { if (!updateTimer) updateTimer = setTimeout(flushOutput, 16); }
function flushOutput() { updateTimer = null; if (pendingMessages.length === 0) return; const output = document.getElementById('output'); const fragment = document.createDocumentFragment(); const batch = pendingMessages.splice(0, FLUSH_BATCH_SIZE); updateGlobalLineNumWidth(outputMessages.length + outputTrimOffset); batch.forEach(msg => { const rowDiv = document.createElement('div'); rowDiv.className = 'log-row'; const numSpan = document.createElement('div'); numSpan.className = 'log-row-num'; numSpan.style.width = `var(--line-num-width)`; numSpan.textContent = (outputMessages.length + outputTrimOffset); const textSpan = document.createElement('div'); textSpan.className = 'log-row-text'; textSpan.innerHTML = processLogLine(msg); rowDiv.appendChild(numSpan); rowDiv.appendChild(textSpan); fragment.appendChild(rowDiv); }); output.appendChild(fragment); while (output.children.length > MAX_OUTPUT_LINES) { output.removeChild(output.firstChild); outputMessages.shift(); outputTrimOffset++; } output.scrollTop = output.scrollHeight; if (pendingMessages.length > 0) scheduleOutputUpdate(); }

// ================= UTILITY & CONFIG =================
function applyFontSettings(font, size) { const output = document.getElementById('output'); const fullFont = getFullFontStack(font); output.style.fontFamily = fullFont; output.style.fontSize = size + 'px'; document.documentElement.style.setProperty('--log-font-size', `${size}px`); document.documentElement.style.setProperty('--gutter-font-size', `${Math.max(10, size - 1)}px`); const highlightInput = document.getElementById('highlight-input'); if(highlightInput) { highlightInput.style.fontFamily = fullFont; highlightInput.style.fontSize = `${size}px`; } const mainFilterOutput = document.getElementById('filter-output'); if(mainFilterOutput) { mainFilterOutput.style.fontFamily = fullFont; mainFilterOutput.style.fontSize = size + 'px'; } Object.keys(logTabs).forEach(tabId => { const logOutput = document.getElementById(`${tabId}_output`); const logFilterOutput = document.getElementById(`${tabId}_filter_output`); if(logOutput) { logOutput.style.fontFamily = fullFont; logOutput.style.fontSize = `var(--log-font-size)`; } if(logFilterOutput) { logFilterOutput.style.fontFamily = fullFont; logFilterOutput.style.fontSize = size + 'px'; } }); if (term) { term.setOption('fontFamily', fullFont); term.setOption('fontSize', parseInt(size)); setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 50); } if (timeGutter) timeGutter.syncFont(); }
function updatePortInfo(port, baud) { document.getElementById('port-info').textContent = `${port} | ${baud}`; }
function loadConfig() { fetch('/getconfig', { method: 'POST' }).then(r => r.json()).then(data => { updateConfig(data.config, true); updateConnectionStatus(data.connected); updateMode(data.mode); const configShell = (data.config && data.config.UI) ? data.config.UI.Shell : true; setShellEnabled(configShell, false); requestAnimationFrame(() => { requestAnimationFrame(() => { fetch('/ready', { method: 'POST' }); }); }); }).catch(err => { console.error('Config load failed:', err); shellEnabled = false; syncShellUI(false); fetch('/ready', { method: 'POST' }); }); }
function updateConfig(config, isInitial = false) { if (!config) return; if (config.Serial) { document.getElementById('port-input').value = config.Serial.Port || 'COM1'; document.getElementById('baud-input').value = config.Serial.Baud || 9600; document.getElementById('databits-select').value = config.Serial.Databits || 8; document.getElementById('stopbits-select').value = config.Serial.Stopbits || 1; document.getElementById('parity-select').value = config.Serial.Parity || 'N'; updatePortInfo(config.Serial.Port, config.Serial.Baud); } if (config.UI) { document.getElementById('font-input').value = config.UI.Font || 'Consolas, monospace'; document.getElementById('fontsize-input').value = config.UI.FontSize || 14; document.getElementById('scrollback-input').value = config.UI.Scrollback || 100000; applyFontSettings(config.UI.Font, config.UI.FontSize); updateTimestampStatus(config.UI.Timestamp !== undefined ? config.UI.Timestamp : true); if (!isInitial && !userActionLock) updateShellStatus(config.UI.Shell !== undefined ? config.UI.Shell : true); } if (config.Highlight && config.Highlight.Groups) { const groups = Array.isArray(config.Highlight.Groups) ? config.Highlight.Groups : ["error:#ff0000", "warn:#ffa500"]; document.getElementById('highlight-input').value = groups.join('\n'); updateHighlightRules(groups); renderHighlightPreviewStrip(); } if (config.Theme) { const name = config.Theme.Name || "Default"; document.getElementById('theme-preset-select').value = name; if (name === "Custom") { document.getElementById('custom-theme-area').style.display = 'flex'; document.getElementById('theme-bg').value = config.Theme.Background || '#1e1e1e'; document.getElementById('theme-fg').value = config.Theme.Foreground || '#cccccc'; document.getElementById('theme-cursor').value = config.Theme.Cursor || '#ffffff'; applyTheme(config.Theme); } else { document.getElementById('custom-theme-area').style.display = 'none'; applyTheme(themePresets[name]); } } }
function addConfigChangeListeners() { ['port-input', 'baud-input', 'databits-select', 'stopbits-select', 'parity-select', 'font-input', 'fontsize-input', 'highlight-input', 'scrollback-input'].forEach(id => { document.getElementById(id).addEventListener('change', saveConfigSilently); }); document.getElementById('port-input').addEventListener('input', function() { updatePortInfo(this.value, document.getElementById('baud-input').value); }); document.getElementById('port-input').addEventListener('change', function() { updatePortInfo(this.value, document.getElementById('baud-input').value); }); document.getElementById('baud-input').addEventListener('change', function() { updatePortInfo(document.getElementById('port-input').value, this.value); }); document.getElementById('font-input').addEventListener('change', function() { applyFontSettings(this.value, document.getElementById('fontsize-input').value); }); document.getElementById('fontsize-input').addEventListener('change', function() { applyFontSettings(document.getElementById('font-input').value, this.value); }); document.getElementById('scrollback-input').addEventListener('change', function() { if (shellEnabled && term) { setShellEnabled(false, false); setTimeout(() => setShellEnabled(true, false), 100); } }); document.getElementById('highlight-input').addEventListener('change', function() { updateHighlightRules(this.value.split('\n').map(l => l.trim()).filter(l => l)); if(isFilterEnabled) runFullFilter(); }); }
function saveConfig() { fetch('/saveconfig', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(getFormData()) }).then(r => r.json()).then(data => { if (data.status === 'ok') alert('Configuration saved'); else alert('Save failed: ' + data.message); }); }
function saveConfigSilently() { fetch('/saveconfig', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(getFormData()) }); }
function getFormData() { const themeName = document.getElementById('theme-preset-select').value; let themeData = { Name: themeName }; if (themeName === "Custom") { themeData.Background = document.getElementById('theme-bg').value; themeData.Foreground = document.getElementById('theme-fg').value; themeData.Cursor = document.getElementById('theme-cursor').value; Object.assign(themeData, themePresets["Default"]); } else { const preset = themePresets[themeName]; if(preset) Object.assign(themeData, preset); } return { Serial: { Port: document.getElementById('port-input').value, Baud: parseInt(document.getElementById('baud-input').value), Databits: parseInt(document.getElementById('databits-select').value), Stopbits: parseInt(document.getElementById('stopbits-select').value), Parity: document.getElementById('parity-select').value }, UI: { Font: document.getElementById('font-input').value, FontSize: parseInt(document.getElementById('fontsize-input').value), Timestamp: timestampEnabled, Shell: shellEnabled, Scrollback: parseInt(document.getElementById('scrollback-input').value) || 100000 }, Highlight: { Groups: document.getElementById('highlight-input').value.split('\n').map(l=>l.trim()).filter(l=>l) }, Log: { Path: './logs' }, Theme: themeData }; }

// ================= REST OF HELPER FUNCTIONS =================
function setupSmartCopy() { const output = document.getElementById('output'); output.addEventListener('keydown', function(e) { if (e.key === 'Enter') { const selection = window.getSelection().toString(); if (selection) { e.preventDefault(); navigator.clipboard.writeText(selection).catch(err => {}); } } }); }
function setupKeyboardShortcuts() { document.addEventListener('keydown', function(event) { if (event.target.tagName === 'INPUT' && event.target.id !== 'input') return; if (event.key === 'F2') { event.preventDefault(); toggleConnection(); } else if (event.key === 'F3') { event.preventDefault(); scanPorts(); } else if (event.key === 'Escape') { event.preventDefault(); closeModal(); } }); }
function adjustColor(hex, amount) { hex = hex.replace('#', ''); let r = parseInt(hex.substring(0, 2), 16); let g = parseInt(hex.substring(2, 4), 16); let b = parseInt(hex.substring(4, 6), 16); r = Math.min(255, Math.max(0, r + amount)); g = Math.min(255, Math.max(0, g + amount)); b = Math.min(255, Math.max(0, b + amount)); return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`; }
function applyTheme(themeData) { if (!themeData) return; const root = document.documentElement; const bgLuminance = parseInt(themeData.Background.substring(1, 3), 16) + parseInt(themeData.Background.substring(3, 5), 16) + parseInt(themeData.Background.substring(5, 7), 16); const isDark = bgLuminance < 384; const step = isDark ? 15 : -15; root.style.setProperty('--bg-primary', themeData.Background); root.style.setProperty('--bg-secondary', adjustColor(themeData.Background, step)); root.style.setProperty('--bg-tertiary', adjustColor(themeData.Background, step * 2)); root.style.setProperty('--border-color', adjustColor(themeData.Background, step * 3)); root.style.setProperty('--text-primary', themeData.Foreground); root.style.setProperty('--text-secondary', adjustColor(themeData.Foreground, isDark ? -80 : 80)); root.style.setProperty('--accent-color', themeData.Blue); root.style.setProperty('--accent-hover', adjustColor(themeData.Blue, isDark ? 30 : -30)); root.style.setProperty('--danger-color', themeData.Red); root.style.setProperty('--success-color', themeData.Green); root.style.setProperty('--warning-color', themeData.Yellow); if (term) { term.setOption('theme', { background: themeData.Background, foreground: themeData.Foreground, cursor: themeData.Cursor, selectionBackground: themeData.Cursor + '40', black: themeData.Black, red: themeData.Red, green: themeData.Green, yellow: themeData.Yellow, blue: themeData.Blue, magenta: themeData.Magenta, cyan: themeData.Cyan, white: themeData.White, brightBlack: themeData.BrightBlack, brightRed: themeData.BrightRed, brightGreen: themeData.BrightGreen, brightYellow: themeData.BrightYellow, brightBlue: themeData.BrightBlue, brightMagenta: themeData.BrightMagenta, brightCyan: themeData.BrightCyan, brightWhite: themeData.BrightWhite }); } }
function handleThemePresetChange() { const sel = document.getElementById('theme-preset-select'); const customArea = document.getElementById('custom-theme-area'); const name = sel.value; if (name === "Custom") { customArea.style.display = 'flex'; handleCustomThemeChange(); } else { customArea.style.display = 'none'; applyTheme(themePresets[name]); saveConfigSilently(); } }
function handleCustomThemeChange() { applyTheme({ Name: "Custom", Background: document.getElementById('theme-bg').value, Foreground: document.getElementById('theme-fg').value, Cursor: document.getElementById('theme-cursor').value, ...themePresets["Default"] }); saveConfigSilently(); }
function listScripts() { fetch('/listscripts', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'ok') { const select = document.getElementById('script-select'); select.innerHTML = '<option value="">-- Select Script --</option>'; data.scripts.forEach(s => { const opt = document.createElement('option'); opt.value = s; opt.textContent = s; select.appendChild(opt); }); } }); }
function runScript() { const filename = document.getElementById('script-select').value; if (!filename) return alert("Please select a script first."); isScriptRunning = true; document.getElementById('script-status-text').textContent = 'Running...'; document.getElementById('script-status-text').style.color = 'var(--success-color)'; document.getElementById('script-console').innerHTML = ''; const formData = new FormData(); formData.append('filename', filename); fetch('/runscript', { method: 'POST', body: formData }).then(r => r.json()).then(data => { if (data.status !== 'ok') { appendToScriptConsole("❌ Failed to start: " + data.message); isScriptRunning = false; document.getElementById('script-status-text').textContent = 'Error'; document.getElementById('script-status-text').style.color = 'var(--danger-color)'; } else { appendToScriptConsole(`🚀 Executing: ${filename}`); } }); }
function stopScript() { fetch('/stopscript', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'ok') { isScriptRunning = false; document.getElementById('script-status-text').textContent = 'Stopped'; document.getElementById('script-status-text').style.color = 'var(--warning-color)'; } }); }
function appendToScriptConsole(msg) { const con = document.getElementById('script-console'); const div = document.createElement('div'); div.textContent = msg; con.appendChild(div); con.scrollTop = con.scrollHeight; if (msg.includes("finished") || msg.includes("stopped") || msg.includes("Error")) { isScriptRunning = false; document.getElementById('script-status-text').textContent = 'Idle'; document.getElementById('script-status-text').style.color = 'var(--text-secondary)'; } }
function toggleConnection() { isConnected ? disconnect() : connect(); }
function connect() { fetch('/connect', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'connected') { isConnected = true; updateConnectionStatus(true); } else { alert('Connection failed: ' + data.message); } }); }
function disconnect() { fetch('/disconnect', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'disconnected') { isConnected = false; updateConnectionStatus(false); } }); }
function scanPorts() { const modalBody = document.getElementById('modal-body'); modalBody.innerHTML = `<h3>Scanning...</h3>`; document.getElementById('modal').style.display = 'block'; fetch('/scan', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'ok') showPortSelection(data.ports); else showPortSelectionError(data.message); }).catch(error => showPortSelectionError(error.message)); }
function setMode(mode) { if (shellEnabled) return; const formData = new FormData(); formData.append('mode', mode); fetch('/setmode', { method: 'POST', body: formData }).then(r => r.json()).then(data => { if (data.status === 'ok') { currentMode = mode; updateMode(mode); } }); }
function setTimestamp(enabled) { timestampEnabled = enabled; updateTimestampStatus(enabled); saveConfigSilently(); }
function setShellEnabled(enabled, shouldSave = true) { if (shellEnabled === enabled && !(enabled && !term)) return; userActionLock = true; shellEnabled = enabled; updateShellStatus(enabled); syncShellUI(enabled); if (enabled) { if (!xtermLoaded) { syncShellUI(false); addToOutput('[System] Shell mode requires xterm.js.'); shellEnabled = false; updateShellStatus(false); userActionLock = false; return; } if (!term) { try { initTerminal(); } catch (e) { syncShellUI(false); shellEnabled = false; updateShellStatus(false); addToOutput('[System] Failed to initialize terminal: ' + e.message); userActionLock = false; return; } } else { setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 50); } if (outputMessages.length > 0) { const plainText = outputMessages.map(msg => { const div = document.createElement('div'); div.innerHTML = msg; return div.textContent || div.innerText || ''; }).join('\r\n'); if (plainText.trim()) { term.write('\r\n\x1b[33m--- Previous output transferred ---\x1b[0m\r\n'); term.write(plainText); term.write('\r\n\x1b[33m--- End of transferred output ---\x1b[0m\r\n'); } outputMessages = []; pendingMessages = []; document.getElementById('output').innerHTML = ''; outputTrimOffset = 0; } } else { if (term) { const buffer = term.buffer.active; let shellOutput = ''; for (let i = 0; i < buffer.length; i++) { const line = buffer.getLine(i); if (line) shellOutput += line.translateToString(true) + "\n"; } shellOutput = shellOutput.trimEnd().replace(/\x1b\[[0-9;]*m/g, ''); if (shellOutput) { addToOutput('<span style="color: #cca700;">--- Shell output transferred ---</span>'); shellOutput.split('\n').forEach(line => { if (line) addToOutput(line); }); addToOutput('<span style="color: #cca700;">--- End of transferred output ---</span>'); } term.dispose(); term = null; fitAddon = null; if (timeGutter) { timeGutter.reset(); timeGutter = null; } } } if (shouldSave) saveConfigSilently(); setTimeout(() => { userActionLock = false; }, 3000); }
function initTerminal() { const currentThemeName = document.getElementById('theme-preset-select').value; const currentTheme = currentThemeName === "Custom" ? { Background: document.getElementById('theme-bg').value, Foreground: document.getElementById('theme-fg').value, Cursor: document.getElementById('theme-cursor').value, ...themePresets["Default"] } : themePresets[currentThemeName]; term = new Terminal({ cursorBlink: true, theme: { background: currentTheme.Background, foreground: currentTheme.Foreground, cursor: currentTheme.Cursor, black: currentTheme.Black, red: currentTheme.Red, green: currentTheme.Green, yellow: currentTheme.Yellow, blue: currentTheme.Blue, magenta: currentTheme.Magenta, cyan: currentTheme.Cyan, white: currentTheme.White, brightBlack: currentTheme.BrightBlack, brightRed: currentTheme.BrightRed, brightGreen: currentTheme.BrightGreen, brightYellow: currentTheme.BrightYellow, brightBlue: currentTheme.BrightBlue, brightMagenta: currentTheme.BrightMagenta, brightCyan: currentTheme.BrightCyan, brightWhite: currentTheme.BrightWhite }, fontSize: parseInt(document.getElementById('fontsize-input').value) || 14, fontFamily: getFullFontStack(document.getElementById('font-input').value), scrollback: parseInt(document.getElementById('scrollback-input').value) || 100000, convertEol: false }); fitAddon = new FitAddon.FitAddon(); term.loadAddon(fitAddon); term.open(termContainer); timeGutter = new TimeGutter(timeGutterEl); timeGutter.bindTerminal(term); updateGutterVisibility(); term.onSelectionChange(() => { if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(err => {}); }); term.onData(data => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: data })); }); new ResizeObserver(() => { if (term && fitAddon && shellEnabled && termContainer.offsetWidth > 0) { try { fitAddon.fit(); } catch(e) {} } }).observe(termContainer); setTimeout(() => { if(term && fitAddon) fitAddon.fit(); if (document.activeElement === document.body || document.activeElement === null || document.activeElement.tagName === 'DIV') term.focus(); }, 200); }

// ================== PROCESSING PIPELINE ==================
function escapeHtml(text) { return text.replace(/[&<>"]/g, function(tag) { const chars = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }; return chars[tag] || tag; }); }
function ansiToHtml(text) { const ansiRegex = /\x1b\[([0-9;]*)m/g; let match; let lastIndex = 0; let html = ''; const openTags = []; const colors = [ '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff' ]; while ((match = ansiRegex.exec(text)) !== null) { html += text.substring(lastIndex, match.index); lastIndex = match.index + match[0].length; const codes = match[1].split(';').map(Number).filter(n => !isNaN(n)); if (codes.length === 0) { while(openTags.length) { html += '</span>'; openTags.pop(); } continue; } let style = ''; for(let i = 0; i < codes.length; i++) { const code = codes[i]; if (code === 0) { style = ''; while(openTags.length) { html += '</span>'; openTags.pop(); } } else if (code === 1) { style += 'font-weight:bold;'; } else if (code >= 30 && code <= 37) { style += `color:${colors[code-30]};`; } else if (code >= 90 && code <= 97) { style += `color:${colors[code-90+8]};`; } else if (code === 38) { if (codes[i+1] === 5) { const c = codes[i+2]; if (c < 16) style += `color:${colors[c]};`; i += 2; } else if (codes[i+1] === 2) { style += `color:rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]});`; i += 4; } } } if (style) { html += `<span style="${style}">`; openTags.push(true); } } html += text.substring(lastIndex); while(openTags.length) { html += '</span>'; openTags.pop(); } return html; }
function applyHighlight(html) { if (!combinedHighlightRegex) return html; return html.replace(combinedHighlightRegex, function(match, ...groups) { for (let i = 0; i < highlightColorMap.length; i++) { if (groups[i] !== undefined) return `<span style="color:${highlightColorMap[i]};font-weight:bold;">${match}</span>`; } return match; }); }
function applyShellHighlight(text) { if (!combinedHighlightRegex) return text; return text.replace(combinedHighlightRegex, function(match, ...groups) { for (let i = 0; i < highlightColorMap.length; i++) { if (groups[i] !== undefined) { return hexToAnsi(highlightColorMap[i]) + match + '\x1b[0m'; } } return match; }); }
function processLogLine(text) { let line = escapeHtml(text); line = ansiToHtml(line); line = applyHighlight(line); return line; }
function hexToAnsi(hex) { const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); if (!result) return ''; const r = parseInt(result[1], 16); const g = parseInt(result[2], 16); const b = parseInt(result[3], 16); return `\x1b[1;38;2;${r};${g};${b}m`; }
function updateHighlightRules(lines) { let rules = lines.map(line => { const parts = line.split(':'); if (parts.length < 2) return null; try { return { regexStr: parts[0], color: parts.slice(1).join(':') }; } catch (e) { return null; } }).filter(r => r !== null); try { const regexParts = rules.map(r => `(${r.regexStr})`); highlightColorMap = rules.map(r => r.color); if (regexParts.length > 0) { combinedHighlightRegex = new RegExp(regexParts.join('|'), 'gi'); } else { combinedHighlightRegex = null; } } catch (e) { combinedHighlightRegex = null; } }
function addToHistory(command) { if (!command || command.trim() === '' || shellEnabled) return; command = command.trim(); if (historyList.length > 0 && historyList[historyList.length - 1] === command) return; historyList.push(command); if (historyList.length > 100) historyList.shift(); historyIndex = historyList.length; }
function navigateHistory(direction) { if (historyList.length === 0 || shellEnabled) return; historyIndex = Math.max(0, Math.min(historyList.length - 1, historyIndex + direction)); document.getElementById('input').value = historyList[historyIndex]; }
function sendData() { if (shellEnabled) return; const input = document.getElementById('input'); let data = input.value; if (data === '') return; const suffixSelect = document.getElementById('suffix-select'); if (suffixSelect) { const suffixVal = suffixSelect.value; if (suffixVal === '\\n') { data += '\n'; } else if (suffixVal === '\\r\\n') { data += '\r\n'; } } const formData = new FormData(); formData.append('data', data); fetch('/send', { method: 'POST', body: formData }).then(r => r.json()).then(res => { if (res.status === 'ok') { addToHistory(input.value); input.value = ''; historyIndex = historyList.length; } else { alert('Send failed: ' + res.message); } }); }
function handleInputKeydown(event) { if (event.key === 'Tab') { if (!shellEnabled) { event.preventDefault(); const formData = new FormData(); formData.append('data', '\t'); fetch('/send', { method: 'POST', body: formData }); } return; } if (shellEnabled) return; if (event.key === 'Enter') { event.preventDefault(); sendData(); } else if (event.key === 'ArrowUp') { event.preventDefault(); navigateHistory(-1); } else if (event.key === 'ArrowDown') { event.preventDefault(); navigateHistory(1); } }
function exportLog() { let content = ""; if (shellEnabled && term) { const buffer = term.buffer.active; const hasTimestamps = timestampEnabled && timeGutter; const tsMap = {}; if (hasTimestamps) { if (timeGutter.markers && timeGutter.markers.length > 0) { timeGutter.markers.forEach(m => { if (!m.marker.isDisposed) { tsMap[m.marker.line] = m.ts; } }); } else if (timeGutter.lineTimestamps) { timeGutter.lineTimestamps.forEach((ts, index) => { if (ts) tsMap[index] = ts; }); } } let mergedLines = []; for (let i = 0; i < buffer.length; i++) { const line = buffer.getLine(i); if (line) { let lineText = line.translateToString(true); if (line.isWrapped && mergedLines.length > 0) { mergedLines[mergedLines.length - 1].text += lineText; } else { let ts = hasTimestamps ? (tsMap[i] || '') : ''; mergedLines.push({ text: lineText, ts: ts }); } } } mergedLines.forEach(item => { if (item.ts) { content += `[${item.ts}] ${item.text}\n`; } else { content += `${item.text}\n`; } }); content = content.trimEnd(); } else { outputMessages.forEach(msg => { content += msg + "\n"; }); } if (!content.trim()) return alert("No data to export."); const blob = new Blob([content], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `serial_log_${new Date().toISOString().replace(/[:.]/g, '-')}.log`; a.click(); URL.revokeObjectURL(url); }
function rerenderAllOutput() { const output = document.getElementById('output'); output.innerHTML = ''; outputMessages.forEach(msg => { const div = document.createElement('div'); div.innerHTML = processLogLine(msg); output.appendChild(div); }); }
function clearOutput(sendClear = true) { if (sendClear) fetch('/clear', { method: 'POST' }); if (shellEnabled && term) { term.clear(); if (timeGutter) timeGutter.reset(); } else { document.getElementById('output').innerHTML = ''; pendingMessages = []; outputMessages = []; outputTrimOffset = 0; } filterOutput.innerHTML = ''; }
function updateConnectionStatus(connected) { isConnected = connected; const status = document.getElementById('connection-status'); status.textContent = connected ? 'Connected' : 'Disconnected'; status.className = connected ? 'connected' : ''; }
function updateMode(mode) { currentMode = mode; document.getElementById('ascii-mode').checked = (mode === 'ascii'); document.getElementById('hex-mode').checked = (mode === 'hex'); }
function updateTimestampStatus(enabled) { timestampEnabled = enabled; document.getElementById('timestamp-on').checked = enabled; document.getElementById('timestamp-off').checked = !enabled; updateGutterVisibility(); }
function updateShellStatus(enabled) { shellEnabled = enabled; document.getElementById('shell-on').checked = enabled; document.getElementById('shell-off').checked = !enabled; }
function showPortSelection(ports) { const modalBody = document.getElementById('modal-body'); if (ports.length === 0) { modalBody.innerHTML = `<p>No available ports.</p>`; return; } modalBody.innerHTML = `<h3>Select Port</h3><div class="port-list"></div>`; const list = modalBody.querySelector('.port-list'); ports.forEach(port => { const btn = document.createElement('button'); btn.className = 'tool-btn'; btn.style.margin = '5px'; btn.textContent = port; btn.onclick = () => { document.getElementById('port-input').value = port; updatePortInfo(port, document.getElementById('baud-input').value); saveConfigSilently(); closeModal(); }; list.appendChild(btn); }); }
function showPortSelectionError(msg) { document.getElementById('modal-body').innerHTML = `<p style="color:red;">Error: ${msg}</p>`; }
function closeModal() { document.getElementById('modal').style.display = 'none'; }

