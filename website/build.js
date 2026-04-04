const fs = require("fs");

const clientId   = process.env.CLIENT_ID;
const twitterUrl = process.env.TWITTER_URL || "#";
const discordUrl = process.env.DISCORD_URL || "#";

if (!clientId) {
  console.error("CLIENT_ID env var not set");
  process.exit(1);
}

const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=8`;

let html = fs.readFileSync("index.html", "utf8");
html = html.replaceAll("{{INVITE_URL}}", inviteUrl);
html = html.replaceAll("{{TWITTER_URL}}", twitterUrl);
html = html.replaceAll("{{DISCORD_URL}}", discordUrl);

fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/index.html", html);

console.log("Built dist/index.html");