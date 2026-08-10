-- prox_stress_test.lua
-- 接口: send(cmd), log(msg), wait(ms)
-- 用法: 在串口终端 Lua 环境中加载此脚本执行
local rounds = 500
local delay_ms = 500
local function round(n, cmds)
    log("=== ROUND " .. n .. " ===")
    for _, cmd in ipairs(cmds) do
        send(cmd)
        send("\r\n")
        delay(delay_ms)
    end
    -- 每轮检查状态
    send("audio_route status\r\n")
    delay(delay_ms)
end
local patterns = {
    -- 模式1: 快速戴摘
    {"prox trigger wear", "prox trigger unwear"},
    -- 模式2: 戴->状态->摘
    {"prox trigger wear", "audio_route status", "prox trigger unwear"},
    -- 模式3: 双重 wear（测 already_started）
    {"prox trigger wear", "prox trigger wear", "prox trigger unwear"},
    -- 模式4: 双重 unwear（测 already_stopped）
    {"prox trigger unwear", "prox trigger unwear"},
    -- 模式5: 快速 3 次切换
    {"prox trigger wear", "prox trigger unwear",
     "prox trigger wear", "prox trigger unwear"},
}
log("prox stress test start, rounds=" .. rounds)
for i = 1, rounds do
    local p = patterns[(i - 1) % #patterns + 1]
    round(i, p)
    delay(delay_ms * 3)
end
log("prox stress test done")
