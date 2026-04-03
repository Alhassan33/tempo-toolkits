require("dotenv").config();
const { REST, Routes } = require("discord.js");

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  // Remove all guild-specific commands (old /verify)
  console.log("Clearing old guild commands...");
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: [] }
  );
  console.log("Done — old commands cleared.");
})();