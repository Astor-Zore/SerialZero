-- example.lua

function main()
    log("🚀 Script started! Waiting for data...")

    -- 发送 AT 指令
    send("AT\r\n")

    -- 等待 OK，超时时间 3000 毫秒
    local success = wait("OK", 3000)


    if success then
        log("✅ Received OK from device!")
        delay(1000)
        log("🔄 Sending AT+GMR...")
        send("AT+GMR\r\n")

        -- 等待任意包含 OK 或 ERROR 的响应
        local res = wait("AT", 5000)
        if not res then
            log("⚠️ Timeout waiting for GMR response, but continuing.")
        end
    else

        log("❌ Timeout! Device did not respond with AT.")
    end

    log("🏁 Script execution finished.")
end

