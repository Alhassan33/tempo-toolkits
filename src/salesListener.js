const { ethers }          = require("ethers");
const { EmbedBuilder }    = require("discord.js");
const { getAllSalesConfigs } = require("./store");

const MARKETPLACE = "0x2a0A6fdA20EcBFaD07c62eCbF33e68B205A08776";
const MARKETPLACE_ABI = [
  "event NFTSold(address nftContract, uint256 tokenId, address seller, address buyer, uint256 price)",
];
const NFT_ABI = ["function name() view returns (string)"];
const POLL_INTERVAL = 15 * 1000;
const BLOCK_LAG = 2;

let lastBlock     = null;
let discordClient = null;

const provider  = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);
const market    = new ethers.Contract(MARKETPLACE, MARKETPLACE_ABI, provider);
const iface     = new ethers.Interface(MARKETPLACE_ABI);
const nameCache = new Map();

const EXPECTED_TOPIC = iface.getEvent("NFTSold").topicHash;
console.log("[sales] Watching for topic:", EXPECTED_TOPIC);

async function getNFTName(nftContract) {
  if (nameCache.has(nftContract)) return nameCache.get(nftContract);
  try {
    const c    = new ethers.Contract(nftContract, NFT_ABI, provider);
    const name = await c.name();
    nameCache.set(nftContract, name);
    return name;
  } catch {
    return "Unknown Collection";
  }
}

function formatPrice(price) {
  return (Number(price) / 1_000_000).toFixed(2) + " pathUSD";
}

function shortAddr(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

async function broadcast(embed, nftContract) {
  const configs = await getAllSalesConfigs();
  for (const config of configs) {
    if (config.nft_contract && config.nft_contract.toLowerCase() !== nftContract.toLowerCase()) continue;
    const channelId = config.sales_channel_id;
    if (!channelId) continue;
    const guild   = discordClient.guilds.cache.get(config.guild_id);
    if (!guild) continue;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) continue;
    channel.send({ embeds: [embed] }).catch(() => {});
  }
}

async function poll() {
  try {
    const headBlock  = await provider.getBlockNumber();
    const safeBlock  = headBlock - BLOCK_LAG;
    const fromBlock  = lastBlock ? lastBlock + 1 : safeBlock - 50;

    if (fromBlock > safeBlock) return;
    lastBlock = safeBlock;

    // Fetch ALL logs from the marketplace — no topic filter — so we can see
    // exactly what the contract is emitting and find the real event signature.
    const logs = await provider.getLogs({
      address:   MARKETPLACE,
      fromBlock,
      toBlock:   safeBlock,
    });

    for (const log of logs) {
      const actualTopic = log.topics[0];

      if (actualTopic !== EXPECTED_TOPIC) {
        // Log the real topic so we can update the ABI to match
        console.log("[sales] Unknown topic from marketplace:", actualTopic);
        continue;
      }

      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch (e) {
        console.log("[sales] Topic matched but parse failed:", e.message);
        continue;
      }

      if (!parsed?.args) continue;

      const { nftContract, tokenId, seller, buyer, price } = parsed.args;
      const name = await getNFTName(nftContract);
      console.log("[sales] Sold: " + name + " #" + tokenId + " for " + formatPrice(price));

      const embed = new EmbedBuilder()
        .setTitle(name + " #" + tokenId.toString() + " sold")
        .addFields(
          { name: "Price",  value: formatPrice(price), inline: true },
          { name: "Seller", value: shortAddr(seller),  inline: true },
          { name: "Buyer",  value: shortAddr(buyer),   inline: true },
        )
        .setColor(0x10b981)
        .setURL("https://www.stablewhel.xyz/collection/4217/" + nftContract)
        .setFooter({ text: "Whelmart · Tempo Chain" });

      await broadcast(embed, nftContract);
    }
  } catch (err) {
    if (err?.error?.code === 429 || err?.error?.code === -32602) return;
    console.error("[sales] Poll error: " + err.message);
  }
}

function startSalesListener(client) {
  discordClient = client;
  setInterval(poll, POLL_INTERVAL);
  poll();
  console.log("Sales listener started");
}

module.exports = { startSalesListener };