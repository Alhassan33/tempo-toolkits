const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      guild_id TEXT PRIMARY KEY,
      contract TEXT,
      collection TEXT,
      announcement_channel TEXT,
      tiers JSONB DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS verified (
      guild_id TEXT,
      user_id TEXT,
      wallet TEXT,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS pending (
      nft_wallet TEXT PRIMARY KEY,
      user_id TEXT,
      guild_id TEXT,
      expires_at BIGINT
    );
  `);
  console.log("Database ready");
}

async function getServer(guildId) {
  const res = await pool.query("SELECT * FROM servers WHERE guild_id = $1", [guildId]);
  if (!res.rows[0]) return null;
  const row = res.rows[0];
  return {
    contract: row.contract,
    collection: row.collection,
    announcementChannel: row.announcement_channel,
    tiers: row.tiers || [],
    verified: {},
  };
}

async function setServer(guildId, updates) {
  const current = await getServer(guildId) || {};
  const contract             = updates.contract             ?? current.contract             ?? null;
  const collection           = updates.collection           ?? current.collection           ?? null;
  const announcementChannel  = updates.announcementChannel  ?? current.announcementChannel  ?? null;
  const tiers                = updates.tiers                ?? current.tiers                ?? [];

  await pool.query(`
    INSERT INTO servers (guild_id, contract, collection, announcement_channel, tiers)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (guild_id) DO UPDATE SET
      contract = EXCLUDED.contract,
      collection = EXCLUDED.collection,
      announcement_channel = EXCLUDED.announcement_channel,
      tiers = EXCLUDED.tiers
  `, [guildId, contract, collection, announcementChannel, JSON.stringify(tiers)]);
}

async function addVerified(guildId, userId, wallet) {
  await pool.query(`
    INSERT INTO verified (guild_id, user_id, wallet)
    VALUES ($1,$2,$3)
    ON CONFLICT (guild_id, user_id) DO UPDATE SET wallet = EXCLUDED.wallet
  `, [guildId, userId, wallet]);
}

async function removeVerified(guildId, userId) {
  await pool.query("DELETE FROM verified WHERE guild_id = $1 AND user_id = $2", [guildId, userId]);
}

async function getAllServers() {
  const servers = await pool.query("SELECT * FROM servers");
  const result  = {};

  for (const row of servers.rows) {
    const verifiedRows = await pool.query(
      "SELECT user_id, wallet FROM verified WHERE guild_id = $1", [row.guild_id]
    );
    const verified = {};
    for (const v of verifiedRows.rows) verified[v.user_id] = v.wallet;

    result[row.guild_id] = {
      contract: row.contract,
      collection: row.collection,
      announcementChannel: row.announcement_channel,
      tiers: row.tiers || [],
      verified,
    };
  }
  return result;
}

function getTierRole(tiers, balance) {
  if (!tiers?.length) return null;
  return [...tiers].sort((a, b) => b.threshold - a.threshold).find(t => balance >= t.threshold) || null;
}

async function addPending(userId, nftWallet, guildId) {
  const expiresAt = Date.now() + 15 * 60 * 1000;
  await pool.query(`
    INSERT INTO pending (nft_wallet, user_id, guild_id, expires_at)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (nft_wallet) DO UPDATE SET user_id = EXCLUDED.user_id, guild_id = EXCLUDED.guild_id, expires_at = EXCLUDED.expires_at
  `, [nftWallet.toLowerCase(), userId, guildId, expiresAt]);
}

async function getPendingByWallet(nftWallet) {
  await pool.query("DELETE FROM pending WHERE expires_at < $1", [Date.now()]);
  const res = await pool.query("SELECT * FROM pending WHERE nft_wallet = $1", [nftWallet.toLowerCase()]);
  if (!res.rows[0]) return null;
  return { ...res.rows[0], nftWallet: res.rows[0].nft_wallet };
}

async function deletePending(nftWallet) {
  await pool.query("DELETE FROM pending WHERE nft_wallet = $1", [nftWallet.toLowerCase()]);
}

async function getAllPending() {
  await pool.query("DELETE FROM pending WHERE expires_at < $1", [Date.now()]);
  const res = await pool.query("SELECT * FROM pending");
  const result = {};
  for (const row of res.rows) result[row.nft_wallet] = row;
  return result;
}

async function getVerifiedWallet(guildId, userId) {
  const res = await pool.query(
    "SELECT wallet FROM verified WHERE guild_id = $1 AND user_id = $2",
    [guildId, userId]
  );
  return res.rows[0]?.wallet || null;
}

module.exports = {
  init, getServer, setServer, addVerified, removeVerified, getAllServers,
  getTierRole, addPending, getPendingByWallet, deletePending, getAllPending, getVerifiedWallet,
};