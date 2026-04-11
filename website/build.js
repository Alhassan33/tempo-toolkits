const fs = require("fs");

const twitterUrl = process.env.TWITTER_URL || "#";
const discordUrl = process.env.DISCORD_URL || "#";

let html = fs.readFileSync("index.html", "utf8");
html = html.replaceAll("{{TWITTER_URL}}", twitterUrl);
html = html.replaceAll("{{DISCORD_URL}}", discordUrl);

fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/index.html", html);

console.log("Built dist/index.html");
