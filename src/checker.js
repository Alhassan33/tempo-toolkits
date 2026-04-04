const { getBalance } = require("./checkNFT");
const { getAllServers, getTierRole, removeVerified } = require("./store");

const CHECK_INTERVAL = 60 * 60 * 1000;

async function runCheck(client) {
  console.log("Starting hourly sweep");
  const servers = await getAllServers();

  for (const [guildId, config] of Object.entries(servers)) {
    if (!config.verified || !config.contract || !config.tiers?.length) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;

    for (const [userId, wallet] of Object.entries(config.verified)) {
      try {
        const balance     = await getBalance(wallet, config.contract);
        const member      = await guild.members.fetch(userId).catch(() => null);
        if (!member) { await removeVerified(guildId, userId); continue; }

        const correctTier = getTierRole(config.tiers, balance);

        const botMember = guild.members.me;

        if (!correctTier) {
          for (const tier of config.tiers) {
            const role = guild.roles.cache.get(tier.roleId);
            if (!role || botMember.roles.highest.position <= role.position) continue;
            if (member.roles.cache.has(tier.roleId)) await member.roles.remove(role).catch(() => {});
          }
          await removeVerified(guildId, userId);
          console.log("Removed roles from " + userId + " — NFT gone");
        } else {
          for (const tier of config.tiers) {
            const role = guild.roles.cache.get(tier.roleId);
            if (!role) continue;
            if (botMember.roles.highest.position <= role.position) {
              console.error("[checker] Role hierarchy issue: move bot above " + role.name + " in " + guildId);
              continue;
            }
            try {
              if (balance >= tier.threshold) {
                if (!member.roles.cache.has(tier.roleId)) await member.roles.add(role);
              } else {
                if (member.roles.cache.has(tier.roleId)) await member.roles.remove(role);
              }
            } catch (err) {
              console.error("[checker] Could not update role: " + err.message);
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