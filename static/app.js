// app.js
let ws;
let historyList = [];
let historyIndex = 0;
let quickCommands = [];   // [{name, data, suffix}]
let qcLastForm = { name: '', data: '', suffix: '' }; // prefill memory
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
const MAX_OUTPUT_LINES = 500000;
const FLUSH_BATCH_SIZE = 500;
let outputTrimOffset = 0;

// --- Virtual Scrolling State (traditional mode) ---
// Only a window of rows around the viewport lives in the DOM; outputMessages
// (plain text) is the single source of truth. Rows are recreated on scroll.
let vsEstRowHeight = 21;      // measured average row height (updated on render)
const VS_OVERSCAN = 60;      // rows rendered above/below viewport
let vsWindowFirst = 0;       // first rendered row index (in outputMessages)
let vsNeedsInit = true;      // spacers not yet created in #output
let vsRenderPending = false;
let vsAutoScroll = true;     // stick to bottom while user hasn't scrolled up
let vsLastTotal = -1;

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
    setupTitlebar();
    setupResizeHandles();
    document.querySelectorAll('.config-section h3.sec-toggle').forEach(h => {
        h.addEventListener('click', () => {
            const sec = h.closest('.config-section');
            sec.classList.toggle('collapsed');
            h.textContent = h.textContent.replace(/^[▾▸]\s*/, sec.classList.contains('collapsed') ? '▸ ' : '▾ ');
        });
    });
    // Populate the font datalist from the system's monospace fonts (the
    // backend enumerates once and caches; ~1-5ms, no per-keystroke cost).
    fetch('/listfonts', { method: 'POST' }).then(r => r.json()).then(data => {
        const dl = document.getElementById('font-list');
        if (dl && data.fonts) {
            dl.innerHTML = data.fonts.map(f => `<option value="${f.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}">`).join('');
        }
    }).catch(() => {});
    // Mode badge (status bar): click toggles SHELL <-> RAW. Suffix and
    // ascii/hex sub-modes are changed via the suffix dropdown / sidebar
    // radios - clicking the badge itself only flips shell on/off, so the
    // toggle is always obvious and reversible in one click.
    const sbMode = document.getElementById('sb-mode');
    if (sbMode) sbMode.addEventListener('click', () => {
        setShellEnabled(!shellEnabled);
    });
    const suffixSel = document.getElementById('suffix-select');
    if (suffixSel) suffixSel.addEventListener('change', sbUpdateMode);
    const modeRadios = document.querySelectorAll('input[name="mode"]');
    modeRadios.forEach(r => r.addEventListener('change', sbUpdateMode));
    const qcAdd = document.getElementById('qc-add-btn');
    if (qcAdd) qcAdd.addEventListener('click', () => qcEdit(-1));
    const qcManageBtn = document.getElementById('qc-manage-btn');
    if (qcManageBtn) qcManageBtn.addEventListener('click', qcManage);
    document.addEventListener('keydown', (e) => {
        // Ctrl+1..9: fire quick commands. Not when typing in an input (except
        // the terminal input where digits belong to the command being typed).
        if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
            const idx = parseInt(e.key) - 1;
            if (idx < quickCommands.length) { e.preventDefault(); qcSend(idx); }
        }
    });
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
        _lastGlobalLineNumWidth = 0;
        updateGlobalLineNumWidth(outputMessages.length + outputTrimOffset);
    } else {
        terminalWrapper.style.display = 'none'; logContainer.style.display = 'flex'; sidebar.style.display = 'none';
        if (inputArea) inputArea.style.display = 'none';
        const logView = document.getElementById(tabId); if (logView) logView.style.display = 'flex';
        const tabData = logTabs[tabId];
        if (tabData) {
            _lastGlobalLineNumWidth = 0;
            const count = tabData.view ? tabData.view.totalLines : 0;
            updateGlobalLineNumWidth(count);
        }
    }
}

function createLogTab(fileName) {
    const tabBar = document.getElementById('tab-bar');
    const logContainer = document.getElementById('log-views-container');
    const tabId = `log_${Date.now()}`;
    const newTab = document.createElement('div'); newTab.className = 'tab'; newTab.dataset.tab = tabId;
    newTab.title = fileName;
    newTab.innerHTML = `<span class="tab-name">${fileName}</span><span class="tab-close">×</span>`;
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
    logTabs[tabId] = { view: null, name: fileName };
    setupSpecificLogFilter(tabId);
    switchTab(tabId);
    return tabId;
}

function closeLogTab(tabId) {
    if (logTabs[tabId] && logTabs[tabId].view) logTabs[tabId].view.destroy();
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
        scheduleFilterUpdate();
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
    let lastHeight = '200px';

    mainToggleBtn.addEventListener('click', () => {
        const isCollapsed = panel.classList.toggle('collapsed');
        if (isCollapsed) panel.style.height = '';
        else panel.style.height = lastHeight;
        mainToggleBtn.textContent = `${isCollapsed ? '▼' : '▲'} Filter`;
    });

    let isResizing = false;
    handle.addEventListener('mousedown', (e) => {
        e.preventDefault(); isResizing = true;
        document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none';
        panel.style.transition = 'none'; panel.classList.remove('collapsed');
        if (!panel.style.height) panel.style.height = '200px';
        mainToggleBtn.textContent = '▲ Filter';
    });
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const parentRect = panel.parentElement.getBoundingClientRect();
        const minMainHeight = 50;
        const maxAllowed = parentRect.height - minMainHeight;
        let h = parentRect.bottom - e.clientY;
        h = Math.max(100, Math.min(h, maxAllowed > 100 ? maxAllowed : parentRect.height - 10));
        panel.style.height = `${h}px`;
    });
    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
            panel.style.transition = ''; lastHeight = panel.style.height;
        }
    });

    input.addEventListener('input', (e) => {
        const pattern = e.target.value.trim();
        try { regex = new RegExp(pattern, 'gi'); input.style.borderColor = pattern ? 'var(--accent-color)' : 'var(--border-color)'; } catch (e) { regex = null; input.style.borderColor = 'var(--danger-color)'; }
        if (isEnabled) scheduleLogFilterUpdate(regex, outputEl, tabId);
    });
    toggleBtn.addEventListener('click', (e) => { isEnabled = !isEnabled; toggleBtn.textContent = isEnabled ? 'ON' : 'OFF'; toggleBtn.style.backgroundColor = isEnabled ? 'var(--success-color)' : ''; if (isEnabled) runFullLogFilter(regex, outputEl, tabId); });
    clearBtn.addEventListener('click', () => { outputEl.innerHTML = ''; });
    outputEl.addEventListener('click', (e) => { const row = e.target.closest('.filter-row'); if (row) { const lineIndex = parseInt(row.dataset.lineIndex); if (!isNaN(lineIndex)) jumpToLine(lineIndex, tabId); } });
}

/**
 * @brief Single-pass merge processor for filter panel rendering.
 *        Collects all highlight-rule and filter-regex matches on the raw
 *        text, merges overlapping intervals, assigns three sentinel types
 *        (HL=highlight only, FM=filter only, CB=combined both), then
 *        escapes, converts ANSI, and replaces sentinels with HTML.
 *        This avoids nested-sentinel corruption when a word matches both.
 */
function processFilterLine(text, filterRegex) {
    let hlMatches = [];
    let fmMatches = [];

    if (combinedHighlightRegex) {
        const hlRegex = combinedHighlightRegex; // exec loop manages lastIndex itself
        let match;
        while ((match = hlRegex.exec(text)) !== null) {
            for (let i = 0; i < highlightColorMap.length; i++) {
                if (match[i + 1] !== undefined) {
                    hlMatches.push({ start: match.index, end: match.index + match[0].length, color: highlightColorMap[i] });
                    break;
                }
            }
            if (match[0].length === 0) { if (hlRegex.lastIndex >= text.length) break; hlRegex.lastIndex++; }
        }
    }

    if (filterRegex && filterRegex.source && filterRegex.source !== '(?:)') {
        const fmRegex = filterRegex; // exec loop manages lastIndex itself
        let match;
        while ((match = fmRegex.exec(text)) !== null) {
            if (match[0].length > 0) {
                fmMatches.push({ start: match.index, end: match.index + match[0].length });
            }
            if (match[0].length === 0) { if (fmRegex.lastIndex >= text.length) break; fmRegex.lastIndex++; }
        }
    }

    if (hlMatches.length === 0 && fmMatches.length === 0) {
        return ansiToHtml(escapeHtml(text));
    }

    let allMatches = [];
    for (const m of hlMatches) allMatches.push({ start: m.start, end: m.end, isHL: true, color: m.color });
    for (const m of fmMatches) allMatches.push({ start: m.start, end: m.end, isFM: true });
    allMatches.sort((a, b) => a.start - b.start || a.end - b.end);

    let merged = [];
    let i = 0;
    while (i < allMatches.length) {
        let cur = allMatches[i];
        let maxEnd = cur.end;
        let hasHL = cur.isHL;
        let hasFM = cur.isFM;
        let hlColor = cur.isHL ? cur.color : null;
        let j = i + 1;
        while (j < allMatches.length && allMatches[j].start < maxEnd) {
            maxEnd = Math.max(maxEnd, allMatches[j].end);
            if (allMatches[j].isHL && !hasHL) { hasHL = true; hlColor = allMatches[j].color; }
            else if (allMatches[j].isHL) { hlColor = allMatches[j].color; }
            if (allMatches[j].isFM) hasFM = true;
            j++;
        }
        merged.push({ start: cur.start, end: maxEnd, hasHL, hasFM, hlColor });
        i = j;
    }

    let result = '';
    let lastIdx = 0;
    for (const m of merged) {
        result += text.substring(lastIdx, m.start);
        const segment = text.substring(m.start, m.end);
        if (m.hasHL && m.hasFM) {
            result += `\x00CB${m.hlColor}\x00${segment}\x00CBEND\x00`;
        } else if (m.hasHL) {
            result += `\x00HL${m.hlColor}\x00${segment}\x00HLEND\x00`;
        } else {
            result += `\x00FM\x00${segment}\x00FMEND\x00`;
        }
        lastIdx = m.end;
    }
    result += text.substring(lastIdx);

    result = ansiToHtml(escapeHtml(result));
    result = result.replace(/\x00HL([^\x00]*)\x00([^\x00]*?)\x00HLEND\x00/g,
        '<span style="color:$1;font-weight:bold;">$2</span>');
    result = result.replace(/\x00FM\x00([^\x00]*?)\x00FMEND\x00/g,
        '<mark class="filter-match">$1</mark>');
    result = result.replace(/\x00CB([^\x00]*)\x00([^\x00]*?)\x00CBEND\x00/g,
        '<mark class="filter-match"><span style="color:$1;font-weight:bold;">$2</span></mark>');
    return result;
}

/**
 * @brief Builds a single filter-row HTML string. Used by batch renderers.
 */
function buildFilterRowHTML(text, lineIndex, filterRegex) {
    const numWidth = getComputedStyle(document.documentElement).getPropertyValue('--line-num-width').trim();
    const lineNum = lineIndex + 1;
    const body = processFilterLine(text, filterRegex);
    return `<div class="filter-row" data-line-index="${lineIndex}"><span class="filter-line-num" style="width:${numWidth}">${lineNum}</span><span class="filter-text">${body}</span></div>`;
}

