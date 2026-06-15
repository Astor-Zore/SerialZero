// app.js
let ws;
let historyList = [];
let historyIndex = 0;
let isConnected = false;
let currentMode = 'ascii';
let shellEnabled = true;
let timestampEnabled = true;
let pendingMessages = [];
let updateTimer = null;
let outputMessages = [];
let term = null;
let fitAddon = null;
let xtermLoaded = false;
let userActionLock = false;

// --- 高亮性能优化：合并正则相关 ---
let combinedHighlightRegex = null;
let highlightColorMap = [];

let termContainer = document.getElementById('terminal-container');
let outputContainer = document.getElementById('output-container');
let inputArea = document.getElementById('input-area');

document.addEventListener('DOMContentLoaded', function() {
    try {
        if (typeof Terminal !== 'undefined' && typeof FitAddon !== 'undefined') {
            xtermLoaded = true;
        } else {
            xtermLoaded = false;
            console.error('xterm.js or FitAddon not found!');
        }
    } catch (e) {
        xtermLoaded = false;
    }

    syncShellUI(shellEnabled);
    initWebSocket();
    setupEventListeners();
    setupKeyboardShortcuts();
    loadConfig();
    addConfigChangeListeners();
    setupSmartCopy();
    setupSidebarFocusManagement();
});

function syncShellUI(enabled) {
    if (enabled) {
        outputContainer.style.display = 'none';
        termContainer.style.display = 'flex';
        inputArea.style.display = 'none';
    } else {
        outputContainer.style.display = 'flex';
        termContainer.style.display = 'none';
        inputArea.style.display = 'flex';
    }
}

function initWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws`);
    
    ws.onopen = () => console.log('WebSocket connected');
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            switch(data.type) {
                case 'message':
                    if (shellEnabled) {
                        if (term) {
                            // 【关键修复1】强制替换 \n 为 \r\n，彻底解决设备端缺 \r 导致的不换行错位
                            let msg = data.message.replace(/\r?\n/g, '\r\n');
                            // 【关键修复2】应用前端单次正则高亮
                            term.write(applyShellHighlight(msg));
                        }
                        else addToOutput(data.message);
                    } else {
                        addToOutput(data.message);
                    }
                    break;
                case 'config':
                    if (data.config) updateConfig(data.config);
                    if (data.connected !== undefined) updateConnectionStatus(data.connected);
                    if (data.mode) updateMode(data.mode);
                    break;
                case 'status': console.log('Status:', data.message); break;
                case 'mode': updateMode(data.mode); break;
                case 'clear': clearOutput(false); break;
            }
        } catch (error) { console.error('Parse error:', error); }
    };
    ws.onclose = () => setTimeout(initWebSocket, 1000);
    ws.onerror = (error) => console.error('WS error:', error);
}

function setupSidebarFocusManagement() {
    document.querySelectorAll('#sidebar input, #sidebar select, #sidebar textarea').forEach(el => {
        el.addEventListener('mousedown', function(e) { if (term) term.blur(); });
        el.addEventListener('focus', function() { if (term) term.blur(); });
    });
}

function setupEventListeners() {
    document.getElementById('connect-btn').addEventListener('click', toggleConnection);
    document.getElementById('scan-btn').addEventListener('click', scanPorts);
    document.getElementById('clear-btn').addEventListener('click', () => clearOutput(true));
    document.getElementById('export-btn').addEventListener('click', exportLog);
    document.getElementById('send-btn').addEventListener('click', sendData);
    document.getElementById('save-config-btn').addEventListener('click', saveConfig);
    document.getElementById('input').addEventListener('keydown', handleInputKeydown);

    document.getElementById('toggle-sidebar-btn').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('collapsed');
        setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 250);
    });

    document.getElementById('toggle-input-btn').addEventListener('click', () => {
        inputArea.classList.toggle('collapsed');
    });

    document.getElementById('ascii-mode').addEventListener('change', function() { if (this.checked) setMode(this.value); });
    document.getElementById('hex-mode').addEventListener('change', function() { if (this.checked) setMode(this.value); });
    document.getElementById('timestamp-on').addEventListener('change', function() { if (this.checked) setTimestamp(true); });
    document.getElementById('timestamp-off').addEventListener('change', function() { if (this.checked) setTimestamp(false); });
    
    document.getElementById('shell-on').addEventListener('change', function() { if (this.checked) setShellEnabled(true); });
    document.getElementById('shell-off').addEventListener('change', function() { if (this.checked) setShellEnabled(false); });

    document.querySelector('.close').addEventListener('click', closeModal);
    window.addEventListener('click', (event) => { if (event.target == document.getElementById('modal')) closeModal(); });
}

function setupSmartCopy() {
    const output = document.getElementById('output');
    output.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            const selection = window.getSelection().toString();
            if (selection) { e.preventDefault(); navigator.clipboard.writeText(selection).catch(err => {}); }
        }
    });
}

function addConfigChangeListeners() {
    ['port-input', 'baud-input', 'databits-select', 'stopbits-select', 'parity-select', 'font-input', 'fontsize-input', 'highlight-input'].forEach(id => {
        document.getElementById(id).addEventListener('change', saveConfigSilently);
    });
    document.getElementById('port-input').addEventListener('input', function() { updatePortInfo(this.value, document.getElementById('baud-input').value); });
    document.getElementById('port-input').addEventListener('change', function() { updatePortInfo(this.value, document.getElementById('baud-input').value); });
    document.getElementById('baud-input').addEventListener('change', function() { updatePortInfo(document.getElementById('port-input').value, this.value); });
    document.getElementById('font-input').addEventListener('change', function() { applyFontSettings(this.value, document.getElementById('fontsize-input').value); });
    document.getElementById('fontsize-input').addEventListener('change', function() { applyFontSettings(document.getElementById('font-input').value, this.value); });
    document.getElementById('highlight-input').addEventListener('change', function() {
        updateHighlightRules(this.value.split('\n').map(l => l.trim()).filter(l => l));
        rerenderAllOutput();
    });
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(event) {
        if (event.target.tagName === 'INPUT' && event.target.id !== 'input') return;
        if (event.key === 'F2') { event.preventDefault(); toggleConnection(); }
        else if (event.key === 'F3') { event.preventDefault(); scanPorts(); }
        else if (event.key === 'Escape') { event.preventDefault(); closeModal(); }
    });
}

function toggleConnection() { isConnected ? disconnect() : connect(); }

function connect() {
    fetch('/connect', { method: 'POST' }).then(r => r.json()).then(data => {
        if (data.status === 'connected') { isConnected = true; updateConnectionStatus(true); }
        else { alert('Connection failed: ' + data.message); }
    });
}

function disconnect() {
    fetch('/disconnect', { method: 'POST' }).then(r => r.json()).then(data => {
        if (data.status === 'disconnected') { isConnected = false; updateConnectionStatus(false); }
    });
}

function scanPorts() {
    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `<h3>Scanning...</h3>`;
    document.getElementById('modal').style.display = 'block';
    fetch('/scan', { method: 'POST' }).then(r => r.json()).then(data => {
        if (data.status === 'ok') showPortSelection(data.ports);
        else showPortSelectionError(data.message);
    }).catch(error => showPortSelectionError(error.message));
}

function setMode(mode) {
    if (shellEnabled) return;
    const formData = new FormData();
    formData.append('mode', mode);
    fetch('/setmode', { method: 'POST', body: formData }).then(r => r.json()).then(data => {
        if (data.status === 'ok') { currentMode = mode; updateMode(mode); }
    });
}

function setTimestamp(enabled) { timestampEnabled = enabled; updateTimestampStatus(enabled); saveConfigSilently(); }

function setShellEnabled(enabled, shouldSave = true) {
    if (shellEnabled === enabled && !(enabled && !term)) return;
    
    userActionLock = true;
    shellEnabled = enabled;
    updateShellStatus(enabled);
    syncShellUI(enabled);
    
    if (enabled) {
        if (!xtermLoaded) {
            syncShellUI(false);
            addToOutput('[System] Shell mode requires xterm.js.');
            shellEnabled = false;
            updateShellStatus(false);
            userActionLock = false;
            return;
        }
        
        if (!term) {
            try { initTerminal(); } catch (e) {
                syncShellUI(false);
                shellEnabled = false;
                updateShellStatus(false);
                addToOutput('[System] Failed to initialize terminal: ' + e.message);
                userActionLock = false;
                return;
            }
        } else { 
            setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 50);
        }
        
        if (outputMessages.length > 0) {
            const plainText = outputMessages.map(msg => {
                const div = document.createElement('div');
                div.innerHTML = msg;
                return div.textContent || div.innerText || '';
            }).join('\r\n');
            
            if (plainText.trim()) {
                term.write('\r\n\x1b[33m--- Previous output transferred ---\x1b[0m\r\n');
                term.write(plainText);
                term.write('\r\n\x1b[33m--- End of transferred output ---\x1b[0m\r\n');
            }
            outputMessages = [];
            pendingMessages = [];
            document.getElementById('output').innerHTML = '';
        }
        
    } else {
        if (term) {
            const buffer = term.buffer.active;
            let shellOutput = '';
            for (let i = 0; i < buffer.length; i++) {
                const line = buffer.getLine(i);
                if (line) shellOutput += line.translateToString(true) + "\n";
            }
            shellOutput = shellOutput.trimEnd().replace(/\x1b\[[0-9;]*m/g, '');
            
            if (shellOutput) {
                addToOutput('<span style="color: #cca700;">--- Shell output transferred ---</span>');
                shellOutput.split('\n').forEach(line => { if (line) addToOutput(line); });
                addToOutput('<span style="color: #cca700;">--- End of transferred output ---</span>');
            }
            term.dispose();
            term = null;
            fitAddon = null;
        }
    }
    
    if (shouldSave) saveConfigSilently();
    setTimeout(() => { userActionLock = false; }, 3000);
}

function initTerminal() {
    term = new Terminal({ 
        cursorBlink: true, 
        theme: { background: '#1e1e1e', foreground: '#cccccc', cursor: '#ffffff' }, 
        fontSize: parseInt(document.getElementById('fontsize-input').value) || 14, 
        fontFamily: document.getElementById('font-input').value || 'Consolas, monospace', 
        scrollback: 10000,
        convertEol: false // 关闭内置的，由上面 ws.onmessage 里手动替换，更彻底
    });
    
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    
    term.open(termContainer);
    
    term.onSelectionChange(() => {
        if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(err => {});
    });

    term.onData(data => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: data }));
        }
    });
    
    new ResizeObserver(() => {
        if (term && fitAddon && shellEnabled && termContainer.offsetWidth > 0) {
            try { fitAddon.fit(); } catch(e) {}
        }
    }).observe(termContainer);
    
    setTimeout(() => {
        if(term && fitAddon) fitAddon.fit();
        if (document.activeElement === document.body || document.activeElement === null || document.activeElement.tagName === 'DIV') {
            term.focus();
        }
    }, 200);
}

// ================= 高性能高亮逻辑 =================

function hexToAnsi(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return '';
    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);
    return `\x1b[1;38;2;${r};${g};${b}m`; // 加粗且着色
}

// 优化：将 N 个正则合并为 1 个大正则，只需遍历文本 1 次
function updateHighlightRules(lines) {
    let rules = lines.map(line => {
        const parts = line.split(':');
        if (parts.length < 2) return null;
        try { return { regexStr: parts[0], color: parts.slice(1).join(':') }; } catch (e) { return null; }
    }).filter(r => r !== null);

    try {
        const regexParts = rules.map(r => `(${r.regexStr})`);
        highlightColorMap = rules.map(r => r.color);
        
        if (regexParts.length > 0) {
            combinedHighlightRegex = new RegExp(regexParts.join('|'), 'gi');
        } else {
            combinedHighlightRegex = null;
        }
    } catch (e) {
        console.error("Failed to combine highlight regex:", e);
        combinedHighlightRegex = null;
    }
}

// Shell 模式高亮：单次替换
function applyShellHighlight(text) {
    if (!combinedHighlightRegex) return text;
    return text.replace(combinedHighlightRegex, function(match, ...groups) {
        for (let i = 0; i < highlightColorMap.length; i++) {
            if (groups[i] !== undefined) {
                return hexToAnsi(highlightColorMap[i]) + match + '\x1b[0m';
            }
        }
        return match;
    });
}

// 普通模式高亮：单次替换
function applyHighlight(text) {
    let result = text.replace(/[&<>"]/g, tag => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[tag] || tag);
    if (combinedHighlightRegex) {
        result = result.replace(combinedHighlightRegex, function(match, ...groups) {
            for (let i = 0; i < highlightColorMap.length; i++) {
                if (groups[i] !== undefined) {
                    return `<span style="color:${highlightColorMap[i]};font-weight:bold;">${match}</span>`;
                }
            }
            return match;
        });
    }
    return result;
}

// ==================================================

function addToHistory(command) {
    if (!command || command.trim() === '' || shellEnabled) return;
    command = command.trim();
    if (historyList.length > 0 && historyList[historyList.length - 1] === command) return;
    historyList.push(command);
    if (historyList.length > 100) historyList.shift();
    historyIndex = historyList.length;
}

function navigateHistory(direction) {
    if (historyList.length === 0 || shellEnabled) return;
    historyIndex = Math.max(0, Math.min(historyList.length - 1, historyIndex + direction));
    document.getElementById('input').value = historyList[historyIndex];
}

function sendData() {
    if (shellEnabled) return;
    const input = document.getElementById('input');
    const data = input.value;
    if (data === '') return;
    const formData = new FormData();
    formData.append('data', data);
    fetch('/send', { method: 'POST', body: formData }).then(r => r.json()).then(res => {
        if (res.status === 'ok') { addToHistory(data); input.value = ''; historyIndex = historyList.length; }
        else { alert('Send failed: ' + res.message); }
    });
}

function handleInputKeydown(event) {
    if (shellEnabled) return;
    if (event.key === 'Enter') { event.preventDefault(); sendData(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); navigateHistory(-1); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); navigateHistory(1); }
}

function exportLog() {
    let content = "";
    if (shellEnabled && term) {
        const buffer = term.buffer.active;
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) content += line.translateToString(true) + "\n";
        }
        content = content.trimEnd();
    } else {
        content = document.getElementById('output').innerText;
    }
    if (!content.trim()) return alert("No data to export.");
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `serial_log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click(); URL.revokeObjectURL(url);
}

