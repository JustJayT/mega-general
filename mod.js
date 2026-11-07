// Moderation across the bridge:
//   /ban <user>           bridge admins only: stop relaying them + delete their bridged messages everywhere
//   /unban <user>         bridge admins only: undo the relay block
//   /bridgeroles ...      server managers: pick which roles here may use "Delete everywhere"
//   Delete everywhere     right-click a message -> Apps: delete it and every copy in every server
//
//   /admin add|remove|list      bridge admins only: manage the admin list
//   /server add|remove|tag|list bridge admins only: manage which channels are bridged
//
// Bridge admins = the bot's owner + user IDs in admins.json (managed with /admin).
// Allowed delete roles per server live in mod-roles.json (managed with /bridgeroles).
const fs = require('fs');
const path = require('path');
const { Events, MessageFlags, PermissionFlagsBits } = require('discord.js');

const ADMINS_FILE = path.join(__dirname, 'admins.json');
const MOD_ROLES_FILE = path.join(__dirname, 'mod-roles.json');
const eph = { flags: MessageFlags.Ephemeral };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// The bot's owner (from the Developer Portal) is always an admin; filled in at startup.
const ownerIds = new Set();

function readAdmins() {
  const list = readJson(ADMINS_FILE, []);
  return Array.isArray(list) ? list.map(String) : [];
}

function writeAdmins(list) {
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(list, null, 2) + '\n');
}

// Read fresh every time so editing admins.json takes effect without a restart.
function isAdmin(userId) {
  return ownerIds.has(userId) || readAdmins().includes(userId);
}

// Permissions the bot needs in a bridged channel, with friendly names.
const NEEDED_PERMS = [
  ['ViewChannel', 'View Channel'],
  ['SendMessages', 'Send Messages'],
  ['ReadMessageHistory', 'Read Message History'],
  ['ManageWebhooks', 'Manage Webhooks'],
  ['ManageMessages', 'Manage Messages'],
  ['AddReactions', 'Add Reactions'],
  ['UseExternalEmojis', 'Use External Emojis'],
  ['AttachFiles', 'Attach Files'],
  ['EmbedLinks', 'Embed Links'],
];

function getModRoles(guildId) {
  return readJson(MOD_ROLES_FILE, {})[guildId] || [];
}

function setModRoles(guildId, roleIds) {
  const all = readJson(MOD_ROLES_FILE, {});
  if (roleIds.length) all[guildId] = roleIds;
  else delete all[guildId];
  fs.writeFileSync(MOD_ROLES_FILE, JSON.stringify(all, null, 2) + '\n');
}

function memberRoleIds(member) {
  if (!member) return [];
  return member.roles?.cache ? [...member.roles.cache.keys()] : member.roles || [];
}

// Allowed if: bridge admin, OR has one of this server's chosen roles.
// If a server hasn't chosen any roles yet, anyone with Manage Messages there may use it.
function canDeleteEverywhere(interaction) {
  if (isAdmin(interaction.user.id)) return true;
  const allowed = getModRoles(interaction.guildId);
  if (!allowed.length) return !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
  return memberRoleIds(interaction.member).some((id) => allowed.includes(id));
}

const commands = [
  {
    name: 'ban',
    description: 'Bridge-ban someone: stop relaying them and delete their bridged messages everywhere',
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
    options: [
      { name: 'user', description: 'Start typing a name, or paste a user ID', type: 3, required: true, autocomplete: true },
      { name: 'reason', description: 'Optional note (shown in the bot log)', type: 3, required: false },
    ],
  },
  {
    name: 'unban',
    description: 'Let a bridge-banned user be relayed again',
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
    options: [
      { name: 'user', description: 'Start typing a name, or paste a user ID', type: 3, required: true, autocomplete: true },
    ],
  },
  {
    name: 'bridgeroles',
    description: 'Choose which roles in this server can use "Delete everywhere"',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      {
        name: 'add',
        description: 'Allow a role to use "Delete everywhere"',
        type: 1,
        options: [{ name: 'role', description: 'The role', type: 8, required: true }],
      },
      {
        name: 'remove',
        description: 'Stop a role from using "Delete everywhere"',
        type: 1,
        options: [{ name: 'role', description: 'The role', type: 8, required: true }],
      },
      { name: 'list', description: 'Show which roles can use "Delete everywhere"', type: 1 },
    ],
  },
  {
    name: 'Delete everywhere',
    type: 3, // message context menu (right-click a message -> Apps)
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
  },
  {
    name: 'admin',
    description: 'Manage who can use the bridge admin commands',
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
    options: [
      {
        name: 'add',
        description: 'Make someone a bridge admin',
        type: 1,
        options: [{ name: 'user', description: 'Who to add', type: 6, required: true }],
      },
      {
        name: 'remove',
        description: 'Remove a bridge admin',
        type: 1,
        options: [{ name: 'user', description: 'Start typing a name or ID', type: 3, required: true, autocomplete: true }],
      },
      { name: 'list', description: 'Show the bridge admins', type: 1 },
    ],
  },
  {
    name: 'server',
    description: 'Manage which channels are bridged together',
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
    options: [
      {
        name: 'add',
        description: 'Bridge a channel in this server',
        type: 1,
        options: [
          { name: 'tag', description: 'Short name shown after usernames, e.g. AIS', type: 3, required: true, max_length: 30 },
          { name: 'channel', description: 'Channel to bridge (default: this one)', type: 7, required: false, channel_types: [0, 5] },
        ],
      },
      {
        name: 'remove',
        description: 'Stop bridging a channel (any server)',
        type: 1,
        options: [{ name: 'channel', description: 'Start typing a tag or server name', type: 3, required: true, autocomplete: true }],
      },
      {
        name: 'tag',
        description: "Change a bridged channel's tag",
        type: 1,
        options: [
          { name: 'channel', description: 'Start typing a tag or server name', type: 3, required: true, autocomplete: true },
          { name: 'tag', description: 'New tag', type: 3, required: true, max_length: 30 },
        ],
      },
      { name: 'list', description: 'Show every bridged channel', type: 1 },
    ],
  },
];