function getDigitWidth(digits) { return String(digits).length * 8 + 16; }
let _lastGlobalLineNumWidth = 0;
function updateGlobalLineNumWidth(maxCount) { if (maxCount === _lastGlobalLineNumWidth) return; _lastGlobalLineNumWidth = maxCount; const width = getDigitWidth(maxCount); document.documentElement.style.setProperty('--line-num-width', `${width}px`); }
function stripAnsi(str) { return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''); }

let filterRenderGen = 0;

function scheduleFilterUpdate() { if (!isFilterEnabled) return; if (filterUpdateTimer) clearTimeout(filterUpdateTimer); filterUpdateTimer = setTimeout(() => { runFullFilter(); filterUpdateTimer = null; }, 500); }

function scheduleLogFilterUpdate(regex, outputEl, tabId) {
    const panel = outputEl.parentElement;
    if (!panel || panel.classList.contains('collapsed')) return;
    if (filterUpdateTimer) clearTimeout(filterUpdateTimer);
    filterUpdateTimer = setTimeout(() => { runFullLogFilter(regex, outputEl, tabId); filterUpdateTimer = null; }, 500);
}

const MAX_FILTER_ROWS = 5000;
function appendToSpecificFilterOutput(text, lineIndex, outputEl, sourceType, filterRegex) { const div = document.createElement('div'); div.className = 'filter-row'; div.dataset.lineIndex = lineIndex; const numSpan = document.createElement('span'); numSpan.className = 'filter-line-num'; numSpan.style.width = `var(--line-num-width)`; numSpan.textContent = lineIndex + 1; const textSpan = document.createElement('span'); textSpan.className = 'filter-text'; textSpan.innerHTML = processFilterLine(text, filterRegex); div.appendChild(numSpan); div.appendChild(textSpan); outputEl.appendChild(div); while (outputEl.children.length > MAX_FILTER_ROWS) { outputEl.removeChild(outputEl.firstChild); } if (outputEl.scrollHeight - outputEl.scrollTop <= outputEl.clientHeight + 50) { outputEl.scrollTop = outputEl.scrollHeight; } }

function jumpToLine(index, type) { if (type.startsWith('log_')) { const tabData = logTabs[type]; if (tabData && tabData.view) { tabData.view.jumpToLine(index); } } else if (shellEnabled && term) { const currentY = term.buffer.active.viewportY; term.scrollLines(index - currentY); if (timeGutter) timeGutter.flashLine(index); } else { const output = document.getElementById('output'); const realIndex = index - outputTrimOffset; if (realIndex >= 0 && realIndex < outputMessages.length) { output.scrollTop = realIndex * vsEstRowHeight - output.clientHeight / 2; vsAutoScroll = false; vsScheduleRender(); setTimeout(() => { const target = Array.prototype.slice.call(output.children).find(c => c.classList && c.classList.contains('log-row') && c.firstChild && parseInt(c.firstChild.textContent) === index + 1); if (target) { target.classList.add('flash-highlight'); setTimeout(() => target.classList.remove('flash-highlight'), 1000); } }, 50); } } }

function runFullFilter() {
    if (!filterRegex) return;
    if (!isFilterEnabled) return;
    const gen = ++filterRenderGen;
    updateGlobalLineNumWidth(0);
    let parts = [];
    if (shellEnabled && term) {
        const buffer = term.buffer.active;
        updateGlobalLineNumWidth(buffer.length);
        for (let i = 0; i < buffer.length; i++) {
            if (gen !== filterRenderGen) return;
            const line = buffer.getLine(i);
            if (line) {
                const text = line.translateToString(true);
                const cleanText = stripAnsi(text);
                if (filterRegex.test(cleanText)) {
                    parts.push(buildFilterRowHTML(cleanText, i, filterRegex));
                    filterRegex.lastIndex = 0;
                }
            }
        }
    } else {
        updateGlobalLineNumWidth(outputMessages.length + outputTrimOffset);
        for (let j = 0; j < outputMessages.length; j++) {
            if (gen !== filterRenderGen) return;
            const msg = outputMessages[j];
            if (filterRegex.test(msg)) {
                parts.push(buildFilterRowHTML(msg, j + outputTrimOffset, filterRegex));
                filterRegex.lastIndex = 0;
            }
        }
    }
    if (gen !== filterRenderGen) return;
    filterOutput.innerHTML = parts.join('');
    filterOutput.scrollTop = filterOutput.scrollHeight;
}

function runFullLogFilter(regex, outputEl, tabId) {
    if (!regex) return;
    const tabData = logTabs[tabId];
    if (!tabData) return;
    if (tabData.view) {
        tabData.view.search(regex);
    } else {
        outputEl.innerHTML = '';
    }
}

// ================= TIME GUTTER =================
class TimeGutter {
    constructor(element) { this.el = element; this.markers = []; this.lineTimestamps = []; this.cellHeight = 0; this.term = null; this.viewport = null; this.renderPending = false; }
    bindTerminal(term) { this.term = term; this.viewport = term.element.querySelector('.xterm-viewport'); if (!this.viewport) return; this.tryGetCellHeight(); this.syncFont(); term.onLineFeed(() => { const buffer = this.term.buffer.active; const completedIndex = buffer.baseY + buffer.cursorY - 1; if (completedIndex < 0) return; let logicalStart = completedIndex; while (logicalStart > 0) { const line = buffer.getLine(logicalStart); if (line && line.isWrapped) { logicalStart--; } else { break; } } const startLine = buffer.getLine(logicalStart); if (startLine && !startLine.isWrapped) { const lineText = startLine.translateToString(true).trim(); if (lineText.length > 0) { const now = new Date(); const ts = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}.${now.getMilliseconds().toString().padStart(3,'0')}`; const offset = logicalStart - (buffer.baseY + buffer.cursorY); let marker = null; try { if (typeof this.term.registerMarker === 'function') { marker = this.term.registerMarker(offset); } else if (typeof this.term.addMarker === 'function') { marker = this.term.addMarker(offset); } } catch(e) {} if (marker) { this.markers.push({ marker, ts }); } else { while (this.lineTimestamps.length <= logicalStart) { this.lineTimestamps.push(''); } this.lineTimestamps[logicalStart] = ts; } } } this.scheduleRender(); }); this.viewport.addEventListener('scroll', () => this.scheduleRender()); term.onResize(() => { this.tryGetCellHeight(); this.syncFont(); this.scheduleRender(); }); }
    syncFont() { const userFont = document.getElementById('font-input').value; this.el.style.fontFamily = getFullFontStack(userFont); }
    tryGetCellHeight() { if (!this.term || !this.term.element) return; try { this.cellHeight = this.term._core._renderService.dimensions.actualCellHeight; } catch(e) {} if (!this.cellHeight || this.cellHeight <= 0) { const row = this.term.element.querySelector('.xterm-rows > div'); if (row) this.cellHeight = row.getBoundingClientRect().height; } if (!this.cellHeight || this.cellHeight <= 0) { setTimeout(() => this.tryGetCellHeight(), 100); } }
    reset() { /* Do NOT dispose markers individually: term.reset() already replaced the buffers, so old markers are garbage. Disposing 40k markers triggers buffer._removeMarker splice-in-loop (O(n^2)) plus our onDispose filter (another O(n^2)) - that was the multi-second shell clear. Just drop the references. */ this.markers = []; this.lineTimestamps = []; this.el.innerHTML = ''; }
    flashLine(lineIndex) { const lines = this.el.querySelectorAll('.gutter-line'); lines.forEach(line => { const numEl = line.querySelector('.line-num-col'); if (numEl && parseInt(numEl.textContent) === lineIndex + 1) { line.classList.add('flash-highlight'); setTimeout(() => line.classList.remove('flash-highlight'), 1000); } }); }
    scheduleRender() { if (!this.renderPending) { this.renderPending = true; requestAnimationFrame(() => { this.render(); this.renderPending = false; }); } }
    render() { if (!this.term || !this.cellHeight || !this.viewport) return; const buffer = this.term.buffer.active; const scrollTop = this.viewport.scrollTop; const startRow = Math.round(scrollTop / this.cellHeight); const viewportHeight = this.viewport.clientHeight; const rowCount = Math.ceil(viewportHeight / this.cellHeight) + 2; const endRow = startRow + rowCount; const maxLine = buffer.length; const numWidth = getDigitWidth(maxLine); const timeWidth = timestampEnabled ? 90 : 0; this.el.style.width = `${numWidth + timeWidth}px`; if (timestampEnabled) this.el.classList.add('has-timestamps'); else this.el.classList.remove('has-timestamps'); const markerMap = {}; let disposedCount = 0; this.markers.forEach(m => { if (!m.marker.isDisposed) markerMap[m.marker.line] = m.ts; else disposedCount++; }); if (disposedCount > 500 && disposedCount > this.markers.length / 2) { this.markers = this.markers.filter(m => !m.marker.isDisposed); } let html = ''; for (let i = startRow; i < endRow; i++) { if (i < 0) continue; const top = (i * this.cellHeight) - scrollTop; const lineNum = i + 1; let ts = markerMap[i] || this.lineTimestamps[i] || ''; html += `<div class="gutter-line" style="top: ${top}px; height: ${this.cellHeight}px;"><span class="line-num-col" style="width: ${numWidth}px">${lineNum}</span>${timestampEnabled ? `<span class="time-col">${ts}</span>` : ''}</div>`; } this.el.innerHTML = html; }
}

// ================= CORE LOGIC =================
function getFullFontStack(userFont) { if (!userFont || userFont.trim() === '') { return DEFAULT_FONT_STACK; } return `${userFont}, ${DEFAULT_FONT_STACK}`; }
function syncShellUI(enabled) { if (enabled) { outputContainer.style.display = 'none'; shellArea.style.display = 'flex'; inputArea.style.display = 'none'; updateGutterVisibility(); } else { outputContainer.style.display = 'flex'; shellArea.style.display = 'none'; inputArea.style.display = 'flex'; } }
function updateGutterVisibility() { if (!timeGutterEl) return; timeGutterEl.style.display = 'block'; if(timeGutter) timeGutter.render(); if(term && fitAddon) fitAddon.fit(); }
function initWebSocket() { const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'; ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`); ws.onopen = () => console.log('WebSocket connected'); ws.onmessage = (event) => { try { const data = JSON.parse(event.data); switch(data.type) { case 'message': if (shellEnabled) { if (term) { let msg = data.message.replace(/\r?\n/g, '\r\n'); if (!isDeviceEcho(msg)) { term.write(applyShellHighlight(msg)); scheduleFilterUpdate(); } } else addToOutput(data.message); } else { addToOutput(cleanTraditionalLine(data.message)); } break; case 'script_log': appendToScriptConsole(data.message); break; case 'config': if (data.config) updateConfig(data.config); if (data.connected !== undefined) updateConnectionStatus(data.connected); if (data.mode) updateMode(data.mode); break; case 'status': console.log('Status:', data.message); break; case 'mode': updateMode(data.mode); break; case 'clear': clearOutput(false); break; } } catch (error) { console.error('Parse error:', error); } }; ws.onclose = () => setTimeout(initWebSocket, 1000); ws.onerror = (error) => console.error('WS error:', error); }

// ---- Echo suppression ----
// Many devices echo back what you send. After a quick command or a send we
// remember the exact line for a short window; an incoming chunk that starts
// with it is dropped (the user already saw the command go out).
let echoSent = null;
let echoTimer = null;
function noteEcho(data) {
    if (!data) return;
    echoSent = data.replace(/[\r\n]+$/, '');
    if (echoTimer) clearTimeout(echoTimer);
    echoTimer = setTimeout(() => { echoSent = null; }, 1200);
}
// True if the chunk is (only) the echo of something we just sent.
function isDeviceEcho(msg) {
    if (!echoSent || echoSent.length < 2) return false;
    const clean = msg.replace(/[\r\n]+$/, '');
    return clean === echoSent;
}
function setupSidebarFocusManagement() { document.querySelectorAll('#sidebar input, #sidebar select, #sidebar textarea').forEach(el => { el.addEventListener('mousedown', function(e) { if (term) term.blur(); }); el.addEventListener('focus', function() { if (term) term.blur(); }); }); }
function setupEventListeners() { document.getElementById('tab-bar').addEventListener('click', (e) => { const tab = e.target.closest('.tab'); if (tab) { if (e.target.classList.contains('tab-close')) { closeLogTab(tab.dataset.tab); } else { switchTab(tab.dataset.tab); } } }); document.getElementById('connect-btn').addEventListener('click', toggleConnection); document.getElementById('scan-btn').addEventListener('click', scanPorts); document.getElementById('clear-btn').addEventListener('click', () => clearOutput(true)); document.getElementById('export-btn').addEventListener('click', exportLog); document.getElementById('send-btn').addEventListener('click', sendData); document.getElementById('save-config-btn').addEventListener('click', saveConfig); document.getElementById('input').addEventListener('keydown', handleInputKeydown); document.getElementById('toggle-sidebar-btn').addEventListener('click', () => { document.getElementById('sidebar').classList.toggle('collapsed'); setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 250); }); document.getElementById('send-toggle-btn').addEventListener('click', function() { const area = document.getElementById('input-area'); area.classList.toggle('collapsed'); this.textContent = area.classList.contains('collapsed') ? '▼ Send' : '▲ Send'; }); document.getElementById('toggle-script-btn').addEventListener('click', () => { const panel = document.getElementById('script-panel'); panel.classList.toggle('collapsed'); setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 250); }); document.getElementById('refresh-scripts-btn').addEventListener('click', listScripts); document.getElementById('run-script-btn').addEventListener('click', runScript); document.getElementById('stop-script-btn').addEventListener('click', stopScript); document.getElementById('ascii-mode').addEventListener('change', function() { if (this.checked) setMode(this.value); }); document.getElementById('hex-mode').addEventListener('change', function() { if (this.checked) setMode(this.value); }); document.getElementById('timestamp-on').addEventListener('change', function() { if (this.checked) setTimestamp(true); }); document.getElementById('timestamp-off').addEventListener('change', function() { if (this.checked) setTimestamp(false); }); document.getElementById('shell-on').addEventListener('change', function() { if (this.checked) setShellEnabled(true); }); document.getElementById('shell-off').addEventListener('change', function() { if (this.checked) setShellEnabled(false); }); document.getElementById('theme-preset-select').addEventListener('change', handleThemePresetChange); document.getElementById('theme-bg').addEventListener('input', handleCustomThemeChange); document.getElementById('theme-fg').addEventListener('input', handleCustomThemeChange); document.getElementById('theme-cursor').addEventListener('input', handleCustomThemeChange); document.querySelector('.close').addEventListener('click', closeModal); window.addEventListener('click', (event) => { if (event.target == document.getElementById('modal')) closeModal(); }); document.getElementById('import-log-btn').addEventListener('click', () => {
        document.getElementById('import-log-input').click();
    }); document.getElementById('import-log-input').addEventListener('change', function(e) { if (this.files.length > 0) { handleImportLog(this.files[0]); this.value = ''; } }); }

function setupTitlebar() {
    document.getElementById('btn-minimize').addEventListener('click', () => {
        if (typeof minimizeWindow !== 'undefined') minimizeWindow();
    });
    const btnMax = document.getElementById('btn-maximize');
    btnMax.addEventListener('click', () => {
        if (typeof toggleMaximizeWindow !== 'undefined') toggleMaximizeWindow();
        btnMax.textContent = btnMax.textContent === '□' ? '❐' : '□';
    });
    document.getElementById('btn-close').addEventListener('click', () => {
        if (typeof closeWindow !== 'undefined') closeWindow();
    });
    const port = window.location.port || '8080';
    document.getElementById('titlebar-title').textContent = 'SerialZero :' + port;

    const titlebar = document.querySelector('.titlebar');

    // Dragging + double-click, both handled on mousedown:
    // mousedown calls startWindowDrag(), which sends WM_NCLBUTTONDOWN(HTCAPTION)
    // to the host window - the OS enters its native modal move loop directly
    // (DPI-correct across monitors). That modal loop swallows subsequent mouse
    // events, so a 'dblclick' event never fires - the double-click must be
    // detected here via e.detail (== 2 on the second click of a double-click).
    titlebar.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) return; // buttons stay clickable
        if (e.target.closest('.titlebar-controls')) return;
        if (e.detail >= 2) {
            // Double-click on the titlebar: toggle maximize/restore.
            if (typeof toggleMaximizeWindow !== 'undefined') toggleMaximizeWindow();
            btnMax.textContent = btnMax.textContent === '□' ? '❐' : '□';
            e.preventDefault();
            return;
        }
        if (typeof startWindowDrag !== 'undefined') startWindowDrag();
        e.preventDefault();
    });
}

