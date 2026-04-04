require("dotenv").config();
const {
  Client, GatewayIntentBits, Events, MessageFlags,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
} = require("discord.js");
const { ethers } = require("ethers");
const {
  init, getServer, setServer, addPending, getTierRole,
  addVerified, getAllServers, getVerifiedWallet,
  setSalesConfig,
} = require("./src/store");
const { startChecker }        = require("./src/checker");
const { startPaymentListener } = require("./src/paymentListener");
const { startSalesListener }   = require("./src/salesListener");

// Shared provider — one connection reused for all RPC calls
const provider = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);

// Balance cache — 60s TTL to reduce RPC calls
const balanceCache = new Map();
const CACHE_TTL = 60 * 1000;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const pendingTierThreshold = new Map();

client.once(Events.ClientReady, async () => {
  await init();
  console.log("Bot online as " + client.user.tag);
  startChecker(client);
  startPaymentListener(client);
  startSalesListener(client);
});

// ── Setup embed ──────────────────────────────────────────────────────────────
function buildSetupEmbed(config) {
  const contract   = config?.contract   || "Not set";
  const collection = config?.collection || "Not set";
  const tierCount  = config?.tiers?.length || 0;
  const channel    = config?.announcementChannel ? "<#" + config.announcementChannel + ">" : "Not set";
  const ready      = config?.contract && config?.collection && tierCount > 0;

  const tierList = tierCount > 0
    ? [...config.tiers]
        .sort((a, b) => a.threshold - b.threshold)
        .map(t => "<@&" + t.roleId + "> " + t.threshold + "+ NFTs")
        .join("\n")
    : "None";

  return new EmbedBuilder()
    .setTitle("Setup Wizard")
    .setDescription(ready
      ? "Ready. Run /panel to post the verification panel."
      : "Configure the bot for this server.")
    .addFields(
      { name: "Collection",            value: collection,              inline: true  },
      { name: "Announcement Channel",  value: channel,                 inline: true  },
      { name: "NFT Contract",          value: "`" + contract + "`",    inline: false },
      { name: "Tiers",                 value: tierList,                inline: false },
    )
    .setColor(ready ? 0x57F287 : 0xFEE75C);
}

function buildSetupRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup_name").setLabel("Collection Name").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("setup_contract").setLabel("NFT Contract").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("setup_channel").setLabel("Announcement Channel").setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("setup_addtier").setLabel("Add Tier").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("setup_cleartiers").setLabel("Clear Tiers").setStyle(ButtonStyle.Danger),
    ),
  ];
}

// ── NFT balance helper (cached 60s) ─────────────────────────────────────────
async function getNFTBalance(wallet, contractAddress) {
  const key = wallet.toLowerCase() + ":" + contractAddress.toLowerCase();
  const cached = balanceCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.balance;

  const contract = new ethers.Contract(
    contractAddress,
    ["function balanceOf(address owner) view returns (uint256)"],
    provider
  );
  const balance = Number(await contract.balanceOf.staticCall(wallet));
  balanceCache.set(key, { balance, ts: Date.now() });
  return balance;
}

// ── Assign all qualifying tier roles ────────────────────────────────────────
async function applyTierRoles(member, guild, tiers, balance) {
  const botMember = guild.members.me;
  const errors = [];

  for (const t of tiers) {
    const role = guild.roles.cache.get(t.roleId);
    if (!role) { errors.push("Role " + t.roleId + " not found"); continue; }

    if (botMember.roles.highest.position <= role.position) {
      errors.push("My role is below **" + role.name + "** — move Tempo Ops above it in server settings");
      continue;
    }

    try {
      if (balance >= t.threshold) {
        if (!member.roles.cache.has(t.roleId)) await member.roles.add(role);
      } else {
        if (member.roles.cache.has(t.roleId)) await member.roles.remove(role);
      }
    } catch (err) {
      errors.push("Could not update **" + role.name + "**: " + err.message);
    }
  }

  return errors;
}