function addToOutput(text) {
    outputMessages.push(text);
    pendingMessages.push(text);
    scheduleOutputUpdate();
}

function scheduleOutputUpdate() { if (!updateTimer) updateTimer = setTimeout(flushOutput, 16); }

function flushOutput() {
    updateTimer = null;
    if (pendingMessages.length === 0) return;
    const output = document.getElementById('output');
    const fragment = document.createDocumentFragment();
    const batch = pendingMessages.splice(0, 50);
    batch.forEach(msg => { const div = document.createElement('div'); div.innerHTML = applyHighlight(msg); fragment.appendChild(div); });
    output.appendChild(fragment);
    output.scrollTop = output.scrollHeight;
    if (pendingMessages.length > 0) scheduleOutputUpdate();
}

function rerenderAllOutput() {
    const output = document.getElementById('output');
    output.innerHTML = '';
    outputMessages.forEach(msg => { const div = document.createElement('div'); div.innerHTML = applyHighlight(msg); output.appendChild(div); });
}

function clearOutput(sendClear = true) {
    if (sendClear) fetch('/clear', { method: 'POST' });
    if (shellEnabled && term) term.clear();
    else { document.getElementById('output').innerHTML = ''; pendingMessages = []; outputMessages = []; }
}

function updateConnectionStatus(connected) {
    isConnected = connected;
    const status = document.getElementById('connection-status');
    status.textContent = connected ? 'Connected' : 'Disconnected';
    status.className = connected ? 'connected' : '';
}