function setupResizeHandles() {
    let resizeDir = null;
    let startX = 0, startY = 0;

    document.querySelectorAll('.resize-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            resizeDir = handle.className.replace('resize-handle ', '').replace('resize-', '');
            if (resizeDir === 'n') resizeDir = 'n';
            else if (resizeDir === 's') resizeDir = 's';
            else if (resizeDir === 'w') resizeDir = 'w';
            else if (resizeDir === 'e') resizeDir = 'e';
            startX = e.screenX;
            startY = e.screenY;
        });
    });

    document.addEventListener('mousemove', (e) => {
        if (!resizeDir) return;
        const dx = e.screenX - startX;
        const dy = e.screenY - startY;
        if (dx === 0 && dy === 0) return;
        if (typeof resizeWindow !== 'undefined') {
            resizeWindow(resizeDir, dx, dy);
        }
        startX = e.screenX;
        startY = e.screenY;
    });

    document.addEventListener('mouseup', () => {
        resizeDir = null;
    });
}
function handleImportLog(file) {
    if (!file) return;
    console.log('[Log] handleImportLog:', file.name, 'size:', file.size);
    const tabId = createLogTab(file.name);
    const view = new LogFileView(tabId);
    logTabs[tabId] = { view: view, name: file.name };
    const reader = new FileReader();
    reader.onload = async (e) => {
        const text = e.target.result;
        console.log('[Log] File read, length:', text.length);
        try {
            const resp = await fetch('/uploadlog', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tabId: tabId, name: file.name, content: text })
            });
            const data = await resp.json();
            console.log('[Log] /uploadlog response:', data);
            if (data.status === 'ok') {
                view.totalLines = data.totalLines;
                view._initOutput();
            } else {
                console.error('[Log] uploadlog failed:', data.message);
            }
        } catch (err) {
            console.error('[Log] uploadlog error:', err);
        }
    };
    reader.onerror = (e) => { console.error('[Log] FileReader error:', e); };
    reader.readAsText(file);
}
// ================= TOAST / STATUS BAR (meta-information channel) =================
// Data flow is for the device's words; UI's own words go to toasts +
// status bar. Errors use the warn/error look and live longer.
function showToast(msg, kind = 'info', ms = 3000) {
    const c = document.getElementById('toast-container');
    if (!c) return;
    const t = document.createElement('div');
    t.className = 'toast' + (kind !== 'info' ? ' ' + kind : '');
    const bar = document.createElement('div'); bar.className = 'toast-bar';
    const m = document.createElement('div'); m.className = 'toast-msg'; m.textContent = msg;
    t.appendChild(bar); t.appendChild(m);
    c.appendChild(t);
    const kill = () => { t.classList.add('leaving'); setTimeout(() => t.remove(), 200); };
    const timer = setTimeout(kill, kind === 'error' ? 6000 : ms);
    t.addEventListener('click', () => { clearTimeout(timer); kill(); });
}
const toast = (msg, kind, ms) => showToast(msg, kind, ms);

// ---- status bar wiring ----
function sbUpdateConnection(connected) {
    const dot = document.getElementById('sb-dot');
    const txt = document.getElementById('sb-conn');
    if (dot) dot.className = 'sb-dot' + (connected ? ' connected' : '');
    if (txt) txt.textContent = connected ? 'Connected' : 'Disconnected';
}
function sbUpdateMode() {
    const el = document.getElementById('sb-mode');
    if (!el) return;
    if (shellEnabled) el.textContent = 'SHELL ⏎=CR';
    else el.textContent = (currentMode === 'hex' ? 'HEX' : 'RAW') + ' ' + suffixLabel();
}
function suffixLabel() {
    const sel = document.getElementById('suffix-select');
    if (!sel) return '';
    if (sel.value === '\n') return '+LF';
    if (sel.value === '\r\n') return '+CRLF';
    return '';
}
function sbUpdatePort(port, baud) {
    const el = document.getElementById('sb-port');
    if (el) el.textContent = port ? `${port} · ${baud}` : '';
}
function sbTick(rx, tx) {
    const el = document.getElementById('sb-counters');
    if (el && rx !== undefined) el.textContent = `↓${rx} ↑${tx}`;
}

