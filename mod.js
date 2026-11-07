// Moderation across the bridge:
//   /ban <user>           bridge admins only: stop relaying them + delete their bridged messages everywhere
//   /unban <user>         bridge admins only: undo the relay block
//   /bridgeroles ...      server managers: pick which roles here may use "Delete everywhere"
//   Delete everywhere     right-click a message -> Apps: delete it and every copy in every server
//
// Bridge admins = user IDs listed in admins.json, e.g. ["123456789012345678"].
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

// Read fresh every time so editing admins.json takes effect without a restart.
function isAdmin(userId) {
  const list = readJson(ADMINS_FILE, []);
  return Array.isArray(list) && list.map(String).includes(userId);
}

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

  async function handleAutocomplete(interaction) {
    if (!isAdmin(interaction.user.id)) return interaction.respond([]);
    const q = interaction.options.getFocused().toLowerCase().trim();

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

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isAutocomplete()) {
        if (['ban', 'unban'].includes(interaction.commandName)) return await handleAutocomplete(interaction);
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
