const fs   = require("fs");
const path = require("path");

const FILE         = path.join(__dirname, "../data/servers.json");
const PENDING_FILE = path.join(__dirname, "../data/pending.json");

function load(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.error("Corrupt data file: " + file + " — resetting");
    return {};
  }
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write to temp file first, then rename — prevents corruption on crash
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function getServer(guildId) {
  return load(FILE)[guildId] || null;
}

function setServer(guildId, updates) {
  const data = load(FILE);
  data[guildId] = { ...data[guildId], ...updates, verified: data[guildId]?.verified || {} };
  save(FILE, data);
}

function addVerified(guildId, userId, wallet) {
  const data = load(FILE);
  if (!data[guildId]) return;
  data[guildId].verified[userId] = wallet;
  save(FILE, data);
}

function removeVerified(guildId, userId) {
  const data = load(FILE);
  if (!data[guildId]) return;
  delete data[guildId].verified[userId];
  save(FILE, data);
}

function getAllServers() {
  return load(FILE);
}

function getTierRole(tiers, balance) {
  if (!tiers?.length) return null;
  return [...tiers]
    .sort((a, b) => b.threshold - a.threshold)
    .find(t => balance >= t.threshold) || null;
}

function addPending(userId, nftWallet, guildId) {
  const data = load(PENDING_FILE);
  data[nftWallet.toLowerCase()] = {
    userId,
    guildId,
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
  save(PENDING_FILE, data);
}

function getPendingByWallet(nftWallet) {
  const data  = load(PENDING_FILE);
  const entry = data[nftWallet.toLowerCase()];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { deletePending(nftWallet); return null; }
  return { ...entry, nftWallet };
}

function deletePending(nftWallet) {
  const data = load(PENDING_FILE);
  delete data[nftWallet.toLowerCase()];
  save(PENDING_FILE, data);
}

function getAllPending() {
  const data  = load(PENDING_FILE);
  const now   = Date.now();
  let changed = false;
  for (const [key, entry] of Object.entries(data)) {
    if (now > entry.expiresAt) { delete data[key]; changed = true; }
  }
  if (changed) save(PENDING_FILE, data);
  return data;
}

module.exports = {
  getServer, setServer, addVerified, removeVerified, getAllServers,
  getTierRole, addPending, getPendingByWallet, deletePending, getAllPending,
};