function addToOutput(text) { outputMessages.push(text); pendingMessages.push(text); scheduleOutputUpdate(); if (isFilterEnabled && filterRegex && filterRegex.test(text)) { appendToSpecificFilterOutput(text, outputMessages.length - 1 + outputTrimOffset, filterOutput, 'main', filterRegex); } }
function scheduleOutputUpdate() { if (!updateTimer) updateTimer = setTimeout(flushOutput, 16); }
// ===== Virtual scrolling for the traditional log view =====
function vsEnsureSpacers(output) { if (vsNeedsInit) { output.innerHTML = '<div id="vs-top-spacer" style="height:0"></div><div id="vs-bottom-spacer" style="height:0"></div>'; vsNeedsInit = false; vsWindowFirst = -1; } }
function vsScheduleRender() { if (!vsRenderPending) { vsRenderPending = true; requestAnimationFrame(vsRenderWindow); } }
function vsRenderWindow() {
    vsRenderPending = false;
    if (shellEnabled && term) return;           // shell mode owns the viewport
    const output = document.getElementById('output');
    if (!output) return;
    vsEnsureSpacers(output);
    const total = outputMessages.length;
    const topSp = document.getElementById('vs-top-spacer');
    const botSp = document.getElementById('vs-bottom-spacer');
    if (!topSp || !botSp) return;
    if (total === 0) { if (vsWindowFirst !== 0) { output.innerHTML = '<div id="vs-top-spacer" style="height:0"></div><div id="vs-bottom-spacer" style="height:0"></div>'; vsWindowFirst = 0; } return; }
    const viewH = output.clientHeight || 600;
    const viewportRows = Math.ceil(viewH / Math.max(vsEstRowHeight, 8)) + 1;
    // Determine first row to render, based on scrollTop (approximate anchor)
    let first = Math.floor(output.scrollTop / vsEstRowHeight) - VS_OVERSCAN;
    first = Math.max(0, Math.min(first, total - viewportRows - VS_OVERSCAN));
    const count = Math.min(total - first, viewportRows + 2 * VS_OVERSCAN);
    // Skip only if identical window AND unchanged total (prevents re-render loops).
    if (first === vsWindowFirst && count === vsWindowCount && vsLastTotal === total) return;
    vsLastTotal = total;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
        const idx = first + i;
        const rowDiv = document.createElement('div');
        rowDiv.className = 'log-row';
        const numSpan = document.createElement('div');
        numSpan.className = 'log-row-num';
        numSpan.textContent = outputTrimOffset + idx + 1;
        const textSpan = document.createElement('div');
        textSpan.className = 'log-row-text';
        textSpan.innerHTML = processLogLine(outputMessages[idx]);
        rowDiv.appendChild(numSpan); rowDiv.appendChild(textSpan);
        frag.appendChild(rowDiv);
    }
    // Replace previously rendered rows (keep the two spacers)
    while (output.children.length > 2) output.removeChild(output.children[1]);
    output.insertBefore(frag, botSp);
    vsWindowFirst = first; vsWindowCount = count;
    topSp.style.height = (first * vsEstRowHeight) + 'px';
    botSp.style.height = Math.max(0, (total - first - count) * vsEstRowHeight) + 'px';
    // Measure real average height from rendered rows to refine the estimate
    if (count > 0 && output.children.length > 2) {
        const rowsH = output.children[output.children.length - 2].offsetTop - output.children[1].offsetTop;
        if (rowsH > 0) {
            const measured = rowsH / count;
            if (measured > 4 && measured < 200 && Math.abs(measured - vsEstRowHeight) / vsEstRowHeight > 0.05) {
                const scrollFrac = output.scrollHeight > 0 ? output.scrollTop / output.scrollHeight : 0;
                vsEstRowHeight = Math.round(measured);
                topSp.style.height = (first * vsEstRowHeight) + 'px';
                botSp.style.height = Math.max(0, (total - first - count) * vsEstRowHeight) + 'px';
                if (vsAutoScroll) output.scrollTop = output.scrollHeight;
                else output.scrollTop = Math.round(scrollFrac * output.scrollHeight);
            }
        }
    }
    if (vsAutoScroll) output.scrollTop = output.scrollHeight;
}
let vsWindowCount = 0;
function vsOnScroll() {
    const output = document.getElementById('output');
    if (!output) return;
    // Bottom-stick detection: user at (or within 2 rows of) the bottom stays stuck
    const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight <= 2 * Math.max(vsEstRowHeight, 8);
    vsAutoScroll = nearBottom;
    vsScheduleRender();
}
function flushOutput() { updateTimer = null; if (pendingMessages.length === 0) return; pendingMessages.splice(0, FLUSH_BATCH_SIZE); updateGlobalLineNumWidth(outputMessages.length + outputTrimOffset); while (outputMessages.length > MAX_OUTPUT_LINES) { outputMessages.shift(); outputTrimOffset++; } if (pendingMessages.length > 0) scheduleOutputUpdate(); vsScheduleRender(); }

// ================= UTILITY & CONFIG =================
function applyFontSettings(font, size) { const output = document.getElementById('output'); const fullFont = getFullFontStack(font); output.style.fontFamily = fullFont; output.style.fontSize = size + 'px'; document.documentElement.style.setProperty('--log-font-size', `${size}px`); document.documentElement.style.setProperty('--gutter-font-size', `${Math.max(10, size - 1)}px`); const highlightInput = document.getElementById('highlight-input'); if(highlightInput) { highlightInput.style.fontFamily = fullFont; highlightInput.style.fontSize = `${size}px`; } const mainFilterOutput = document.getElementById('filter-output'); if(mainFilterOutput) { mainFilterOutput.style.fontFamily = fullFont; mainFilterOutput.style.fontSize = size + 'px'; } Object.keys(logTabs).forEach(tabId => { const logOutput = document.getElementById(`${tabId}_output`); const logFilterOutput = document.getElementById(`${tabId}_filter_output`); if(logOutput) { logOutput.style.fontFamily = fullFont; logOutput.style.fontSize = `var(--log-font-size)`; } if(logFilterOutput) { logFilterOutput.style.fontFamily = fullFont; logFilterOutput.style.fontSize = size + 'px'; } }); if (term) { term.options.fontFamily = fullFont; term.options.fontSize = parseInt(size); setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 50); } if (timeGutter) timeGutter.syncFont(); }
function updatePortInfo(port, baud) { sbUpdatePort(port, baud); document.getElementById('port-info').textContent = `${port} | ${baud}`; }
function loadConfig() { fetch('/getconfig', { method: 'POST' }).then(r => r.json()).then(data => { updateConfig(data.config, true); updateConnectionStatus(data.connected); updateMode(data.mode); const configShell = (data.config && data.config.UI) ? data.config.UI.Shell : true; setShellEnabled(configShell, false); requestAnimationFrame(() => { requestAnimationFrame(() => { fetch('/ready', { method: 'POST' }); }); }); }).catch(err => { console.error('Config load failed:', err); shellEnabled = false; syncShellUI(false); fetch('/ready', { method: 'POST' }); }); }
function updateConfig(config, isInitial = false) { if (!config) return; if (config.Serial) { document.getElementById('port-input').value = config.Serial.Port || 'COM1'; document.getElementById('baud-input').value = config.Serial.Baud || 9600; document.getElementById('databits-select').value = config.Serial.Databits || 8; document.getElementById('stopbits-select').value = config.Serial.Stopbits || 1; document.getElementById('parity-select').value = config.Serial.Parity || 'N'; updatePortInfo(config.Serial.Port, config.Serial.Baud); } if (config.UI) { document.getElementById('font-input').value = config.UI.Font || 'Consolas, monospace'; document.getElementById('fontsize-input').value = config.UI.FontSize || 14; document.getElementById('scrollback-input').value = config.UI.Scrollback || 100000; applyFontSettings(config.UI.Font, config.UI.FontSize); updateTimestampStatus(config.UI.Timestamp !== undefined ? config.UI.Timestamp : true); if (!isInitial && !userActionLock) updateShellStatus(config.UI.Shell !== undefined ? config.UI.Shell : true); } if (config.Highlight && config.Highlight.Groups) { const groups = Array.isArray(config.Highlight.Groups) ? config.Highlight.Groups : ["error:#ff0000", "warn:#ffa500"]; document.getElementById('highlight-input').value = groups.join('\n'); updateHighlightRules(groups); renderHighlightPreviewStrip(); } if (config.Theme) { const name = config.Theme.Name || "Default"; document.getElementById('theme-preset-select').value = name; if (name === "Custom") { document.getElementById('custom-theme-area').style.display = 'flex'; document.getElementById('theme-bg').value = config.Theme.Background || '#1e1e1e'; document.getElementById('theme-fg').value = config.Theme.Foreground || '#cccccc'; document.getElementById('theme-cursor').value = config.Theme.Cursor || '#ffffff'; applyTheme(config.Theme); } else { document.getElementById('custom-theme-area').style.display = 'none'; applyTheme(themePresets[name]); } }  qcLoad(config);}
function addConfigChangeListeners() { ['port-input', 'baud-input', 'databits-select', 'stopbits-select', 'parity-select', 'font-input', 'fontsize-input', 'highlight-input', 'scrollback-input'].forEach(id => { document.getElementById(id).addEventListener('change', saveConfigSilently); }); document.getElementById('port-input').addEventListener('input', function() { updatePortInfo(this.value, document.getElementById('baud-input').value); }); document.getElementById('port-input').addEventListener('change', function() { updatePortInfo(this.value, document.getElementById('baud-input').value); confirmIfConnected('port', this.value); }); document.getElementById('baud-input').addEventListener('change', function() { updatePortInfo(document.getElementById('port-input').value, this.value); confirmIfConnected('baud', this.value); }); document.getElementById('databits-select').addEventListener('change', function() { confirmIfConnected('data bits', this.value); }); document.getElementById('stopbits-select').addEventListener('change', function() { confirmIfConnected('stop bits', this.value); }); document.getElementById('parity-select').addEventListener('change', function() { confirmIfConnected('parity', this.value); }); document.getElementById('font-input').addEventListener('change', function() { applyFontSettings(this.value, document.getElementById('fontsize-input').value); }); document.getElementById('fontsize-input').addEventListener('change', function() { applyFontSettings(document.getElementById('font-input').value, this.value); }); document.getElementById('scrollback-input').addEventListener('change', function() { if (shellEnabled && term) { setShellEnabled(false, false); setTimeout(() => setShellEnabled(true, false), 100); } }); document.getElementById('highlight-input').addEventListener('change', function() { updateHighlightRules(this.value.split('\n').map(l => l.trim()).filter(l => l)); if(isFilterEnabled) runFullFilter(); }); }
// Changing serial params while connected doesn't take effect until
// reconnect - say so instead of failing silently.
function confirmIfConnected(param, value) {
    if (!isConnected) return;
    toast(`Connected — new ${param} (${value}) applies after reconnect`, 'warn', 4000);
}
function saveConfig() { fetch('/saveconfig', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(getFormData()) }).then(r => r.json()).then(data => { if (data.status !== 'ok') toast('Config save failed: ' + data.message, 'error'); else toast('Configuration saved'); }); }
function saveConfigSilently() { fetch('/saveconfig', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(getFormData()) }).catch(err => toast('Config save failed: ' + err.message, 'error')); }
function getFormData() { const themeName = document.getElementById('theme-preset-select').value; let themeData = { Name: themeName }; if (themeName === "Custom") { themeData.Background = document.getElementById('theme-bg').value; themeData.Foreground = document.getElementById('theme-fg').value; themeData.Cursor = document.getElementById('theme-cursor').value; Object.assign(themeData, themePresets["Default"]); } else { const preset = themePresets[themeName]; if(preset) Object.assign(themeData, preset); } return { Serial: { Port: document.getElementById('port-input').value, Baud: parseInt(document.getElementById('baud-input').value), Databits: parseInt(document.getElementById('databits-select').value), Stopbits: parseInt(document.getElementById('stopbits-select').value), Parity: document.getElementById('parity-select').value }, UI: { Font: document.getElementById('font-input').value, FontSize: parseInt(document.getElementById('fontsize-input').value), Timestamp: timestampEnabled, Shell: shellEnabled, Scrollback: parseInt(document.getElementById('scrollback-input').value) || 100000 }, Highlight: { Groups: document.getElementById('highlight-input').value.split('\n').map(l=>l.trim()).filter(l=>l) }, Log: { Path: './logs' }, Theme: themeData, QuickCommands: quickCommands }; }