function updateMode(mode) { currentMode = mode; document.getElementById('ascii-mode').checked = (mode === 'ascii'); document.getElementById('hex-mode').checked = (mode === 'hex'); }
function updateTimestampStatus(enabled) { timestampEnabled = enabled; document.getElementById('timestamp-on').checked = enabled; document.getElementById('timestamp-off').checked = !enabled; }
function updateShellStatus(enabled) { shellEnabled = enabled; document.getElementById('shell-on').checked = enabled; document.getElementById('shell-off').checked = !enabled; }
function updatePortInfo(port, baud) { document.getElementById('port-info').textContent = `${port} | ${baud}`; }

function applyFontSettings(font, size) {
    const output = document.getElementById('output');
    if (font) { output.style.fontFamily = font; if (term) term.setOption('fontFamily', font); }
    if (size) { output.style.fontSize = size + 'px'; if (term) { term.setOption('fontSize', parseInt(size)); setTimeout(() => { if(term && fitAddon) fitAddon.fit(); }, 50); } }
}

function loadConfig() {
    fetch('/getconfig', { method: 'POST' }).then(r => r.json()).then(data => {
        updateConfig(data.config, true);
        updateConnectionStatus(data.connected);
        updateMode(data.mode);
        if (data.config && data.config.UI) {
            setShellEnabled(data.config.UI.Shell !== undefined ? data.config.UI.Shell : true, false);
        }
    });
}

