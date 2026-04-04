const { ethers }          = require("ethers");
const { EmbedBuilder }    = require("discord.js");
const { getAllSalesConfigs } = require("./store");

const MARKETPLACE = "0x2a0A6fdA20EcBFaD07c62eCbF33e68B205A08776";
const MARKETPLACE_ABI = [
  "event NFTSold(address nftContract, uint256 tokenId, address seller, address buyer, uint256 price)",
];
const NFT_ABI = ["function name() view returns (string)"];
const POLL_INTERVAL = 15 * 1000;

let lastBlock     = null;
let discordClient = null;

const provider = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);
const market   = new ethers.Contract(MARKETPLACE, MARKETPLACE_ABI, provider);
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
    const currentBlock = await provider.getBlockNumber();
    const fromBlock    = lastBlock ? lastBlock + 1 : currentBlock - 50;
    lastBlock = currentBlock;
    if (fromBlock > currentBlock) return;

    const sales = await market.queryFilter(market.filters.NFTSold(), fromBlock, currentBlock);
    for (const e of sales) {
      if (!e.args) { console.warn("[sales] Undecoded log", e.transactionHash); continue; }
      const { nftContract, tokenId, seller, buyer, price } = e.args;
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
    if (err?.error?.code === 429) return;
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