// ================= QUICK COMMANDS =================
function qcRender() {
    const chipsEl = document.getElementById('qc-chips');
    if (!chipsEl) return;
    chipsEl.innerHTML = '';
    if (!quickCommands.length) {
        const hint = document.createElement('span');
        hint.className = 'qc-empty-hint';
        hint.textContent = 'No quick commands — click ＋ to create one (Ctrl+1..9 to fire)';
        chipsEl.appendChild(hint);
        return;
    }
    quickCommands.forEach((qc, i) => {
        const chip = document.createElement('button');
        chip.className = 'qc-chip';
        chip.title = qc.data + (qc.suffix === '\n' ? ' (+LF)' : qc.suffix === '\r\n' ? ' (+CRLF)' : '');
        chip.innerHTML = (i < 9 ? `<span class="qc-key-badge">${i+1}</span>` : '') + qc.name.replace(/&/g,'&amp;').replace(/</g,'&lt;') + (qc.suffix ? '<span class="qc-suffix-mark">⏎</span>' : '');
        chip.addEventListener('click', () => qcSend(i));
        chip.addEventListener('contextmenu', (e) => { e.preventDefault(); qcMenu(e, i); });
        chipsEl.appendChild(chip);
    });
}

// Dual-mode send: shell -> WebSocket input channel (same as typing in xterm);
// traditional -> POST /send (same as the input box).
function qcSend(i) {
    const qc = quickCommands[i];
    if (!qc) return;
    if (shellEnabled) {
        const payload = qc.data + '\r';   // shell: Enter == CR
        if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'input', data: payload })); noteEcho(qc.data + '\r\n'); }
        else { toast('Not connected — cannot send quick command', 'warn'); return; }
    } else {
        const fd = new FormData();
        let data = qc.data;
        // suffix is stored as a real control char ("\n" = LF, "\r\n" = CRLF)
        if (qc.suffix === '\n') data += '\n';
        else if (qc.suffix === '\r\n') data += '\r\n';
        fd.append('data', data);
        fetch('/send', { method: 'POST', body: fd }).then(r => r.json()).then(res => {
            if (res.status !== 'ok') { toast('Quick command failed: ' + res.message, 'error'); return; }
        });
    }
    // flash feedback on the chip
    const chips = document.querySelectorAll('#qc-chips .qc-chip');
    const chip = chips[i];
    if (chip) { chip.classList.add('flash'); setTimeout(() => chip.classList.remove('flash'), 300); }
}

function qcMenu(e, i) {
    qcCloseMenu();
    const menu = document.createElement('div');
    menu.className = 'qc-menu';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 140) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
    const items = [
        ['Edit', () => qcEdit(i)],
        ['Copy data', () => navigator.clipboard.writeText(quickCommands[i].data).catch(()=>{})],
        ['Delete', () => { quickCommands.splice(i, 1); qcRender(); qcSave(); }, true],
    ];
    items.forEach(([label, fn, danger]) => {
        const b = document.createElement('button');
        b.className = 'qc-menu-item' + (danger ? ' qc-menu-danger' : '');
        b.textContent = label;
        b.addEventListener('click', () => { fn(); qcCloseMenu(); });
        menu.appendChild(b);
    });
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', qcCloseMenu, { once: true }), 0);
}
function qcCloseMenu() { const m = document.querySelector('.qc-menu'); if (m) m.remove(); }

// Create (i === -1) or edit (i >= 0) in the shared modal.
function qcEdit(i) {
    const qc = i >= 0 ? quickCommands[i] : qcLastForm;
    const body = document.getElementById('modal-body');
    body.innerHTML = `
        <h3>${i >= 0 ? 'Edit Quick Command' : 'New Quick Command'}</h3>
        <div class="qc-form">
            <div><label>Name (shown on the button)</label><input id="qc-f-name" value="${qc.name.replace(/"/g,'&quot;')}"></div>
            <div><label>Data to send</label><input id="qc-f-data" value="${qc.data.replace(/"/g,'&quot;')}"></div>
            <div><label>Suffix (non-shell mode)</label>
                <select id="qc-f-suffix">
                    <option value=""${qc.suffix===''?' selected':''}>None</option>
                    <option value="\n"${qc.suffix==='\n'?' selected':''}>LF (\n)</option>
                    <option value="\r\n"${qc.suffix==='\r\n'?' selected':''}>CRLF (\r\n)</option>
                </select></div>
            <div id="qc-f-error" style="color: var(--danger-color); font-size: 11px; min-height: 14px;"></div>
            <div class="qc-form-actions">
                <button class="action-btn" id="qc-f-save">Save</button>
                <button class="tool-btn" id="qc-f-cancel">Cancel</button>
            </div>
        </div>`;
    document.getElementById('modal').style.display = 'block';
    document.getElementById('qc-f-cancel').onclick = closeModal;
    document.getElementById('qc-f-save').onclick = () => {
        const name = document.getElementById('qc-f-name').value.trim();
        const data = document.getElementById('qc-f-data').value;
        if (!name || !data) {
            const err = document.getElementById('qc-f-error');
            if (err) err.textContent = 'Name and data are required.';
            return;
        }
        const suffix = document.getElementById('qc-f-suffix').value;
        qcLastForm = { name, data, suffix }; // prefill next time
        if (i >= 0) quickCommands[i] = { name, data, suffix };
        else quickCommands.push({ name, data, suffix });
        qcRender(); qcSave(); closeModal();
    };
    document.getElementById('qc-f-name').focus();
}

// Manage panel: table with checkboxes, bulk delete, reorder (Ctrl+N order
// follows this list), and per-row edit via qcEdit(i).
function qcManage() {
    const body = document.getElementById('modal-body');
    if (!quickCommands.length) {
        body.innerHTML = `<h3>Manage Quick Commands</h3>
            <div class="qc-form"><p style="color: var(--text-secondary); font-size: 12px;">
            No quick commands yet. Close this dialog and click ＋ to create one.</p>
            <div class="qc-form-actions"><button class="tool-btn" id="qc-m-close">Close</button></div></div>`;
        document.getElementById('modal').style.display = 'block';
        document.getElementById('qc-m-close').onclick = closeModal;
        return;
    }
    const rows = quickCommands.map((qc, i) => `
        <tr data-i="${i}">
            <td class="qc-m-check"><input type="checkbox" class="qc-m-cb"></td>
            <td class="qc-m-name">${escapeHtml(qc.name)}${qc.suffix ? ' <span style="opacity:0.6">⏎</span>' : ''}</td>
            <td class="qc-m-data" title="${escapeHtml(qc.data)}">${escapeHtml(qc.data)}</td>
            <td class="qc-m-ops">
                <button class="qc-m-op" data-op="up" title="Move up">↑</button>
                <button class="qc-m-op" data-op="down" title="Move down">↓</button>
                <button class="qc-m-op" data-op="edit" title="Edit">✏</button>
                <button class="qc-m-op qc-m-op-danger" data-op="del" title="Delete">🗑</button>
            </td>
        </tr>`).join('');
    body.innerHTML = `
        <h3>Manage Quick Commands</h3>
        <div class="qc-m-toolbar">
            <label class="qc-m-selall"><input type="checkbox" id="qc-m-all"> Select all</label>
            <span id="qc-m-count" class="qc-m-count"></span>
            <span style="flex:1"></span>
            <button class="qc-m-danger-btn" id="qc-m-del">Delete selected</button>
            <button class="tool-btn" id="qc-m-close">Close</button>
        </div>
        <div class="qc-m-table-wrap"><table class="qc-m-table">
            <thead><tr><th></th><th>Name</th><th>Data</th><th></th></tr></thead>
            <tbody id="qc-m-tbody">${rows}</tbody>
        </table></div>`;
    document.getElementById('modal').style.display = 'block';
    document.getElementById('modal-content')?.classList.add('wide');
    const tbody = document.getElementById('qc-m-tbody');
    const countEl = document.getElementById('qc-m-count');
    const updateCount = () => {
        const n = tbody.querySelectorAll('.qc-m-cb:checked').length;
        countEl.textContent = n ? n + ' selected' : '';
    };
    tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('.qc-m-op');
        if (!btn) return;
        const i = parseInt(btn.closest('tr').dataset.i, 10);
        const op = btn.dataset.op;
        if (op === 'up' && i > 0) { [quickCommands[i-1], quickCommands[i]] = [quickCommands[i], quickCommands[i-1]]; qcSave(); qcManage(); }
        else if (op === 'down' && i < quickCommands.length - 1) { [quickCommands[i], quickCommands[i+1]] = [quickCommands[i+1], quickCommands[i]]; qcSave(); qcManage(); }
        else if (op === 'edit') { qcEdit(i); }
        else if (op === 'del') { quickCommands.splice(i, 1); qcRender(); qcSave(); qcManage(); }
    });
    tbody.addEventListener('change', (e) => { if (e.target.classList.contains('qc-m-cb')) updateCount(); });
    document.getElementById('qc-m-all').addEventListener('change', function() {
        tbody.querySelectorAll('.qc-m-cb').forEach(cb => cb.checked = this.checked);
        updateCount();
    });
    document.getElementById('qc-m-del').addEventListener('click', () => {
        const doomed = [...tbody.querySelectorAll('.qc-m-cb:checked')].map(cb => parseInt(cb.closest('tr').dataset.i, 10));
        if (!doomed.length) return;
        // delete from highest index down so earlier indices stay valid
        doomed.sort((a, b) => b - a).forEach(i => quickCommands.splice(i, 1));
        qcRender(); qcSave(); qcManage();
    });
    document.getElementById('qc-m-close').onclick = closeModal;
    updateCount();
}

// Persist: rides the existing /saveconfig round-trip.
function qcSave() { saveConfigSilently(); }
function qcLoad(config) {
    quickCommands = (config && Array.isArray(config.QuickCommands)) ? config.QuickCommands : [];
    qcRender();
}

// ================= REST OF HELPER FUNCTIONS =================
function setupSmartCopy() { const output = document.getElementById('output'); output.addEventListener('scroll', vsOnScroll, { passive: true }); output.addEventListener('keydown', function(e) { if (e.key === 'Enter') { const selection = window.getSelection().toString(); if (selection) { e.preventDefault(); navigator.clipboard.writeText(selection).catch(err => {}); } } }); }
function setupKeyboardShortcuts() { document.addEventListener('keydown', function(event) { if (event.target.tagName === 'INPUT' && event.target.id !== 'input') return; if (event.key === 'F2') { event.preventDefault(); toggleConnection(); } else if (event.key === 'F3') { event.preventDefault(); scanPorts(); } else if (event.key === 'Escape') { event.preventDefault(); closeModal(); closePalette(); } }); document.addEventListener('keydown', function(event) { if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) { event.preventDefault(); togglePalette(); } }); }

