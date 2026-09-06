const fs = require('fs');
const path = require('path');
const {
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

const PANELS_FILE = path.join(__dirname, 'roles.json');
const eph = { flags: MessageFlags.Ephemeral };
const MAX_TEAMS = 20; // 4 rows of join buttons + 1 row for Leave Team

// ── Storage: one panel per guild, keyed by guild ID ──────────────
function readPanels() {
  try {
    return JSON.parse(fs.readFileSync(PANELS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writePanels(data) {
  fs.writeFileSync(PANELS_FILE, JSON.stringify(data, null, 2) + '\n');
}
function getPanel(guildId) {
  return readPanels()[guildId] || null;
}
function savePanel(guildId, panel) {
  const all = readPanels();
  all[guildId] = panel;
  writePanels(all);
}

// ── Slash command definitions ────────────────────────────────────
const commands = [
  {
    name: 'roleadd',
    description: 'Add a team to the Join a Team panel (run once per team)',
    options: [
      { name: 'role', description: 'The role for this team', type: 8, required: true },
    ],
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
  },
  {
    name: 'roleaddmodify',
    description: 'Edit the Join a Team panel (titles, teams, order)',
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
  },
  {
    name: 'roledisplay',
    description: 'Re-post the panel in its channel (fix a deleted or buried panel)',
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
  },
  {
    name: 'rolemove',
    description: 'Move the panel to the current channel',
    default_member_permissions: String(PermissionFlagsBits.ManageRoles),
  },
];

async function registerCommands(client) {
  for (const [, guild] of client.guilds.cache) {
    try {
      await guild.commands.set(commands);
    } catch (err) {
      console.error(`role command register failed in ${guild.name}:`, err.message);
    }
  }
}

// ── Panel rendering ───────────────────────────────────────────────
function buildPanelMessage(panel) {
  const embed = new EmbedBuilder()
    .setTitle(panel.title || 'Join a Team!')
    .setColor(0x5865f2)
    .setDescription(
      panel.roles.length
        ? panel.roles
            .map((r) => `**${r.subtitle}**\n${r.description}`)
            .join('\n\n────────────────────\n\n')
        : '_No teams yet. Use /roleadd._'
    );

  const rows = [];
  let row = new ActionRowBuilder();
  for (const r of panel.roles) {
    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`team_join:${r.roleId}`)
        .setLabel(r.button.slice(0, 80))
        .setStyle(ButtonStyle.Success)
    );
  }
  if (row.components.length) rows.push(row);

  if (panel.roles.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('team_leave')
          .setLabel('Leave Team')
          .setStyle(ButtonStyle.Danger)
      )
    );
  }

  return { embeds: [embed], components: rows };
}

async function renderPanel(client, guildId) {
  const panel = getPanel(guildId);
  if (!panel) return;

  const channel = await client.channels.fetch(panel.channelId).catch(() => null);
  if (!channel) return;

  const payload = buildPanelMessage(panel);
  let msg = panel.messageId
    ? await channel.messages.fetch(panel.messageId).catch(() => null)
    : null;

  if (msg) {
    await msg.edit(payload);
  } else {
    const sent = await channel.send(payload);
    panel.messageId = sent.id;
    savePanel(guildId, panel);
  }
}

// ── Display / move panel ──────────────────────────────────────────
async function repostPanel(client, guildId, targetChannelId) {
  const panel = getPanel(guildId);
  if (!panel) return false;

  // Remove the old panel message if it still exists.
  if (panel.messageId) {
    const oldCh = await client.channels.fetch(panel.channelId).catch(() => null);
    if (oldCh) {
      const oldMsg = await oldCh.messages.fetch(panel.messageId).catch(() => null);
      if (oldMsg) await oldMsg.delete().catch(() => {});
    }
  }

  panel.channelId = targetChannelId;
  panel.messageId = null;
  savePanel(guildId, panel);
  await renderPanel(client, guildId);
  return true;
}

async function handleDisplay(interaction) {
  const panel = getPanel(interaction.guildId);
  if (!panel || !panel.roles.length) {
    return interaction.reply({ content: 'No team panel exists yet — use /roleadd first.', ...eph });
  }
  // Re-post in the panel's existing home channel.
  await repostPanel(interaction.client, interaction.guildId, panel.channelId);
  return interaction.reply({ content: `Panel re-posted in <#${panel.channelId}>.`, ...eph });
}

async function handleMove(interaction) {
  const panel = getPanel(interaction.guildId);
  if (!panel || !panel.roles.length) {
    return interaction.reply({ content: 'No team panel exists yet — use /roleadd first.', ...eph });
  }
  await repostPanel(interaction.client, interaction.guildId, interaction.channelId);
  return interaction.reply({ content: `Panel moved to <#${interaction.channelId}>.`, ...eph });
}

// ── /roleadd ──────────────────────────────────────────────────────
async function handleRoleAdd(interaction) {
  const role = interaction.options.getRole('role');
  const me = interaction.guild.members.me;

  if (role.managed || role.id === interaction.guild.id) {
    return interaction.reply({ content: "That role can't be self-assigned.", ...eph });
  }
  if (me && role.position >= me.roles.highest.position) {
    return interaction.reply({
      content: `I can't assign **${role.name}** — my role must sit above it in Server Settings → Roles.`,
      ...eph,
    });
  }

  const existing = getPanel(interaction.guildId);
  const already = existing?.roles.find((r) => r.roleId === role.id);
  if (!already && existing && existing.roles.length >= MAX_TEAMS) {
    return interaction.reply({ content: `This panel is full (${MAX_TEAMS} teams max).`, ...eph });
  }

  const modal = new ModalBuilder()
    .setCustomId(`roleadd_modal:${role.id}`)
    .setTitle(`Add ${role.name}`.slice(0, 45));

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('subtitle')
        .setLabel('Team subtitle (heading)')
        .setStyle(TextInputStyle.Short)
        .setValue(already?.subtitle || role.name)
        .setMaxLength(100)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Team description')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(already?.description || '')
        .setMaxLength(500)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('button')
        .setLabel('Join button label')
        .setStyle(TextInputStyle.Short)
        .setValue(already?.button || `Join ${role.name}`)
        .setMaxLength(80)
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

async function handleAddModal(interaction) {
  const roleId = interaction.customId.split(':')[1];
  const entry = {
    roleId,
    subtitle: interaction.fields.getTextInputValue('subtitle').trim(),
    description: interaction.fields.getTextInputValue('description').trim(),
    button: interaction.fields.getTextInputValue('button').trim(),
  };

  let panel = getPanel(interaction.guildId);
  if (!panel) {
    panel = { channelId: interaction.channelId, messageId: null, title: 'Join a Team!', roles: [] };
  }

  const idx = panel.roles.findIndex((r) => r.roleId === roleId);
  if (idx === -1) panel.roles.push(entry);
  else panel.roles[idx] = entry;

  savePanel(interaction.guildId, panel);
  await renderPanel(interaction.client, interaction.guildId);
  await interaction.reply({
    content: `Saved **${entry.subtitle}**. Run /roleadd again to add another team.`,
    ...eph,
  });
}

// ── Join / Leave buttons ──────────────────────────────────────────
async function handleJoin(interaction) {
  const roleId = interaction.customId.split(':')[1];
  const panel = getPanel(interaction.guildId);
  const info = panel?.roles.find((r) => r.roleId === roleId);
  const name = info?.subtitle || interaction.guild.roles.cache.get(roleId)?.name || 'that team';

  if (interaction.member.roles.cache.has(roleId)) {
    return interaction.reply({ content: `You're already in **${name}**.`, ...eph });
  }
  try {
    await interaction.member.roles.add(roleId);
  } catch {
    return interaction.reply({
      content: `I couldn't add that role — check my **Manage Roles** permission and role position.`,
      ...eph,
    });
  }
  await interaction.reply({ content: `✅ Joined **${name}**.`, ...eph });
}

async function handleLeaveButton(interaction) {
  const panel = getPanel(interaction.guildId);
  if (!panel) return interaction.reply({ content: 'No teams configured.', ...eph });

  const held = panel.roles.filter((r) => interaction.member.roles.cache.has(r.roleId));
  if (!held.length) {
    return interaction.reply({ content: "You're not in any teams.", ...eph });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('team_leave_select')
    .setPlaceholder('Which team do you want to leave?')
    .addOptions(held.map((r) => ({ label: r.subtitle.slice(0, 100), value: r.roleId })));

  await interaction.reply({
    content: 'Which team do you want to leave?',
    components: [new ActionRowBuilder().addComponents(select)],
    ...eph,
  });
}

async function handleLeaveSelect(interaction) {
  const roleId = interaction.values[0];
  const panel = getPanel(interaction.guildId);
  const name = panel?.roles.find((r) => r.roleId === roleId)?.subtitle || 'that team';

  try {
    await interaction.member.roles.remove(roleId);
  } catch {
    return interaction.update({ content: `I couldn't remove that role — check my permissions.`, components: [] });
  }
  await interaction.update({ content: `Left **${name}**.`, components: [] });
}

// ── /roleaddmodify editor ─────────────────────────────────────────
function buildModifyUI(panel, selected) {
  const options = panel.roles.map((r) => ({
    label: r.subtitle.slice(0, 100),
    description: `Button: ${r.button}`.slice(0, 100),
    value: r.roleId,
    default: r.roleId === selected,
  }));
  options.push({ label: 'Panel title', description: panel.title, value: '__title__', default: selected === '__title__' });

  const select = new StringSelectMenuBuilder()
    .setCustomId('modify_select')
    .setPlaceholder('Choose what to edit')
    .addOptions(options.slice(0, 25));

  const has = !!selected;
  const isRole = has && selected !== '__title__';
  const sfx = has ? `:${selected}` : '';

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modify_edit${sfx}`).setLabel('Edit').setStyle(ButtonStyle.Primary).setDisabled(!has),
    new ButtonBuilder().setCustomId(`modify_remove${sfx}`).setLabel('Remove').setStyle(ButtonStyle.Danger).setDisabled(!isRole),
    new ButtonBuilder().setCustomId(`modify_up${sfx}`).setLabel('▲ Up').setStyle(ButtonStyle.Secondary).setDisabled(!isRole),
    new ButtonBuilder().setCustomId(`modify_down${sfx}`).setLabel('▼ Down').setStyle(ButtonStyle.Secondary).setDisabled(!isRole)
  );

  return [new ActionRowBuilder().addComponents(select), buttons];
}

async function handleModifyCommand(interaction) {
  const panel = getPanel(interaction.guildId);
  if (!panel || !panel.roles.length) {
    return interaction.reply({ content: 'No team panel exists yet — use /roleadd first.', ...eph });
  }
  await interaction.reply({
    content: 'Pick a team (or the title) to edit:',
    components: buildModifyUI(panel, null),
    ...eph,
  });
}

async function handleModifySelect(interaction) {
  const panel = getPanel(interaction.guildId);
  await interaction.update({
    content: 'Pick a team (or the title) to edit:',
    components: buildModifyUI(panel, interaction.values[0]),
  });
}

async function handleModifyButton(interaction) {
  const [action, value] = interaction.customId.split(':');
  const panel = getPanel(interaction.guildId);
  if (!panel) return;

  if (action === 'modify_edit') {
    if (value === '__title__') {
      const modal = new ModalBuilder().setCustomId('modify_title_modal').setTitle('Edit panel title');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('title')
            .setLabel('Panel title')
            .setStyle(TextInputStyle.Short)
            .setValue(panel.title || 'Join a Team!')
            .setMaxLength(200)
            .setRequired(true)
        )
      );
      return interaction.showModal(modal);
    }
    const r = panel.roles.find((x) => x.roleId === value);
    if (!r) return interaction.reply({ content: 'That team is gone.', ...eph });
    const modal = new ModalBuilder().setCustomId(`modify_role_modal:${value}`).setTitle('Edit team');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('subtitle').setLabel('Team subtitle').setStyle(TextInputStyle.Short).setValue(r.subtitle).setMaxLength(100).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('description').setLabel('Team description').setStyle(TextInputStyle.Paragraph).setValue(r.description).setMaxLength(500).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('button').setLabel('Join button label').setStyle(TextInputStyle.Short).setValue(r.button).setMaxLength(80).setRequired(true)
      )
    );
    return interaction.showModal(modal);
  }

  if (action === 'modify_remove') {
    panel.roles = panel.roles.filter((r) => r.roleId !== value);
    savePanel(interaction.guildId, panel);
    await renderPanel(interaction.client, interaction.guildId);
    return interaction.update({ content: 'Team removed.', components: buildModifyUI(panel, null) });
  }

  if (action === 'modify_up' || action === 'modify_down') {
    const i = panel.roles.findIndex((r) => r.roleId === value);
    const j = action === 'modify_up' ? i - 1 : i + 1;
    if (i !== -1 && j >= 0 && j < panel.roles.length) {
      [panel.roles[i], panel.roles[j]] = [panel.roles[j], panel.roles[i]];
      savePanel(interaction.guildId, panel);
      await renderPanel(interaction.client, interaction.guildId);
    }
    return interaction.update({ content: 'Order updated.', components: buildModifyUI(panel, value) });
  }
}

async function handleModifyModal(interaction) {
  const panel = getPanel(interaction.guildId);
  if (!panel) return interaction.reply({ content: 'Panel is gone.', ...eph });

  if (interaction.customId === 'modify_title_modal') {
    panel.title = interaction.fields.getTextInputValue('title').trim();
  } else {
    const roleId = interaction.customId.split(':')[1];
    const r = panel.roles.find((x) => x.roleId === roleId);
    if (r) {
      r.subtitle = interaction.fields.getTextInputValue('subtitle').trim();
      r.description = interaction.fields.getTextInputValue('description').trim();
      r.button = interaction.fields.getTextInputValue('button').trim();
    }
  }

  savePanel(interaction.guildId, panel);
  await renderPanel(interaction.client, interaction.guildId);
  await interaction.reply({ content: 'Panel updated.', ...eph });
}

// ── Wire up ───────────────────────────────────────────────────────
module.exports = function setupRoles(client) {
  client.once(Events.ClientReady, () => registerCommands(client));
  client.on(Events.GuildCreate, (guild) =>
    guild.commands.set(commands).catch((err) =>
      console.error(`role command register failed in ${guild.name}:`, err.message)
    )
  );

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'roleadd') return await handleRoleAdd(interaction);
        if (interaction.commandName === 'roleaddmodify') return await handleModifyCommand(interaction);
        if (interaction.commandName === 'roledisplay') return await handleDisplay(interaction);
        if (interaction.commandName === 'rolemove') return await handleMove(interaction);
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('roleadd_modal:')) return await handleAddModal(interaction);
        if (interaction.customId.startsWith('modify_role_modal:')) return await handleModifyModal(interaction);
        if (interaction.customId === 'modify_title_modal') return await handleModifyModal(interaction);
        return;
      }
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'team_leave_select') return await handleLeaveSelect(interaction);
        if (interaction.customId === 'modify_select') return await handleModifySelect(interaction);
        return;
      }
      if (interaction.isButton()) {
        if (interaction.customId.startsWith('team_join:')) return await handleJoin(interaction);
        if (interaction.customId === 'team_leave') return await handleLeaveButton(interaction);
        if (interaction.customId.startsWith('modify_')) return await handleModifyButton(interaction);
      }
    } catch (err) {
      console.error('Role interaction error:', err.message);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        interaction.reply({ content: 'Something went wrong.', ...eph }).catch(() => {});
      }
    }
  });
};