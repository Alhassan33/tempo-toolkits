const { getBalance } = require("./checkNFT");
const { getAllServers, getTierRole, removeVerified } = require("./store");

const CHECK_INTERVAL = 60 * 60 * 1000;

async function runCheck(client) {
  console.log("Starting hourly sweep");
  const servers = getAllServers();

  for (const [guildId, config] of Object.entries(servers)) {
    if (!config.verified || !config.contract || !config.tiers?.length) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    for (const [userId, wallet] of Object.entries(config.verified)) {
      try {
        const balance     = await getBalance(wallet, config.contract);
        const member      = await guild.members.fetch(userId).catch(() => null);
        if (!member) { removeVerified(guildId, userId); continue; }

        const correctTier = getTierRole(config.tiers, balance);

        if (!correctTier) {
          for (const tier of config.tiers) {
            const role = guild.roles.cache.get(tier.roleId);
            if (role && member.roles.cache.has(tier.roleId)) {
              await member.roles.remove(role);
            }
          }
          removeVerified(guildId, userId);
          console.log("Removed roles from " + userId + " in " + guildId + " — NFT gone");
        } else {
          for (const tier of config.tiers) {
            const role = guild.roles.cache.get(tier.roleId);
            if (!role) continue;
            if (balance >= tier.threshold) {
              if (!member.roles.cache.has(tier.roleId)) await member.roles.add(role);
            } else {
              if (member.roles.cache.has(tier.roleId)) await member.roles.remove(role);
            }
          }
        }
      } catch (err) {
        console.error("Checker error for " + userId + ": " + err.message);
      }
    }
  }
  console.log("Sweep done");
}

function startChecker(client) {
  runCheck(client);
  setInterval(() => runCheck(client), CHECK_INTERVAL);
}

module.exports = { startChecker };