// ================= COMMAND PALETTE (Ctrl+K) =================
// Fuzzy-ish: substring match on label; arrow keys + Enter to run, Esc to close.
function paletteCommands() {
    const cmds = [
        { label: 'Connect', run: toggleConnection },
        { label: 'Scan ports', run: scanPorts },
        { label: 'Clear output', run: () => clearOutput(true) },
        { label: 'Export log', run: exportLog },
        { label: 'Import log file', run: () => document.getElementById('import-log-input').click() },
        { label: 'Toggle sidebar', run: () => document.getElementById('toggle-sidebar-btn').click() },
        { label: 'Toggle scripts panel', run: () => document.getElementById('toggle-script-btn').click() },
        { label: 'Toggle send panel', run: () => document.getElementById('send-toggle-btn').click() },
        { label: 'Mode: shell / raw', run: () => setShellEnabled(!shellEnabled) },
        { label: 'Mode: ascii', run: () => setMode('ascii') },
        { label: 'Mode: hex', run: () => setMode('hex') },
        { label: 'Save config', run: saveConfig },
        { label: 'Manage quick commands', run: qcManage },
    ];
    quickCommands.forEach((qc, i) => cmds.push({ label: `QC: ${qc.name || qc.data}`, run: () => qcSend(i) }));
    return cmds;
}
function togglePalette() { const p = document.getElementById('cmdk'); if (p && p.style.display === 'flex') { closePalette(); return; } openPalette(); }
function openPalette() {
    let p = document.getElementById('cmdk');
    if (!p) {
        p = document.createElement('div');
        p.id = 'cmdk';
        p.innerHTML = `<div class="cmdk-box"><input id="cmdk-input" placeholder="Type a command…" spellcheck="false"><div id="cmdk-list"></div></div>`;
        p.addEventListener('mousedown', (e) => { if (e.target === p) closePalette(); });
        document.body.appendChild(p);
        document.getElementById('cmdk-input').addEventListener('input', renderPalette);
        document.getElementById('cmdk-input').addEventListener('keydown', (e) => {
            const items = [...document.querySelectorAll('#cmdk-list .cmdk-item')];
            const cur = items.findIndex(it => it.classList.contains('sel'));
            if (e.key === 'ArrowDown') { e.preventDefault(); if (items[cur + 1]) { if (items[cur]) items[cur].classList.remove('sel'); items[cur + 1].classList.add('sel'); items[cur + 1].scrollIntoView({ block: 'nearest' }); } }
            else if (e.key === 'ArrowUp') { e.preventDefault(); if (cur > 0) { items[cur].classList.remove('sel'); items[cur - 1].classList.add('sel'); items[cur - 1].scrollIntoView({ block: 'nearest' }); } }
            else if (e.key === 'Enter') { e.preventDefault(); const it = items.find(i => i.classList.contains('sel')); if (it) { closePalette(); paletteCommands()[parseInt(it.dataset.i)].run(); } }
            else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
        });
    }
    p.style.display = 'flex';
    const inp = document.getElementById('cmdk-input');
    inp.value = ''; renderPalette(); inp.focus();
}
function closePalette() { const p = document.getElementById('cmdk'); if (p) p.style.display = 'none'; }
function renderPalette() {
    const q = (document.getElementById('cmdk-input').value || '').toLowerCase();
    const list = document.getElementById('cmdk-list');
    const cmds = paletteCommands();
    const hits = cmds.map((c, i) => ({ c, i })).filter(x => x.c.label.toLowerCase().includes(q));
    list.innerHTML = hits.map((x, n) => `<div class="cmdk-item${n === 0 ? ' sel' : ''}" data-i="${x.i}">${x.c.label.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`).join('') || '<div class="cmdk-empty">No match</div>';
    list.querySelectorAll('.cmdk-item').forEach(item => {
        item.addEventListener('click', () => { closePalette(); paletteCommands()[parseInt(item.dataset.i)].run(); });
        item.addEventListener('mousemove', () => {
            list.querySelectorAll('.cmdk-item').forEach(i2 => i2.classList.remove('sel'));
            item.classList.add('sel');
        });
    });
}
function adjustColor(hex, amount) { hex = hex.replace('#', ''); let r = parseInt(hex.substring(0, 2), 16); let g = parseInt(hex.substring(2, 4), 16); let b = parseInt(hex.substring(4, 6), 16); r = Math.min(255, Math.max(0, r + amount)); g = Math.min(255, Math.max(0, g + amount)); b = Math.min(255, Math.max(0, b + amount)); return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`; }
function applyTheme(themeData) { if (!themeData) return; const root = document.documentElement; const bgLuminance = parseInt(themeData.Background.substring(1, 3), 16) + parseInt(themeData.Background.substring(3, 5), 16) + parseInt(themeData.Background.substring(5, 7), 16); const isDark = bgLuminance < 384; const step = isDark ? 15 : -15; root.style.setProperty('--bg-primary', themeData.Background); root.style.setProperty('--bg-secondary', adjustColor(themeData.Background, step)); root.style.setProperty('--bg-tertiary', adjustColor(themeData.Background, step * 2)); root.style.setProperty('--border-color', adjustColor(themeData.Background, step * 3)); root.style.setProperty('--text-primary', themeData.Foreground); root.style.setProperty('--text-secondary', adjustColor(themeData.Foreground, isDark ? -80 : 80)); root.style.setProperty('--accent-color', themeData.Blue); root.style.setProperty('--accent-hover', adjustColor(themeData.Blue, isDark ? 30 : -30)); root.style.setProperty('--danger-color', themeData.Red); root.style.setProperty('--success-color', themeData.Green); root.style.setProperty('--warning-color', themeData.Yellow); if (term) { term.options.theme = { background: themeData.Background, foreground: themeData.Foreground, cursor: themeData.Cursor, selectionBackground: themeData.Cursor + '40', black: themeData.Black, red: themeData.Red, green: themeData.Green, yellow: themeData.Yellow, blue: themeData.Blue, magenta: themeData.Magenta, cyan: themeData.Cyan, white: themeData.White, brightBlack: themeData.BrightBlack, brightRed: themeData.BrightRed, brightGreen: themeData.BrightGreen, brightYellow: themeData.BrightYellow, brightBlue: themeData.BrightBlue, brightMagenta: themeData.BrightMagenta, brightCyan: themeData.BrightCyan, brightWhite: themeData.BrightWhite }; } }
function handleThemePresetChange() { const sel = document.getElementById('theme-preset-select'); const customArea = document.getElementById('custom-theme-area'); const name = sel.value; if (name === "Custom") { customArea.style.display = 'flex'; handleCustomThemeChange(); } else { customArea.style.display = 'none'; applyTheme(themePresets[name]); saveConfigSilently(); } }
function handleCustomThemeChange() { applyTheme({ Name: "Custom", Background: document.getElementById('theme-bg').value, Foreground: document.getElementById('theme-fg').value, Cursor: document.getElementById('theme-cursor').value, ...themePresets["Default"] }); saveConfigSilently(); }
function listScripts() { fetch('/listscripts', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'ok') { const select = document.getElementById('script-select'); select.innerHTML = '<option value="">-- Select Script --</option>'; data.scripts.forEach(s => { const opt = document.createElement('option'); opt.value = s; opt.textContent = s; select.appendChild(opt); }); } }); }
function runScript() { const filename = document.getElementById('script-select').value; if (!filename) { appendToScriptConsole('Please select a script first.'); return; } isScriptRunning = true; document.getElementById('script-status-text').textContent = 'Running...'; document.getElementById('script-status-text').style.color = 'var(--success-color)'; document.getElementById('script-console').innerHTML = ''; const formData = new FormData(); formData.append('filename', filename); fetch('/runscript', { method: 'POST', body: formData }).then(r => r.json()).then(data => { if (data.status !== 'ok') { appendToScriptConsole("❌ Failed to start: " + data.message); isScriptRunning = false; document.getElementById('script-status-text').textContent = 'Error'; document.getElementById('script-status-text').style.color = 'var(--danger-color)'; } else { appendToScriptConsole(`🚀 Executing: ${filename}`); } }); }
function stopScript() { fetch('/stopscript', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'ok') { isScriptRunning = false; document.getElementById('script-status-text').textContent = 'Stopped'; document.getElementById('script-status-text').style.color = 'var(--warning-color)'; /* Delay clear: backend still broadcasts trailing stop/finished messages via WS; clearing immediately re-renders them as leftover output. */ setTimeout(() => { document.getElementById('script-console').innerHTML = ''; }, 800); } }); }
function appendToScriptConsole(msg) { const con = document.getElementById('script-console'); const div = document.createElement('div'); div.textContent = msg; con.appendChild(div); con.scrollTop = con.scrollHeight; if (msg.includes("finished") || msg.includes("stopped") || msg.includes("Error")) { isScriptRunning = false; document.getElementById('script-status-text').textContent = 'Idle'; document.getElementById('script-status-text').style.color = 'var(--text-secondary)'; } }
function toggleConnection() { isConnected ? disconnect() : connect(); }
function connect() { fetch('/connect', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'connected') { isConnected = true; updateConnectionStatus(true); const sb = document.getElementById('sidebar'); if (sb && !sb.classList.contains('collapsed')) { sb.classList.add('collapsed'); setTimeout(() => { if (term && fitAddon) fitAddon.fit(); }, 250); } } else { toast('Connection failed: ' + data.message, 'error'); } }); }
function disconnect() { fetch('/disconnect', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'disconnected') { isConnected = false; updateConnectionStatus(false); } }); }
function scanPorts() { const modalBody = document.getElementById('modal-body'); modalBody.innerHTML = `<h3>Scanning...</h3>`; document.getElementById('modal').style.display = 'block'; fetch('/scan', { method: 'POST' }).then(r => r.json()).then(data => { if (data.status === 'ok') showPortSelection(data.ports); else showPortSelectionError(data.message); }).catch(error => showPortSelectionError(error.message)); }
function setMode(mode) { if (shellEnabled) return; const formData = new FormData(); formData.append('mode', mode); fetch('/setmode', { method: 'POST', body: formData }).then(r => r.json()).then(data => { if (data.status === 'ok') { currentMode = mode; updateMode(mode); } }); }
function setTimestamp(enabled) { timestampEnabled = enabled; updateTimestampStatus(enabled); saveConfigSilently(); }
function setShellEnabled(enabled, shouldSave = true) { if (shellEnabled === enabled && !(enabled && !term)) return; userActionLock = true; shellEnabled = enabled; updateShellStatus(enabled); syncShellUI(enabled); sbUpdateMode(); if (enabled) { if (!xtermLoaded) { syncShellUI(false); toast('Shell mode requires xterm.js.', 'error'); shellEnabled = false; updateShellStatus(false); userActionLock = false; return; } if (!term) { try { initTerminal(); } catch (e) { syncShellUI(false); shellEnabled = false; updateShellStatus(false); toast('Failed to initialize terminal: ' + e.message, 'error'); userActionLock = false; return; } } else { setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 50); } /* no content transfer from traditional mode: the session log file has everything */ toast('Switched to Shell mode — previous output is in the session log'); } else { /* no buffer sweep out of xterm: the session log file has everything */ if (term) { term.dispose(); term = null; fitAddon = null; if (timeGutter) { timeGutter.reset(); timeGutter = null; } } outputMessages = []; pendingMessages = []; document.getElementById('output').innerHTML = ''; outputTrimOffset = 0; vsWindowFirst = -1; vsNeedsInit = true; vsAutoScroll = true; } if (shouldSave) saveConfigSilently(); setTimeout(() => { userActionLock = false; }, 3000); }
function initTerminal() { const currentThemeName = document.getElementById('theme-preset-select').value; const currentTheme = currentThemeName === "Custom" ? { Background: document.getElementById('theme-bg').value, Foreground: document.getElementById('theme-fg').value, Cursor: document.getElementById('theme-cursor').value, ...themePresets["Default"] } : themePresets[currentThemeName]; term = new Terminal({ cursorBlink: true, theme: { background: currentTheme.Background, foreground: currentTheme.Foreground, cursor: currentTheme.Cursor, black: currentTheme.Black, red: currentTheme.Red, green: currentTheme.Green, yellow: currentTheme.Yellow, blue: currentTheme.Blue, magenta: currentTheme.Magenta, cyan: currentTheme.Cyan, white: currentTheme.White, brightBlack: currentTheme.BrightBlack, brightRed: currentTheme.BrightRed, brightGreen: currentTheme.BrightGreen, brightYellow: currentTheme.BrightYellow, brightBlue: currentTheme.BrightBlue, brightMagenta: currentTheme.BrightMagenta, brightCyan: currentTheme.BrightCyan, brightWhite: currentTheme.BrightWhite }, fontSize: parseInt(document.getElementById('fontsize-input').value) || 14, fontFamily: getFullFontStack(document.getElementById('font-input').value), scrollback: parseInt(document.getElementById('scrollback-input').value) || 100000, convertEol: false }); fitAddon = new FitAddon.FitAddon(); term.loadAddon(fitAddon); term.open(termContainer); timeGutter = new TimeGutter(timeGutterEl); timeGutter.bindTerminal(term); updateGutterVisibility(); term.onSelectionChange(() => { if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(err => {}); }); term.onData(data => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: data })); }); new ResizeObserver(() => { if (term && fitAddon && shellEnabled && termContainer.offsetWidth > 0) { try { fitAddon.fit(); } catch(e) {} } }).observe(termContainer); setTimeout(() => { if(term && fitAddon) fitAddon.fit(); if (document.activeElement === document.body || document.activeElement === null || document.activeElement.tagName === 'DIV') term.focus(); }, 200); }

// ================== PROCESSING PIPELINE ==================
function escapeHtml(text) { return text.replace(/[&<>"]/g, function(tag) { const chars = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }; return chars[tag] || tag; }); }
function ansiToHtml(text) { const ansiRegex = /\x1b\[([0-9;]*)m/g; let match; let lastIndex = 0; let html = ''; const openTags = []; const colors = [ '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff' ]; while ((match = ansiRegex.exec(text)) !== null) { html += text.substring(lastIndex, match.index); lastIndex = match.index + match[0].length; const codes = match[1].split(';').map(Number).filter(n => !isNaN(n)); if (codes.length === 0) { while(openTags.length) { html += '</span>'; openTags.pop(); } continue; } let style = ''; for(let i = 0; i < codes.length; i++) { const code = codes[i]; if (code === 0) { style = ''; while(openTags.length) { html += '</span>'; openTags.pop(); } } else if (code === 1) { style += 'font-weight:bold;'; } else if (code >= 30 && code <= 37) { style += `color:${colors[code-30]};`; } else if (code >= 90 && code <= 97) { style += `color:${colors[code-90+8]};`; } else if (code === 38) { if (codes[i+1] === 5) { const c = codes[i+2]; if (c < 16) style += `color:${colors[c]};`; i += 2; } else if (codes[i+1] === 2) { style += `color:rgb(${codes[i+2]},${codes[i+3]},${codes[i+4]});`; i += 4; } } } if (style) { html += `<span style="${style}">`; openTags.push(true); } } html += text.substring(lastIndex); while(openTags.length) { html += '</span>'; openTags.pop(); } return html; }
function applyHighlightRaw(text) {
    if (!combinedHighlightRegex) return text;
    // String.replace with a /g/ regex resets lastIndex itself — no need to
    // clone the regex per line (that was a per-line compile cost).
    return text.replace(combinedHighlightRegex, function(match, ...groups) {
        for (let i = 0; i < highlightColorMap.length; i++) {
            if (groups[i] !== undefined) {
                return `\x00HL${highlightColorMap[i]}\x00${match}\x00HLEND\x00`;
            }
        }
        return match;
    });
}

function applyShellHighlight(text) { if (!combinedHighlightRegex) return text; return text.replace(combinedHighlightRegex, function(match, ...groups) { for (let i = 0; i < highlightColorMap.length; i++) { if (groups[i] !== undefined) { return hexToAnsi(highlightColorMap[i]) + match + '\x1b[0m'; } } return match; }); }

/**
 * @brief Processes a raw log line through the rendering pipeline:
 *        1. Apply highlight rules on raw text (sentinel markers)
 *        2. HTML-escape + ANSI-to-HTML conversion
 *        3. Replace sentinel markers with actual HTML span tags
 *        This order ensures highlight patterns containing HTML-special
 *        characters (e.g. >>>, <<<) are matched before escaping.
 */
function cleanTraditionalLine(text) {
    // Traditional mode shows plain text: strip ANSI CSI/OSC sequences and
    // control characters (BEL/BS/other C0) so they never appear as glyphs.
    return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
               .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
               .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
function processLogLine(text) {
    let line = applyHighlightRaw(text);
    line = ansiToHtml(escapeHtml(line));
    line = line.replace(/\x00HL([^\x00]*)\x00([^\x00]*?)\x00HLEND\x00/g,
        '<span style="color:$1;font-weight:bold;">$2</span>');
    return line;
}
function hexToAnsi(hex) { const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); if (!result) return ''; const r = parseInt(result[1], 16); const g = parseInt(result[2], 16); const b = parseInt(result[3], 16); return `\x1b[1;38;2;${r};${g};${b}m`; }
function updateHighlightRules(lines) { let rules = lines.map(line => { const parts = line.split(':'); if (parts.length < 2) return null; try { return { regexStr: parts[0], color: parts.slice(1).join(':') }; } catch (e) { return null; } }).filter(r => r !== null); try { const regexParts = rules.map(r => `(${r.regexStr})`); highlightColorMap = rules.map(r => r.color); if (regexParts.length > 0) { combinedHighlightRegex = new RegExp(regexParts.join('|'), 'gi'); } else { combinedHighlightRegex = null; } } catch (e) { combinedHighlightRegex = null; } }
function addToHistory(command) { if (!command || command.trim() === '' || shellEnabled) return; command = command.trim(); if (historyList.length > 0 && historyList[historyList.length - 1] === command) return; historyList.push(command); if (historyList.length > 100) historyList.shift(); historyIndex = historyList.length; }
function navigateHistory(direction) { if (historyList.length === 0 || shellEnabled) return; historyIndex = Math.max(0, Math.min(historyList.length - 1, historyIndex + direction)); document.getElementById('input').value = historyList[historyIndex]; }
function sendData() { if (shellEnabled) return; const input = document.getElementById('input'); let data = input.value; if (data === '') return; const suffixSelect = document.getElementById('suffix-select'); if (suffixSelect) { const suffixVal = suffixSelect.value; if (suffixVal === '\\n') { data += '\n'; } else if (suffixVal === '\\r\\n') { data += '\r\n'; } } const formData = new FormData(); formData.append('data', data); noteEcho(data); fetch('/send', { method: 'POST', body: formData }).then(r => r.json()).then(res => { if (res.status === 'ok') { addToHistory(input.value); input.value = ''; historyIndex = historyList.length; } else { toast('Send failed: ' + res.message, 'error'); } }); }
function handleInputKeydown(event) { if (event.key === 'Tab') { if (!shellEnabled) { event.preventDefault(); const formData = new FormData(); formData.append('data', '\t'); fetch('/send', { method: 'POST', body: formData }); } return; } if (shellEnabled) return; if (event.key === 'Enter') { event.preventDefault(); sendData(); } else if (event.key === 'ArrowUp') { event.preventDefault(); navigateHistory(-1); } else if (event.key === 'ArrowDown') { event.preventDefault(); navigateHistory(1); } }
function exportLog() {
    // Zero main-thread cost: the backend streams/copies the session log file.
    // We go straight to the path-input dialog so the backend gets a full path.
    const defaultName = `serial_log_${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    showExportDialogFallback(null, defaultName);
}
function rerenderAllOutput() { vsWindowFirst = -1; vsScheduleRender(); }
function clearOutput(sendClear = true) {
    // Undo window: snapshot the raw-mode buffer before clearing; show an
    // "undo" strip for 5s. Shell mode clears xterm's buffer (no undo — the
    // data stays in the session log file anyway).
    if (!shellEnabled && sendClear && outputMessages.length > 0) {
        const snap = outputMessages.slice();
        const snapOffset = outputTrimOffset;
        showUndoBar(snap.length, () => {
            outputMessages = snap; outputTrimOffset = snapOffset;
            pendingMessages = []; vsWindowFirst = -1; vsNeedsInit = true;
            updateGlobalLineNumWidth(outputMessages.length + outputTrimOffset);
            vsScheduleRender();
        });
    }
    if (sendClear) fetch('/clear', { method: 'POST' });
    if (shellEnabled && term) { /* reset() is O(1); clear() is O(scrollback) — 5s at 100k lines */ term.reset(); if (timeGutter) timeGutter.reset(); } else { pendingMessages = []; outputMessages = []; outputTrimOffset = 0; vsWindowFirst = -1; vsNeedsInit = true; vsAutoScroll = true; vsScheduleRender(); } _lastGlobalLineNumWidth = 0; filterOutput.innerHTML = ''; }
// Undo strip shown right after a raw-mode Clear. One offer per clear.
function showUndoBar(n, undoFn) {
    const old = document.getElementById('undo-bar'); if (old) old.remove();
    const bar = document.createElement('div');
    bar.id = 'undo-bar';
    bar.innerHTML = `Cleared ${n} lines <button id="undo-btn">Undo</button>`;
    document.body.appendChild(bar);
    const kill = () => bar.remove();
    const t = setTimeout(kill, 5000);
    bar.querySelector('#undo-btn').addEventListener('click', () => { clearTimeout(t); kill(); undoFn(); });
}
function updateConnectionStatus(connected) { isConnected = connected; const status = document.getElementById('connection-status'); status.textContent = connected ? 'Connected' : 'Disconnected'; status.className = connected ? 'connected' : ''; sbUpdateConnection(connected); }
function updateMode(mode) { currentMode = mode; document.getElementById('ascii-mode').checked = (mode === 'ascii'); document.getElementById('hex-mode').checked = (mode === 'hex'); sbUpdateMode(); }
function updateTimestampStatus(enabled) { timestampEnabled = enabled; document.getElementById('timestamp-on').checked = enabled; document.getElementById('timestamp-off').checked = !enabled; updateGutterVisibility(); }
function updateShellStatus(enabled) { shellEnabled = enabled; document.getElementById('shell-on').checked = enabled; document.getElementById('shell-off').checked = !enabled; }
function showPortSelection(ports) { const modalBody = document.getElementById('modal-body'); if (ports.length === 0) { modalBody.innerHTML = `<p>No available ports.</p>`; return; } modalBody.innerHTML = `<h3>Select Port</h3><div class="port-list"></div>`; const list = modalBody.querySelector('.port-list'); ports.forEach(port => { const btn = document.createElement('button'); btn.className = 'tool-btn'; btn.style.margin = '5px'; btn.textContent = port; btn.onclick = () => { document.getElementById('port-input').value = port; updatePortInfo(port, document.getElementById('baud-input').value); saveConfigSilently(); closeModal(); }; list.appendChild(btn); }); }
function showPortSelectionError(msg) { document.getElementById('modal-body').innerHTML = `<p style="color:red;">Error: ${msg}</p>`; }
function closeModal() { document.getElementById('modal').style.display = 'none'; const mc = document.getElementById('modal-content'); if (mc) mc.classList.remove('wide'); }

async function showExportDialog(content, defaultName) {
    // content === null means: export the backend session log file (zero-copy).
    // Native file picker only gives us a filename (no full path), so backend
    // session export always uses the path-input dialog instead.
    showExportDialogFallback(content, defaultName);
}

function showExportDialogFallback(content, defaultName) {
    const lastDir = localStorage.getItem('exportLogDir') || '';
    const defaultPath = lastDir ? `${lastDir.replace(/[\\/]$/, '')}/${defaultName}` : defaultName;
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
        <h3>Export Log</h3>
        <div style="margin: 15px 0;">
            <label style="display: block; margin-bottom: 5px; font-size: 12px;">Save to:</label>
            <div style="display: flex; gap: 6px;">
                <input type="text" id="export-path-input" value="${escapeHtml(defaultPath)}" style="flex: 1; padding: 6px; box-sizing: border-box; font-family: monospace; font-size: 12px;">
                <button id="export-browse-btn" class="tool-btn" title="Choose folder with native dialog">Browse…</button>
            </div>
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
            <button id="export-cancel-btn" class="tool-btn">Cancel</button>
            <button id="export-save-btn" class="action-btn">Save</button>
        </div>
        <div id="export-msg" style="margin-top: 10px; font-size: 12px;"></div>
    `;
    document.getElementById('modal').style.display = 'block';
    document.getElementById('export-cancel-btn').addEventListener('click', closeModal);
    document.getElementById('export-save-btn').addEventListener('click', () => doExportLog(content));
    document.getElementById('export-browse-btn').addEventListener('click', () => {
        const pathInput = document.getElementById('export-path-input');
        const cur = pathInput.value.trim();
        fetch('/browsesavefile', { method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ defaultName: cur ? cur.replace(/^.*[\\/]/, '') : defaultName }) })
            .then(r => r.json()).then(data => {
                if (data.status === 'error') toast('Browse failed: ' + data.message, 'error');
                else if (data.status === 'ok' && data.path) pathInput.value = data.path;
            }).catch(() => {});
    });
    document.getElementById('export-path-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doExportLog(content); });
    document.getElementById('export-path-input').focus();
    document.getElementById('export-path-input').select();
}

function doExportLog(content) {
    const pathInput = document.getElementById('export-path-input');
    const msgEl = document.getElementById('export-msg');
    const path = pathInput.value.trim();
    if (!path) { msgEl.innerHTML = '<span style="color:var(--danger-color);">Please enter a file path.</span>'; return; }
    const dir = path.replace(/[\\/][^\\/]*$/, '') || '.';
    localStorage.setItem('exportLogDir', dir);
    msgEl.innerHTML = '<span style="color:var(--warning-color);">Saving...</span>';
    if (content === null) {
        // Backend copies the session log file directly — zero main-thread cost.
        fetch('/exportsession', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: path }) })
            .then(r => r.json()).then(data => {
                if (data.status === 'ok') { msgEl.innerHTML = `<span style="color:var(--success-color);">Saved to: ${escapeHtml(data.path)}</span>`; setTimeout(closeModal, 1500); }
                else { msgEl.innerHTML = `<span style="color:var(--danger-color);">Error: ${escapeHtml(data.message)}</span>`; }
            }).catch(err => { msgEl.innerHTML = `<span style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</span>`; });
        return;
    }
    fetch('/exportlog', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({path: path, content: content}) })
        .then(r => r.json()).then(data => {
            if (data.status === 'ok') { msgEl.innerHTML = `<span style="color:var(--success-color);">Saved to: ${escapeHtml(data.path)}</span>`; setTimeout(closeModal, 1500); }
            else { msgEl.innerHTML = `<span style="color:var(--danger-color);">Error: ${escapeHtml(data.message)}</span>`; }
        }).catch(err => { msgEl.innerHTML = `<span style="color:var(--danger-color);">Error: ${escapeHtml(err.message)}</span>`; });
}

// ================= LOG FILE VIEW (SERVER-SIDE CHUNKED LOADING) =================

async function openLogFile(path) {
    const fileName = path.replace(/^.*[\\/]/, '');
    const tabId = createLogTab(fileName);
    const view = new LogFileView(tabId);
    logTabs[tabId] = { view: view, name: fileName };
    await view._openPath(path);
}

class LogFileView {
    constructor(tabId) {
        this.tabId = tabId;
        this.totalLines = 0;
        this.chunkSize = 2000;
        this.loadedChunks = new Set();
        this.nextChunk = 0;
        this.outputEl = null;
        this.scrollTimer = null;
        this.filterMatches = null;
    }

    /**
     * @brief Initializes the output DOM element after totalLines is known.
     */
    _initOutput() {
        this.outputEl = document.getElementById(`${this.tabId}_output`);
        console.log('[Log] _initOutput tabId:', this.tabId, 'outputEl:', this.outputEl, 'totalLines:', this.totalLines);
        if (!this.outputEl) { console.error('[Log] outputEl not found!'); return; }
        this.outputEl.innerHTML = '';
        this.outputEl.style.overflowY = 'auto';
        this.outputEl.addEventListener('scroll', () => this._onScroll());
        _lastGlobalLineNumWidth = 0;
        updateGlobalLineNumWidth(this.totalLines);
        this.nextChunk = 0;
        this.loadedChunks.clear();
        console.log('[Log] calling _loadChunk(0)');
        this._loadChunk(0);
    }

    /**
     * @brief Opens a file by path on the server (kept for future native dialog).
     */
    async _openPath(path) {
        const resp = await fetch('/openlog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tabId: this.tabId, path: path })
        });
        const data = await resp.json();
        if (data.status !== 'ok') { toast('Failed to open log: ' + data.message, 'error'); return; }
        this.totalLines = data.totalLines;
        this._initOutput();
    }

    /**
     * @brief Called on scroll. Loads next chunk when near the bottom.
     */
    _onScroll() {
        if (this.scrollTimer) return;
        this.scrollTimer = setTimeout(() => {
            this.scrollTimer = null;
            if (!this.outputEl) return;
            const distToBottom = this.outputEl.scrollHeight - this.outputEl.scrollTop - this.outputEl.clientHeight;
            if (distToBottom < 500 && this.nextChunk * this.chunkSize < this.totalLines) {
                this._loadChunk(this.nextChunk);
            }
        }, 50);
    }

    /**
     * @brief Loads a single chunk from the server and appends to DOM.
     */
    async _loadChunk(chunkIdx) {
        const start = chunkIdx * this.chunkSize;
        const end = Math.min(start + this.chunkSize, this.totalLines);
        console.log('[Log] _loadChunk', chunkIdx, 'range:', start, '-', end);
        if (start >= end || this.loadedChunks.has(chunkIdx)) return;

        this.loadedChunks.add(chunkIdx);
        if (chunkIdx === this.nextChunk) this.nextChunk = chunkIdx + 1;

        let lines;
        try {
            const resp = await fetch('/readlog', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tabId: this.tabId, start: start, end: end })
            });
            const data = await resp.json();
            console.log('[Log] /readlog response:', data.status, 'lines:', data.lines ? data.lines.length : 0);
            if (data.status !== 'ok') { this.loadedChunks.delete(chunkIdx); return; }
            lines = data.lines.map(l => l.text);
        } catch (e) {
            console.error('[Log] /readlog error:', e);
            this.loadedChunks.delete(chunkIdx);
            return;
        }

        if (!this.outputEl) return;
        const chunkEl = document.createElement('div');
        chunkEl.className = 'log-chunk';
        chunkEl.dataset.chunk = chunkIdx;

        const numWidth = getComputedStyle(document.documentElement).getPropertyValue('--line-num-width').trim();
        let parts = [];
        for (let i = 0; i < lines.length; i++) {
            const lineNum = start + i + 1;
            const body = processLogLine(lines[i]);
            parts.push(`<div class="log-row"><div class="log-row-num" style="width:${numWidth}">${lineNum}</div><div class="log-row-text">${body}</div></div>`);
        }
        chunkEl.innerHTML = parts.join('');
        console.log('[Log] chunk rendered, lines:', lines.length);

        this.outputEl.appendChild(chunkEl);
    }

    /**
     * @brief Searches the file on the server and renders filter results.
     */
    async search(regex) {
        if (!regex) return;
        const pattern = regex.source;
        try {
            const resp = await fetch('/searchlog', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tabId: this.tabId, pattern: pattern })
            });
            const data = await resp.json();
            if (data.status !== 'ok') return;

            this.filterMatches = data.matches || [];
            const filterOutput = document.getElementById(`${this.tabId}_filter_output`);
            if (!filterOutput) return;

            updateGlobalLineNumWidth(this.totalLines);
            const numWidth = getComputedStyle(document.documentElement).getPropertyValue('--line-num-width').trim();
            let parts = [];
            for (const m of this.filterMatches) {
                const lineNum = m.n + 1;
                const body = processFilterLine(m.text, regex);
                parts.push(`<div class="filter-row" data-line-index="${m.n}"><span class="filter-line-num" style="width:${numWidth}">${lineNum}</span><span class="filter-text">${body}</span></div>`);
            }
            filterOutput.innerHTML = parts.join('');
            filterOutput.scrollTop = filterOutput.scrollHeight;
        } catch (e) {}
    }

    /**
     * @brief Jumps to a specific line number.
     */
    async jumpToLine(lineNum) {
        if (!this.outputEl || this.totalLines === 0) return;
        const chunkIdx = Math.floor(lineNum / this.chunkSize);
        if (!this.loadedChunks.has(chunkIdx)) {
            await this._loadChunk(chunkIdx);
        }
        const chunkEl = this.outputEl.querySelector(`.log-chunk[data-chunk="${chunkIdx}"]`);
        if (!chunkEl) return;
        const rowEl = chunkEl.querySelector(`.log-row`);
        if (rowEl) {
            const lineInChunk = lineNum - chunkIdx * this.chunkSize;
            const rows = chunkEl.querySelectorAll('.log-row');
            const target = rows[Math.min(lineInChunk, rows.length - 1)];
            if (target) {
                target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                target.classList.add('flash-highlight');
                setTimeout(() => target.classList.remove('flash-highlight'), 1000);
            }
        }
    }

    /**
     * @brief Cleans up resources.
     */
    destroy() {
        if (this.scrollTimer) clearTimeout(this.scrollTimer);
        if (this.outputEl) {
            this.outputEl.removeEventListener('scroll', this._onScroll);
        }
        fetch('/closelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tabId: this.tabId })
        }).catch(() => {});
    }
}

