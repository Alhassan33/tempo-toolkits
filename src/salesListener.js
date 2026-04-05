const { ethers }          = require("ethers");
const { EmbedBuilder }    = require("discord.js");
const { getAllSalesConfigs } = require("./store");

const MARKETPLACE = "0x2a0A6fdA20EcBFaD07c62eCbF33e68B205A08776";
const MARKETPLACE_ABI = [
  "event NFTSold(address indexed nftContract, uint256 indexed tokenId, address seller, address indexed buyer, uint256 price)",
];
const NFT_ABI = [
  "function name() view returns (string)",
  "function tokenURI(uint256 tokenId) view returns (string)",
];
const POLL_INTERVAL = 15 * 1000;
const BLOCK_LAG     = 2;
const EXPLORER      = "https://explore.tempo.xyz";

let lastBlock     = null;
let discordClient = null;

const provider  = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);
const iface     = new ethers.Interface(MARKETPLACE_ABI);
const nameCache = new Map();

const SALE_TOPIC = iface.getEvent("NFTSold").topicHash;

// Dedup — keeps last 500 tx hashes so a bot restart never re-posts a sale
// that was already broadcast in the previous 50-block catch-up window.
const seenTxHashes = new Set();
function markSeen(txHash) {
  seenTxHashes.add(txHash);
  if (seenTxHashes.size > 500) {
    seenTxHashes.delete(seenTxHashes.values().next().value);
  }
}

// Normalize a stored contract address — guards against pasted addresses that
// use the multiplication sign (×) instead of the letter x, or other stray chars.
function normalizeAddress(addr) {
  return "0x" + addr.replace(/^0./, "").replace(/[^0-9a-fA-F]/g, "");
}

// Shorten an address:  0x1234...abcd
function shortAddr(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

// Shorten a tokenId that may be a huge integer (ERC-1155 encoded)
function shortTokenId(tokenId) {
  const s = tokenId.toString();
  return s.length > 16 ? s.slice(0, 6) + "…" + s.slice(-4) : s;
}

function formatPrice(price) {
  return (Number(price) / 1_000_000).toFixed(2) + " pathUSD";
}

// Clickable markdown links for Discord embed fields
function addrLink(addr) {
  return "[" + shortAddr(addr) + "](" + EXPLORER + "/address/" + addr + ")";
}

function txLink(hash) {
  return "[" + shortAddr(hash) + "](" + EXPLORER + "/tx/" + hash + ")";
}

async function getNFTName(nftContract) {
  const key = nftContract + ":name";
  if (nameCache.has(key)) return nameCache.get(key);
  try {
    const c    = new ethers.Contract(nftContract, NFT_ABI, provider);
    const name = await c.name();
    nameCache.set(key, name);
    return name;
  } catch {
    return "Unknown Collection";
  }
}

// Fetch the NFT image URL from on-chain tokenURI → metadata JSON.
// Returns null if anything fails so the embed still sends without an image.
async function getNFTImage(nftContract, tokenId) {
  try {
    const c   = new ethers.Contract(nftContract, NFT_ABI, provider);
    let   uri = await c.tokenURI(tokenId);

    if (uri.startsWith("ipfs://")) {
      uri = "https://ipfs.io/ipfs/" + uri.slice(7);
    }

    if (uri.startsWith("data:application/json;base64,")) {
      const json = JSON.parse(Buffer.from(uri.slice(29), "base64").toString("utf8"));
      let img = json.image || json.image_url || null;
      if (img && img.startsWith("ipfs://")) img = "https://ipfs.io/ipfs/" + img.slice(7);
      return img;
    }

    const res  = await fetch(uri, { signal: AbortSignal.timeout(5000) });
    const meta = await res.json();
    let   img  = meta.image || meta.image_url || null;
    if (img && img.startsWith("ipfs://")) img = "https://ipfs.io/ipfs/" + img.slice(7);
    return img;
  } catch {
    return null;
  }
}

async function broadcast(embed, nftContract) {
  const configs = await getAllSalesConfigs();
  for (const config of configs) {
    if (config.nft_contract) {
      const stored = normalizeAddress(config.nft_contract);
      if (stored.toLowerCase() !== nftContract.toLowerCase()) continue;
    }
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
    const headBlock = await provider.getBlockNumber();
    const safeBlock = headBlock - BLOCK_LAG;
    const fromBlock = lastBlock ? lastBlock + 1 : safeBlock - 50;

    if (fromBlock > safeBlock) return;
    lastBlock = safeBlock;

    const logs = await provider.getLogs({
      address:  MARKETPLACE,
      topics:   [SALE_TOPIC],
      fromBlock,
      toBlock:  safeBlock,
    });

    for (const log of logs) {
      const txHash = log.transactionHash;

      // Skip already-broadcast sales (guards against restart re-posts)
      if (seenTxHashes.has(txHash)) continue;

      let parsed;
      try {
        parsed = iface.parseLog(log);
      } catch {
        continue;
      }
      if (!parsed?.args) continue;

      const { nftContract, tokenId, seller, buyer, price } = parsed.args;

      const [name, imageUrl] = await Promise.all([
        getNFTName(nftContract),
        getNFTImage(nftContract, tokenId),
      ]);

      console.log("[sales] Sold: " + name + " #" + shortTokenId(tokenId) + " for " + formatPrice(price));

      const embed = new EmbedBuilder()
        .setTitle(name + " #" + shortTokenId(tokenId) + " sold")
        .setURL(EXPLORER + "/tx/" + txHash)
        .addFields(
          { name: "Price",  value: formatPrice(price), inline: true },
          { name: "Seller", value: addrLink(seller),   inline: true },
          { name: "Buyer",  value: addrLink(buyer),    inline: true },
          { name: "Tx",     value: txLink(txHash),     inline: false },
        )
        .setColor(0x10b981)
        .setFooter({ text: "Whelmart · Tempo Chain" });

      if (imageUrl) embed.setImage(imageUrl);

      await broadcast(embed, nftContract);
      markSeen(txHash);
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