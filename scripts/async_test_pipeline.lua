function main()
    send("audio_route status\r\n")
    delay(300)
    -- 1. block pipeline first
    send("audio_route block on\r\n")
    delay(300)
    -- 2. 用 start_async 发 3 次（route_active 一直为 false）
    send("audio_route start_async 1 7\r\n")
    send("audio_route start_async 1 7\r\n")
    send("audio_route start_async 1 7\r\n")
    delay(300)
    -- 3. unblock，pipeline 处理 3 条消息 → ref_count=3
    send("audio_route block off\r\n")
    delay(1000)
    -- 4. stop 一次 → ref_count 3→2 → 泄漏
    send("audio_route sync_stop 1 7\r\n")  -- 或直接 stop
    delay(300)
end
