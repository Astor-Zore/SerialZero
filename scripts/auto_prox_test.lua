function main()
    log("🔍 Script started: Sending prox trigger unwear/wear 100 times...")

    local loop_count = 300
    local interval = 1000  -- 1 second (milliseconds)

    for i = 1, loop_count do
        log(string.format("🔄 Loop %d/%d: Sending 'prox trigger unwear'...", i, loop_count))
        send("prox trigger unwear\r\n")
        delay(interval)

        log(string.format("🔄 Loop %d/%d: Sending 'prox trigger wear'...", i, loop_count))
        send("prox trigger wear\r\n")
        delay(interval)  -- 等待1秒后再进入下一次循环（最后一次可省略）
    end

    log("✅ Command sent successfully.")
    log("🏁 Script finished.")
end
