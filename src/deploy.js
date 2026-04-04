require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Open the bot setup wizard for this server")
    .setDefaultMemberPermissions(0x8),

  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Post the verification panel in this channel")
    .setDefaultMemberPermissions(0x8),
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const useGuild = process.argv.includes("--guild");

(async () => {
  try {
    if (useGuild) {
      if (!process.env.GUILD_ID) {
        console.error("GUILD_ID not set in .env — required for --guild mode");
        process.exit(1);
      }
      console.log("Registering guild commands (instant)...");
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log("Done. Commands live instantly in your server.");
    } else {
      console.log("Registering global commands (up to 1hr to propagate)...");
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands.map(c => c.toJSON()) }
      );
      console.log("Done. Commands live in all servers within 1 hour.");
    }
  } catch (err) {
    console.error("Failed: " + err.message);
  }
})();