const { ethers } = require("ethers");
const { getAllPending, getPendingByWallet, deletePending, addVerified, getServer, getTierRole } = require("./store");

const POLL_INTERVAL = 5 * 1000;

const TIP20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
];

const NFT_ABI = ["function balanceOf(address owner) view returns (uint256)"];

let lastBlock = null;
let sharedProvider = null;

function getProvider() {
  if (!sharedProvider) {
    sharedProvider = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);
  }
  return sharedProvider;
}
let _provider = null;
function getProvider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);
  return _provider;
}

async function getNFTBalance(walletAddress, contractAddress) {
  const contract = new ethers.Contract(contractAddress, NFT_ABI, getProvider());
  const balance  = await contract.balanceOf.staticCall(walletAddress);
  return Number(balance);
}

async function pollPayments(client) {
  const token = process.env.PAYMENT_TOKEN;
  const vault = process.env.VAULT_ADDRESS;
  if (!token || !vault) { console.error("PAYMENT_TOKEN or VAULT_ADDRESS not set"); return; }

  const provider     = getProvider();
  const currentBlock = await provider.getBlockNumber();
  const fromBlock    = lastBlock ? lastBlock + 1 : currentBlock - 50;

  // Always update lastBlock so we never scan old blocks on restart
  lastBlock = currentBlock;

  const pending = await getAllPending();
  if (Object.keys(pending).length === 0) return;

  try {
    const contract = new ethers.Contract(token, TIP20_ABI, provider);
    const decimals = await contract.decimals();
    const expected = ethers.parseUnits(String(process.env.VERIFICATION_FEE || "0.02"), decimals);

    const events = await contract.queryFilter(
      contract.filters.Transfer(null, vault), fromBlock, currentBlock
    );

    for (const event of events) {
      const { from, value } = event.args;
      if (value < expected) continue;

      const entry = await getPendingByWallet(from);
      if (!entry) continue;

      const config = await getServer(entry.guild_id || entry.guildId);
      if (!config) continue;

      console.log("Payment received from " + from);
      await grantRole(client, entry.guild_id || entry.guildId, entry.user_id || entry.userId, entry.nft_wallet || entry.nftWallet, config);
      await deletePending(from);
    }

  } catch (err) {
    console.error("Poll error: " + err.message);
  }
}

async function grantRole(client, guildId, userId, nftWallet, config) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const balance = await getNFTBalance(nftWallet, config.contract);
    const tier    = getTierRole(config.tiers, balance);

    if (!tier) {
      await member.send(
        "Payment received but " + nftWallet + " does not hold the required NFT. No role assigned."
      ).catch(() => {});
      return;
    }

    const botMember = guild.members.me;
    for (const t of config.tiers) {
      const role = guild.roles.cache.get(t.roleId);
      if (!role) continue;
      if (botMember.roles.highest.position <= role.position) {
        console.error("Role hierarchy issue: move Tempo Ops above " + role.name);
        continue;
      }
      try {
        if (balance >= t.threshold) {
          if (!member.roles.cache.has(t.roleId)) await member.roles.add(role);
        } else {
          if (member.roles.cache.has(t.roleId)) await member.roles.remove(role);
        }
      } catch (err) {
        console.error("Could not update role " + role.name + ": " + err.message);
      }
    }

    await addVerified(guildId, userId, nftWallet);

    const roleName = guild.roles.cache.get(tier.roleId)?.name || "Verified";

    await member.send(
      "Verified. You hold " + balance + " NFTs and have been given the " + roleName + " role in " + guild.name + ".\n" +
      "Your wallet is monitored. Roles update automatically."
    ).catch(() => {});

    const announcementChannel = config.announcementChannel
      ? guild.channels.cache.get(config.announcementChannel)
      : guild.channels.cache.find(c => c.isTextBased() && member.permissionsIn(c).has("ViewChannel"));

    if (announcementChannel) {
      const msg = await announcementChannel.send(
        "<@" + userId + "> has been verified as " + roleName + ". Welcome."
      ).catch(() => null);
      if (msg) setTimeout(() => msg.delete().catch(() => {}), 10000);
    }

    console.log("Granted " + roleName + " to " + userId + " in " + guildId);
  } catch (err) {
    console.error("grantRole error: " + err.message);
  }
}

function startPaymentListener(client) {
  console.log("Payment listener started");
  setInterval(() => pollPayments(client), POLL_INTERVAL);
}

module.exports = { startPaymentListener };