const { ethers }          = require("ethers");
const { EmbedBuilder }    = require("discord.js");
const { getAllSalesConfigs } = require("./store");

const MARKETPLACE = "0x2a0A6fdA20EcBFaD07c62eCbF33e68B205A08776";
const MARKETPLACE_ABI = [
  "event NFTSold(address nftContract, uint256 tokenId, address seller, address buyer, uint256 price)",
];
const NFT_ABI = ["function name() view returns (string)"];
const POLL_INTERVAL = 15 * 1000;

// Use a lag of 2 blocks so the node has fully indexed before we query
const BLOCK_LAG = 2;

let lastBlock     = null;
let discordClient = null;

const provider  = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);
const market    = new ethers.Contract(MARKETPLACE, MARKETPLACE_ABI, provider);
const iface     = new ethers.Interface(MARKETPLACE_ABI);
const nameCache = new Map();

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
    // Stay BLOCK_LAG blocks behind the head so the node has fully indexed them
    const safeBlock  = headBlock - BLOCK_LAG;
    const fromBlock  = lastBlock ? lastBlock + 1 : safeBlock - 50;

    if (fromBlock > safeBlock) return;   // nothing new yet

    lastBlock = safeBlock;               // commit only up to what we queried

    const logs = await provider.getLogs({
      address:   MARKETPLACE,
      topics:    [iface.getEvent("NFTSold").topicHash],
      fromBlock,
      toBlock:   safeBlock,
    });

    for (const log of logs) {
      // Try to decode manually — queryFilter fails silently on ABI mismatches;
      // getLogs + parseLog lets us skip non-matching logs cleanly.
      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
        // Log matches the topic hash but doesn't fit the ABI (different event version).
        // Skip silently — no point flooding logs with tx hashes.
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
    // Silence rate-limit and "block range beyond head" RPC errors — next poll will retry
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