function updateConfig(config, isInitial = false) {
    if (!config) return;
    if (config.Serial) {
        document.getElementById('port-input').value = config.Serial.Port || 'COM1';
        document.getElementById('baud-input').value = config.Serial.Baud || 9600;
        document.getElementById('databits-select').value = config.Serial.Databits || 8;
        document.getElementById('stopbits-select').value = config.Serial.Stopbits || 1;
        document.getElementById('parity-select').value = config.Serial.Parity || 'N';
        updatePortInfo(config.Serial.Port, config.Serial.Baud);
    }
    if (config.UI) {
        document.getElementById('font-input').value = config.UI.Font || 'Consolas, monospace';
        document.getElementById('fontsize-input').value = config.UI.FontSize || 14;
        applyFontSettings(config.UI.Font, config.UI.FontSize);
        updateTimestampStatus(config.UI.Timestamp !== undefined ? config.UI.Timestamp : true);
        if (!isInitial && !userActionLock) updateShellStatus(config.UI.Shell !== undefined ? config.UI.Shell : true);
    }
    if (config.Highlight && config.Highlight.Groups) {
        const groups = Array.isArray(config.Highlight.Groups) ? config.Highlight.Groups : ["error:#ff0000", "warn:#ffa500"];
        document.getElementById('highlight-input').value = groups.join('\n');
        updateHighlightRules(groups);
    }
}

function saveConfig() {
    fetch('/saveconfig', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(getFormData()) }).then(r => r.json()).then(data => {
        if (data.status === 'ok') alert('Configuration saved');
        else alert('Save failed: ' + data.message);
    });
}

function saveConfigSilently() {
    fetch('/saveconfig', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(getFormData()) });
}

function getFormData() {
    return {
        Serial: { Port: document.getElementById('port-input').value, Baud: parseInt(document.getElementById('baud-input').value), Databits: parseInt(document.getElementById('databits-select').value), Stopbits: parseInt(document.getElementById('stopbits-select').value), Parity: document.getElementById('parity-select').value },
        UI: { Font: document.getElementById('font-input').value, FontSize: parseInt(document.getElementById('fontsize-input').value), Timestamp: timestampEnabled, Shell: shellEnabled },
        Highlight: { Groups: document.getElementById('highlight-input').value.split('\n').map(l=>l.trim()).filter(l=>l) },
        Log: { Path: './logs' }
    };
}

function showPortSelection(ports) {
    const modalBody = document.getElementById('modal-body');
    if (ports.length === 0) { modalBody.innerHTML = `<p>No available ports.</p>`; return; }
    modalBody.innerHTML = `<h3>Select Port</h3><div class="port-list"></div>`;
    const list = modalBody.querySelector('.port-list');
    ports.forEach(port => {
        const btn = document.createElement('button');
        btn.className = 'tool-btn'; btn.style.margin = '5px'; btn.textContent = port;
        btn.onclick = () => { 
            document.getElementById('port-input').value = port; 
            updatePortInfo(port, document.getElementById('baud-input').value); 
            saveConfigSilently();
            closeModal(); 
        };
        list.appendChild(btn);
    });
}

function showPortSelectionError(msg) { document.getElementById('modal-body').innerHTML = `<p style="color:red;">Error: ${msg}</p>`; }
function closeModal() { document.getElementById('modal').style.display = 'none'; }

