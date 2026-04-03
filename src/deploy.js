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
    .setDefaultMemberPermissions(0x8)
    .addStringOption(o => o.setName("collection").setDescription("NFT collection name").setRequired(true)),
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering commands...");
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands.map(c => c.toJSON()),
    });
    console.log("Done! /setup and /panel registered globally.");
  } catch (err) {
    console.error("Failed:", err.message);
  }
})();av