// ── Interactions ─────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // /setup
  if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
    const config = await getServer(interaction.guildId);
    return interaction.reply({
      embeds: [buildSetupEmbed(config)],
      components: buildSetupRow(),
      flags: MessageFlags.Ephemeral,
    });
  }

  // /panel
  if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
    const config = await getServer(interaction.guildId);
    if (!config?.contract || !config?.tiers?.length || !config?.collection) {
      return interaction.reply({
        content: "Setup not complete. Run /setup and set collection name, NFT contract, and at least one tier.",
        flags: MessageFlags.Ephemeral,
      });
    }

    const fee = process.env.VERIFICATION_FEE || "0.02";

    const tierLines = [...config.tiers]
      .sort((a, b) => b.threshold - a.threshold)
      .map(t => "<@&" + t.roleId + "> " + t.threshold + "+ NFTs")
      .join("\n");

    const embed = new EmbedBuilder()
      .setTitle(config.collection + " Holder Verification")
      .setDescription("Verify your wallet to get your holder role.")
      .addFields(
        {
          name: "How it works",
          value: "1. Click Verify\n2. Enter your wallet address\n3. Send " + fee + " pathUSD from that wallet to the address shown\n4. Role assigned automatically",
        },
        { name: "Tiers", value: tierLines },
      )
      .setColor(0x5865F2);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("verify_button").setLabel("Verify").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("status_button").setLabel("My Status").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("recheck_button").setLabel("Update Roles").setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
    await interaction.channel.send({ embeds: [embed], components: [row] });
  }

  // /salessetup
  if (interaction.isChatInputCommand() && interaction.commandName === "salessetup") {
    const salesChannel = interaction.options.getChannel("sales");
    const nftContract  = interaction.options.getString("contract")?.trim() || null;

    if (nftContract && !ethers.isAddress(nftContract)) {
      return interaction.reply({ content: "Invalid contract address.", flags: MessageFlags.Ephemeral });
    }

    await setSalesConfig(
      interaction.guildId,
      null,
      salesChannel?.id || null,
      nftContract
    );

    return interaction.reply({
      content:
        "Sales alerts configured.\n" +
        "Sales channel: " + (salesChannel ? "<#" + salesChannel.id + ">" : "not set") + "\n" +
        "Contract filter: " + (nftContract ? "`" + nftContract + "`" : "all collections"),
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── Buttons ──────────────────────────────────────────────────────────────
  if (interaction.isButton()) {

    // Setup buttons
    if (interaction.customId === "setup_name") {
      const modal = new ModalBuilder().setCustomId("modal_name").setTitle("Collection Name");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("name_input").setLabel("NFT collection name").setPlaceholder("e.g. Tempo Punks").setStyle(TextInputStyle.Short).setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "setup_contract") {
      const modal = new ModalBuilder().setCustomId("modal_contract").setTitle("NFT Contract");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("contract_input").setLabel("NFT contract address on Tempo").setPlaceholder("0x...").setStyle(TextInputStyle.Short).setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "setup_addtier") {
      const modal = new ModalBuilder().setCustomId("modal_tier_threshold").setTitle("Add Tier");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("tier_threshold").setLabel("Minimum NFTs required").setPlaceholder("e.g. 1 or 10 or 50").setStyle(TextInputStyle.Short).setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "setup_cleartiers") {
      await setServer(interaction.guildId, { tiers: [] });
      return interaction.update({
        embeds: [buildSetupEmbed(await getServer(interaction.guildId))],
        components: buildSetupRow(),
      });
    }

    if (interaction.customId === "setup_channel") {
      const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId("announcement_channel_select")
        .setPlaceholder("Pick the channel for verification announcements")
        .addChannelTypes(ChannelType.GuildText)
        .setMinValues(1).setMaxValues(1);
      return interaction.reply({
        content: "Pick the channel where verification announcements will be posted:",
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Panel buttons
    if (interaction.customId === "verify_button") {
      const config   = await getServer(interaction.guildId);
      const existing = await getVerifiedWallet(interaction.guildId, interaction.user.id);

      if (existing) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const balance = await getNFTBalance(existing, config.contract);
          const tier    = getTierRole(config.tiers, balance);
          return interaction.editReply(
            "You are already verified.\n" +
            "Wallet: `" + existing + "`\n" +
            "NFTs held: " + balance + "\n" +
            "Current tier: " + (tier ? "<@&" + tier.roleId + ">" : "None") + "\n\n" +
            "Use **Update Roles** if your tier has changed."
          );
        } catch (err) {
          return interaction.editReply("You are already verified. Use **Update Roles** to refresh your tier.");
        }
      }

      const modal = new ModalBuilder().setCustomId("verify_modal").setTitle("Verify Wallet");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("wallet_input").setLabel("Your Tempo wallet address").setPlaceholder("0x...").setStyle(TextInputStyle.Short).setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "status_button") {
      const config = await getServer(interaction.guildId);
      if (!config) return interaction.reply({ content: "Bot not configured.", flags: MessageFlags.Ephemeral });

      const wallet = await getVerifiedWallet(interaction.guildId, interaction.user.id);
      if (!wallet) {
        return interaction.reply({ content: "You are not verified. Click Verify to get started.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const balance = await getNFTBalance(wallet, config.contract);
        const tier    = getTierRole(config.tiers, balance);
        return interaction.editReply(
          "Wallet: `" + wallet + "`\n" +
          "NFTs held: " + balance + "\n" +
          "Current tier: " + (tier ? "<@&" + tier.roleId + ">" : "None") + "\n" +
          "Wallet is monitored. Roles update automatically."
        );
      } catch (err) {
        return interaction.editReply("Could not reach the chain. Try again in a moment.");
      }
    }

    if (interaction.customId === "recheck_button") {
      const config = await getServer(interaction.guildId);
      if (!config) return interaction.reply({ content: "Bot not configured.", flags: MessageFlags.Ephemeral });

      const wallet = await getVerifiedWallet(interaction.guildId, interaction.user.id);
      if (!wallet) {
        return interaction.reply({ content: "You are not verified. Click Verify first.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const balance    = await getNFTBalance(wallet, config.contract);
        const roleErrors = await applyTierRoles(interaction.member, interaction.guild, config.tiers, balance);
        if (roleErrors.length > 0) {
          return interaction.editReply("Role update issues:\n" + roleErrors.join("\n"));
        }
        return interaction.editReply("Roles updated.\nWallet: `" + wallet + "`\nNFTs held: " + balance);
      } catch (err) {
        console.error("[recheck_button]", err.message);
        return interaction.editReply("Could not reach the chain. Try again in a moment.");
      }
    }
  }

  // ── Select menus ─────────────────────────────────────────────────────────
  if (interaction.isChannelSelectMenu() && interaction.customId === "announcement_channel_select") {
    const channel = interaction.channels.first();
    await setServer(interaction.guildId, { announcementChannel: channel.id });
    return interaction.reply({
      embeds: [buildSetupEmbed(await getServer(interaction.guildId))],
      components: buildSetupRow(),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.isRoleSelectMenu() && interaction.customId === "tier_role_select") {
    const threshold = pendingTierThreshold.get(interaction.user.id);
    if (!threshold) {
      return interaction.reply({ content: "Session expired. Click Add Tier again.", flags: MessageFlags.Ephemeral });
    }

    const roleId = interaction.roles.first().id;
    const config = await getServer(interaction.guildId);
    const tiers  = config?.tiers || [];
    const idx    = tiers.findIndex(t => t.threshold === threshold);
    if (idx >= 0) tiers[idx] = { threshold, roleId };
    else tiers.push({ threshold, roleId });

    await setServer(interaction.guildId, { tiers });
    pendingTierThreshold.delete(interaction.user.id);

    return interaction.reply({
      embeds: [buildSetupEmbed(await getServer(interaction.guildId))],
      components: buildSetupRow(),
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── Modals ────────────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {

    if (interaction.customId === "modal_name") {
      const collection = interaction.fields.getTextInputValue("name_input").trim();
      await setServer(interaction.guildId, { collection });
      return interaction.reply({
        embeds: [buildSetupEmbed(await getServer(interaction.guildId))],
        components: buildSetupRow(),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === "modal_contract") {
      const contract = interaction.fields.getTextInputValue("contract_input").trim();
      if (!ethers.isAddress(contract)) {
        return interaction.reply({ content: "Invalid address.", flags: MessageFlags.Ephemeral });
      }
      await setServer(interaction.guildId, { contract });
      return interaction.reply({
        embeds: [buildSetupEmbed(await getServer(interaction.guildId))],
        components: buildSetupRow(),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === "modal_tier_threshold") {
      const threshold = parseInt(interaction.fields.getTextInputValue("tier_threshold").trim());
      if (isNaN(threshold) || threshold < 1) {
        return interaction.reply({ content: "Threshold must be a number of 1 or more.", flags: MessageFlags.Ephemeral });
      }

      pendingTierThreshold.set(interaction.user.id, threshold);

      const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId("tier_role_select")
        .setPlaceholder("Pick the role for " + threshold + "+ NFTs")
        .setMinValues(1).setMaxValues(1);

      return interaction.reply({
        content: "Now pick the role to assign for " + threshold + "+ NFTs:",
        components: [new ActionRowBuilder().addComponents(roleSelect)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === "verify_modal") {
      const config = await getServer(interaction.guildId);
      if (!config?.contract || !config?.tiers?.length) {
        return interaction.reply({ content: "Bot not configured yet.", flags: MessageFlags.Ephemeral });
      }

      const nftWallet = interaction.fields.getTextInputValue("wallet_input").trim();
      if (!ethers.isAddress(nftWallet)) {
        return interaction.reply({ content: "Invalid wallet address.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const fee = process.env.VERIFICATION_FEE || "0.02";
      await addPending(interaction.user.id, nftWallet, interaction.guildId);

      const paymentMsg =
        "**Payment details**\n" +
        "Amount: **" + fee + " pathUSD**\n\n" +
        "Send to:\n`" + process.env.VAULT_ADDRESS + "`\n\n" +
        "Send **from** this wallet:\n`" + nftWallet + "`\n\n" +
        "You have 15 minutes. Role is assigned automatically once payment confirms.\n" +
        "Already a holder? Click **Update Roles** on the panel to upgrade your tier instantly.";

      await interaction.user.send(paymentMsg).catch(() => {});

      return interaction.editReply(
        "Payment details sent to your DMs.\n\n" +
        "Send **" + fee + " pathUSD** to:\n`" + process.env.VAULT_ADDRESS + "`\n\n" +
        "Send from: `" + nftWallet + "`\n" +
        "You have 15 minutes."
      );
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

process.on("unhandledRejection", (err) => {
  if (err?.code === 10062) return; // Unknown interaction - stale
  if (err?.code === 50006) return; // Empty message - ignore
  console.error("Unhandled error:", err);
});