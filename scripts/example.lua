-- example.lua

function main()
    log("🚀 Script started! Waiting for data...")

    send("audio_control set_pa_mute both 1\r\n")

    local success = wait("successfully", 3000)


    if success then
        log("✅ Received OK from device!")
        delay(1000)
        log("🔄 Sending AT+GMR...")
        send("AT+GMR\r\n")

        local res = wait("AT", 5000)
        if not res then
            log("⚠️ Timeout waiting for GMR response, but continuing.")
        end
    else

        log("❌ Timeout! Device did not respond with AT.")
    end

    log("🏁 Script execution finished.")
end

