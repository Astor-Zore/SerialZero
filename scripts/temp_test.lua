function main()
	log("🔍 Temp test.")


	send("audio_policy sync_start 6\r\n")

	delay(2000)


	send("audio_policy status\r\n")

	delay(5000)

	send("audio_policy status\r\n")

	delay(2000)

	send("audio_policy sync_stop 6\r\n")

	log("🏁 Script finished.")
end

