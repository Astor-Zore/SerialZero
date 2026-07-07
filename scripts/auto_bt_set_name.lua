function main()
	log("🔍 Script started: Waiting for 'bt_ready' log...")

	local poll_interval = 1000
	local found = false

	-- 循环等待 bt_ready
	while 1 do
		local result = wait("bt_ready", poll_interval)
		if result then
		    found = true
		    log("✅ 'bt_ready' detected!")
		    break
		end
	end


	delay(500)
	log("📤 Sending 'bt set_name astor_bt'...")
	send("bt set_name astor_bt\r\n")

	log("✅ Command sent successfully.")
	log("🏁 Script finished.")
end
