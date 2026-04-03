require("dotenv").config();
const {
  Client, GatewayIntentBits, Events, MessageFlags,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
} = require("discord.js");
const { ethers } = require("ethers");
const { getServer, setServer, addPending, getTierRole, addVerified, getAllServers } = require("./src/store");
const { startChecker } = require("./src/checker");
const { startPaymentListener } = require("./src/paymentListener");

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

const pendingTierThreshold = new Map();

client.once(Events.ClientReady, () => {
  console.log("Bot online as " + client.user.tag);
  startChecker(client);
  startPaymentListener(client);
});

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
      { name: "Collection", value: collection, inline: true },
      { name: "Announcement Channel", value: channel, inline: true },
      { name: "NFT Contract", value: "`" + contract + "`", inline: false },
      { name: "Tiers", value: tierList, inline: false },
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

client.on(Events.InteractionCreate, async (interaction) => {

  if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
    const config = getServer(interaction.guildId);
    return interaction.reply({
      embeds: [buildSetupEmbed(config)],
      components: buildSetupRow(),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "panel") {
    const config = getServer(interaction.guildId);
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
    );

    await interaction.reply({ content: "Panel posted.", flags: MessageFlags.Ephemeral });
    await interaction.channel.send({ embeds: [embed], components: [row] });
  }

  if (interaction.isButton()) {

    if (interaction.customId === "setup_name") {
      const modal = new ModalBuilder().setCustomId("modal_name").setTitle("Collection Name");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("name_input")
          .setLabel("NFT collection name")
          .setPlaceholder("e.g. Tempo Punks")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "setup_contract") {
      const modal = new ModalBuilder().setCustomId("modal_contract").setTitle("NFT Contract");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("contract_input")
          .setLabel("NFT contract address on Tempo")
          .setPlaceholder("0x...")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "setup_addtier") {
      const modal = new ModalBuilder().setCustomId("modal_tier_threshold").setTitle("Add Tier");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("tier_threshold")
          .setLabel("Minimum NFTs required")
          .setPlaceholder("e.g. 1 or 10 or 50")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "setup_cleartiers") {
      setServer(interaction.guildId, { tiers: [] });
      return interaction.update({
        embeds: [buildSetupEmbed(getServer(interaction.guildId))],
        components: buildSetupRow(),
      });
    }

    if (interaction.customId === "setup_channel") {
      const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId("announcement_channel_select")
        .setPlaceholder("Pick the channel for verification announcements")
        .addChannelTypes(ChannelType.GuildText)
        .setMinValues(1)
        .setMaxValues(1);

      return interaction.reply({
        content: "Pick the channel where verification announcements will be posted:",
        components: [new ActionRowBuilder().addComponents(channelSelect)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === "verify_button") {
      const modal = new ModalBuilder().setCustomId("verify_modal").setTitle("Verify Wallet");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("wallet_input")
          .setLabel("Your Tempo wallet address")
          .setPlaceholder("0x...")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ));
      return interaction.showModal(modal);
    }

    if (interaction.customId === "status_button") {
      const config = getServer(interaction.guildId);
      if (!config) {
        return interaction.reply({ content: "Bot not configured for this server.", flags: MessageFlags.Ephemeral });
      }

      const userId = interaction.user.id;
      const wallet = config.verified?.[userId];

      if (!wallet) {
        return interaction.reply({
          content: "You are not verified. Click Verify to get started.",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const provider = new ethers.JsonRpcProvider(process.env.TEMPO_RPC);
        const contract = new ethers.Contract(
          config.contract,
          ["function balanceOf(address owner) view returns (uint256)"],
          provider
        );
        const balance = Number(await contract.balanceOf.staticCall(wallet));
        const tier    = getTierRole(config.tiers, balance);
        const role    = tier ? interaction.guild.roles.cache.get(tier.roleId) : null;

        return interaction.editReply(
          "Wallet: `" + wallet + "`\n" +
          "NFTs held: " + balance + "\n" +
          "Current tier: " + (role ? "<@&" + tier.roleId + ">" : "None") + "\n" +
          "Wallet is monitored. Roles update automatically."
        );
      } catch (err) {
        return interaction.editReply("Could not reach the chain. Try again in a moment.");
      }
    }
  }

  if (interaction.isChannelSelectMenu() && interaction.customId === "announcement_channel_select") {
    const channel = interaction.channels.first();
    setServer(interaction.guildId, { announcementChannel: channel.id });
    return interaction.reply({
      embeds: [buildSetupEmbed(getServer(interaction.guildId))],
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
    const config = getServer(interaction.guildId);
    const tiers  = config?.tiers || [];
    const idx    = tiers.findIndex(t => t.threshold === threshold);
    if (idx >= 0) tiers[idx] = { threshold, roleId };
    else tiers.push({ threshold, roleId });

    setServer(interaction.guildId, { tiers });
    pendingTierThreshold.delete(interaction.user.id);

    return interaction.reply({
      embeds: [buildSetupEmbed(getServer(interaction.guildId))],
      components: buildSetupRow(),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.isModalSubmit()) {

    if (interaction.customId === "modal_name") {
      const collection = interaction.fields.getTextInputValue("name_input").trim();
      setServer(interaction.guildId, { collection });
      return interaction.reply({
        embeds: [buildSetupEmbed(getServer(interaction.guildId))],
        components: buildSetupRow(),
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === "modal_contract") {
      const contract = interaction.fields.getTextInputValue("contract_input").trim();
      if (!ethers.isAddress(contract)) {
        return interaction.reply({ content: "Invalid address.", flags: MessageFlags.Ephemeral });
      }
      setServer(interaction.guildId, { contract });
      return interaction.reply({
        embeds: [buildSetupEmbed(getServer(interaction.guildId))],
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
        .setMinValues(1)
        .setMaxValues(1);

      return interaction.reply({
        content: "Now pick the role to assign for " + threshold + "+ NFTs:",
        components: [new ActionRowBuilder().addComponents(roleSelect)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (interaction.customId === "verify_modal") {
      const config = getServer(interaction.guildId);
      if (!config?.contract || !config?.tiers?.length) {
        return interaction.reply({ content: "Bot not configured yet.", flags: MessageFlags.Ephemeral });
      }

      const nftWallet = interaction.fields.getTextInputValue("wallet_input").trim();
      if (!ethers.isAddress(nftWallet)) {
        return interaction.reply({ content: "Invalid wallet address.", flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const fee = process.env.VERIFICATION_FEE || "0.02";
      addPending(interaction.user.id, nftWallet, interaction.guildId);

      return interaction.editReply(
        "Send " + fee + " pathUSD to:\n```" + process.env.VAULT_ADDRESS + "```" +
        "Send from this wallet: `" + nftWallet + "`\n" +
        "You have 15 minutes. Role assigned automatically once payment is confirmed."
      );
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

process.on("unhandledRejection", (err) => {
  if (err?.code === 10062) return;
  console.error("Unhandled error:", err);
});