module.exports = function setupMod(client, api) {
  function describe(id) {
    const a = api.authors.get(id);
    return a ? `${a.name} (@${a.username})` : `user ${id}`;
  }

  function resolveUserId(value) {
    const m = String(value || '').match(/\d{17,20}/);
    return m ? m[0] : null;
  }

  // "AIS — Server Name (#general)" for a bridged channel ID.
  function channelLabel(c) {
    const ch = client.channels.cache.get(String(c.id));
    const where = ch ? `${ch.guild?.name ?? 'Unknown server'} (#${ch.name})` : `channel ${c.id} (bot can't see it)`;
    return `${c.label || 'no tag'} — ${where}`;
  }

  function adminLabel(id) {
    const u = client.users.cache.get(id);
    const a = api.authors.get(id);
    return u ? `${u.globalName || u.username} (@${u.username})` : a ? `${a.name} (@${a.username})` : `user ${id}`;
  }

  async function handleAutocomplete(interaction) {
    if (!isAdmin(interaction.user.id)) return interaction.respond([]);
    const q = interaction.options.getFocused().toLowerCase().trim();

    if (interaction.commandName === 'server') {
      const choices = api.channels
        .list()
        .map((c) => ({ name: channelLabel(c).slice(0, 100), value: String(c.id) }))
        .filter((c) => !q || c.name.toLowerCase().includes(q) || c.value.includes(q))
        .slice(0, 25);
      return interaction.respond(choices);
    }

    if (interaction.commandName === 'admin') {
      const choices = readAdmins()
        .map((id) => ({ name: `${adminLabel(id)} • ${id}`.slice(0, 100), value: id }))
        .filter((c) => !q || c.name.toLowerCase().includes(q))
        .slice(0, 25);
      return interaction.respond(choices);
    }

    const pool =
      interaction.commandName === 'unban'
        ? api.blacklist.list().map((id) => [id, api.authors.get(id)])
        : [...api.authors].filter(([id]) => !api.blacklist.has(id));

    const choices = pool
      .filter(
        ([id, a]) =>
          !q ||
          id.includes(q) ||
          a?.name?.toLowerCase().includes(q) ||
          a?.username?.toLowerCase().includes(q)
      )
      .sort((x, y) => (y[1]?.last || 0) - (x[1]?.last || 0))
      .slice(0, 25)
      .map(([id, a]) => ({
        name: (a ? `${a.name} (@${a.username}) • ${a.server} • ${id}` : `Unknown user • ${id}`).slice(0, 100),
        value: id,
      }));
    return interaction.respond(choices);
  }

  async function handleBan(interaction) {
    if (!isAdmin(interaction.user.id)) {
      return interaction.reply({ content: 'Only bridge admins can use /ban.', ...eph });
    }
    const id = resolveUserId(interaction.options.getString('user'));
    if (!id) {
      return interaction.reply({ content: 'Pick someone from the list, or paste their user ID.', ...eph });
    }
    if (id === client.user.id || isAdmin(id)) {
      return interaction.reply({ content: "You can't ban the bot or a bridge admin.", ...eph });
    }

    await interaction.deferReply(eph);
    const reason = interaction.options.getString('reason');
    api.blacklist.add(id);

    const theirs = [...api.groups.values()].filter((g) => g.authorId === id);
    const { ok, failed } = await api.deleteManyGroups(theirs);

    console.log(
      `[BAN] ${interaction.user.tag} banned ${describe(id)} [${id}]` +
        `${reason ? ` — ${reason}` : ''}. Deleted ${ok}, failed ${failed}.`
    );
    const extra = failed
      ? `\n⚠️ ${failed} couldn't be deleted. The bot is probably missing **Manage Messages** in one of the servers.`
      : '';
    await interaction
      .editReply(
        `🔨 **${describe(id)}** is banned from the bridge. Their messages won't be relayed anymore.\n` +
          `Deleted ${ok} of their bridged messages across all servers.${extra}`
      )
      .catch(() => {}); // a huge purge can outlast the 15-minute interaction window
  }

  async function handleUnban(interaction) {
    if (!isAdmin(interaction.user.id)) {
      return interaction.reply({ content: 'Only bridge admins can use /unban.', ...eph });
    }
    const id = resolveUserId(interaction.options.getString('user'));
    if (!id || !api.blacklist.remove(id)) {
      return interaction.reply({ content: "That user isn't bridge-banned.", ...eph });
    }
    console.log(`[UNBAN] ${interaction.user.tag} unbanned ${describe(id)} [${id}].`);
    return interaction.reply({
      content: `✅ **${describe(id)}** can be relayed again. (Deleted messages don't come back.)`,
      ...eph,
    });
  }

  async function handleBridgeRoles(interaction) {
    const sub = interaction.options.getSubcommand();
    const current = getModRoles(interaction.guildId);

    if (sub === 'list') {
      const text = current.length
        ? current.map((id) => `<@&${id}>`).join(', ')
        : 'None set, so anyone with **Manage Messages** here can use it.';
      return interaction.reply({ content: `Roles that can use **Delete everywhere**: ${text}`, ...eph });
    }

    const role = interaction.options.getRole('role');
    if (sub === 'add') {
      if (!current.includes(role.id)) setModRoles(interaction.guildId, [...current, role.id]);
      return interaction.reply({ content: `<@&${role.id}> can now use **Delete everywhere**.`, ...eph });
    }
    if (sub === 'remove') {
      setModRoles(interaction.guildId, current.filter((id) => id !== role.id));
      return interaction.reply({ content: `<@&${role.id}> can no longer use **Delete everywhere**.`, ...eph });
    }
  }

  async function handleDeleteEverywhere(interaction) {
    if (!canDeleteEverywhere(interaction)) {
      return interaction.reply({ content: "You don't have permission to delete bridged messages.", ...eph });
    }
    const group = api.linkIndex.get(interaction.targetId);
    if (!group) {
      return interaction.reply({
        content: "That isn't a bridged message, or it's older than the bot remembers (30 days).",
        ...eph,
      });
    }

    await interaction.deferReply(eph);
    const { ok, failed } = await api.deleteGroupEverywhere(group);
    console.log(
      `[DELETE] ${interaction.user.tag} in ${interaction.guild?.name} deleted a message by ` +
        `${describe(group.authorId)} everywhere (${ok} deleted, ${failed} failed).`
    );
    return interaction.editReply(
      failed
        ? `Deleted ${ok} cop${ok === 1 ? 'y' : 'ies'}, but ${failed} couldn't be deleted. ` +
            'The bot is probably missing **Manage Messages** in the original server.'
        : '🗑️ Deleted from every server.'
    );
  }

  async function handleAdmin(interaction) {
    if (!isAdmin(interaction.user.id)) {
      return interaction.reply({ content: 'Only bridge admins can use /admin.', ...eph });
    }
    const sub = interaction.options.getSubcommand();
    const admins = readAdmins();

    if (sub === 'list') {
      const lines = [
        ...[...ownerIds].map((id) => `• <@${id}> (bot owner, always an admin)`),
        ...admins.filter((id) => !ownerIds.has(id)).map((id) => `• <@${id}>`),
      ];
      return interaction.reply({
        content: `**Bridge admins:**\n${lines.join('\n') || 'None yet.'}`,
        allowedMentions: { parse: [] },
        ...eph,
      });
    }

    if (sub === 'add') {
      const user = interaction.options.getUser('user');
      if (user.bot) return interaction.reply({ content: "Bots can't be admins.", ...eph });
      if (isAdmin(user.id)) return interaction.reply({ content: `<@${user.id}> is already an admin.`, ...eph });
      writeAdmins([...admins, user.id]);
      console.log(`[ADMIN] ${interaction.user.tag} added ${user.tag} [${user.id}] as admin.`);
      return interaction.reply({ content: `✅ <@${user.id}> is now a bridge admin.`, ...eph });
    }

    if (sub === 'remove') {
      const id = resolveUserId(interaction.options.getString('user'));
      if (id && ownerIds.has(id)) {
        return interaction.reply({ content: "The bot owner is always an admin and can't be removed.", ...eph });
      }
      if (!id || !admins.includes(id)) return interaction.reply({ content: "That user isn't an admin.", ...eph });
      writeAdmins(admins.filter((x) => x !== id));
      console.log(`[ADMIN] ${interaction.user.tag} removed admin [${id}].`);
      return interaction.reply({ content: `Removed <@${id}> from the bridge admins.`, ...eph });
    }
  }

  async function handleServer(interaction) {
    if (!isAdmin(interaction.user.id)) {
      return interaction.reply({ content: 'Only bridge admins can use /server.', ...eph });
    }
    const sub = interaction.options.getSubcommand();
    const mode = api.channels.mode();
    const modeNote = mode === 'TEST' ? ' (test mode list)' : '';

    if (sub === 'list') {
      const list = api.channels.list();
      const text = list.length ? list.map((c, i) => `${i + 1}. ${channelLabel(c)}`).join('\n') : 'No channels bridged yet.';
      return interaction.reply({ content: `**Bridged channels — ${mode}:**\n${text}`, ...eph });
    }

    if (sub === 'add') {
      const channel = interaction.options.getChannel('channel') || interaction.channel;
      const tag = interaction.options.getString('tag').trim();
      if (!channel || !channel.isTextBased?.() || channel.isThread?.()) {
        return interaction.reply({ content: 'Pick a normal text channel (not a thread).', ...eph });
      }
      if (!api.channels.add(channel.id, tag)) {
        return interaction.reply({ content: `<#${channel.id}> is already bridged. Use /server tag to rename it.`, ...eph });
      }

      // Warn about anything that would stop the bridge working in that channel.
      const perms = channel.permissionsFor?.(client.user);
      const missing = NEEDED_PERMS.filter(([flag]) => !perms?.has(PermissionFlagsBits[flag])).map(([, name]) => name);
      console.log(`[SERVER] ${interaction.user.tag} bridged #${channel.name} in ${interaction.guild?.name} as "${tag}".`);
      return interaction.reply({
        content:
          `✅ <#${channel.id}> is now bridged as **${tag}**${modeNote}.` +
          (missing.length ? `\n⚠️ The bot is missing these permissions there: **${missing.join(', ')}**.` : ''),
        ...eph,
      });
    }

    const id = String(interaction.options.getString('channel')).match(/\d{17,20}/)?.[0];
    const existing = api.channels.list().find((c) => String(c.id) === id);
    if (!existing) return interaction.reply({ content: "That channel isn't bridged. Pick one from the list.", ...eph });

    if (sub === 'remove') {
      api.channels.remove(id);
      console.log(`[SERVER] ${interaction.user.tag} unbridged ${channelLabel(existing)}.`);
      return interaction.reply({ content: `Stopped bridging **${channelLabel(existing)}**${modeNote}.`, ...eph });
    }

    if (sub === 'tag') {
      const tag = interaction.options.getString('tag').trim();
      api.channels.setTag(id, tag);
      return interaction.reply({ content: `Tag changed: **${existing.label || 'no tag'}** → **${tag}**.`, ...eph });
    }
  }

  // The bot owner (or every member of the owning team) is always an admin.
  client.once(Events.ClientReady, async () => {
    try {
      const app = await client.application.fetch();
      if (app.owner?.members) for (const id of app.owner.members.keys()) ownerIds.add(id);
      else if (app.owner?.id) ownerIds.add(app.owner.id);
    } catch (err) {
      console.error('Could not look up the bot owner:', err.message);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        if (['ban', 'unban', 'admin', 'server'].includes(interaction.commandName)) {
          return await handleAutocomplete(interaction);
        }
        return;
      }
      if (interaction.isMessageContextMenuCommand()) {
        if (interaction.commandName === 'Delete everywhere') return await handleDeleteEverywhere(interaction);
        return;
      }
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'ban') return await handleBan(interaction);
        if (interaction.commandName === 'unban') return await handleUnban(interaction);
        if (interaction.commandName === 'bridgeroles') return await handleBridgeRoles(interaction);
        if (interaction.commandName === 'admin') return await handleAdmin(interaction);
        if (interaction.commandName === 'server') return await handleServer(interaction);
      }
    } catch (err) {
      console.error('Moderation command error:', err.message);
      if (!interaction.isRepliable()) return;
      if (interaction.deferred) interaction.editReply('Something went wrong.').catch(() => {});
      else if (!interaction.replied) interaction.reply({ content: 'Something went wrong.', ...eph }).catch(() => {});
    }
  });
};

module.exports.commands = commands;
