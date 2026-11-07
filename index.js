require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  MessageReferenceType,
  RESTJSONErrorCodes,
  SnowflakeUtil,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ── CONFIG ────────────────────────────────────────────────
// Test mode is toggled with `node channels.js toggle` (writes mode.json).
// Blacklisted user IDs live in blacklist.json (a JSON array of ID strings);
// their messages stay in their own server and are never relayed.
const MODE_FILE = path.join(__dirname, 'mode.json');
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
const STORE_FILE = path.join(__dirname, 'bridge-data.json');
const MAX_CONTENT = 2000;

function inTestMode() {
  try {
    return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).testMode === true;
  } catch {
    return false;
  }
}

function activeChannelsFile() {
  return path.join(__dirname, inTestMode() ? 'test-channels.json' : 'channels.json');
}

let BRIDGED_CHANNELS = [];
let CHANNEL_TAGS = new Map();
let BLACKLIST = new Set();

function loadChannels() {
  const testMode = inTestMode();
  const file = activeChannelsFile();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) throw new Error('expected a JSON array');
    BRIDGED_CHANNELS = data.map((c) => String(c.id));
    CHANNEL_TAGS = new Map(data.map((c) => [String(c.id), c.label || '']));
    console.log(`[${testMode ? 'TEST' : 'LIVE'}] Loaded ${BRIDGED_CHANNELS.length} bridged channels.`);
  } catch (err) {
    // Keep the previous list: a half-written file shouldn't silently stop the bridge.
    console.error(`Could not read ${path.basename(file)} (keeping previous list):`, err.message);
  }
}

function loadBlacklist() {
  try {
    const data = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
    if (!Array.isArray(data)) throw new Error('expected a JSON array');
    BLACKLIST = new Set(data.map(String));
    console.log(`Blacklist: ${BLACKLIST.size} user(s).`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Could not read blacklist.json (keeping previous list):', err.message);
    }
  }
}

function saveBlacklist() {
  fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...BLACKLIST], null, 2) + '\n');
}

loadChannels();
loadBlacklist();
for (const f of ['mode.json', 'channels.json', 'test-channels.json']) {
  fs.watchFile(path.join(__dirname, f), { interval: 1000 }, loadChannels);
}
fs.watchFile(BLACKLIST_FILE, { interval: 1000 }, loadBlacklist);
// ──────────────────────────────────────────────────────────

// ── MESSAGE LINK STORE ────────────────────────────────────
// Every relayed message is a "group": the original plus each copy.
// Saved to bridge-data.json so replies, reactions, edits, deletes and /ban
// keep working after a restart.
//   group = { authorId, t, entries: [{ channelId, messageId }, ...] }
//   entries[0] is always the original.
const MAX_GROUPS = 25000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // forget messages older than 30 days

const groups = new Map(); // original messageId -> group (oldest first)
const linkIndex = new Map(); // any messageId (original or copy) -> group
const authors = new Map(); // userId -> { name, username, server, last }

function addEntry(group, entry) {
  group.entries.push(entry);
  linkIndex.set(entry.messageId, group);
  scheduleSave();
}

function removeGroup(group) {
  if (!group.entries.length) return;
  groups.delete(group.entries[0].messageId);
  for (const e of group.entries) linkIndex.delete(e.messageId);
  scheduleSave();
}

function prune() {
  const cutoff = Date.now() - MAX_AGE_MS;
  let excess = groups.size - MAX_GROUPS; // oldest come first, so trim from the front
  for (const group of groups.values()) {
    if (excess > 0) {
      removeGroup(group);
      excess--;
    } else if (group.t < cutoff) {
      removeGroup(group);
    }
  }
}

function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const g of data.groups || []) {
      if (!g.m?.length) continue;
      const group = { authorId: g.a, t: g.t, entries: [] };
      groups.set(g.m[0][1], group); // key = original's message ID
      for (const [channelId, messageId] of g.m) {
        group.entries.push({ channelId, messageId });
        linkIndex.set(messageId, group);
      }
    }
    for (const [id, a] of Object.entries(data.authors || {})) authors.set(id, a);
    prune();
    console.log(`Remembered ${groups.size} bridged messages.`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read bridge-data.json:', err.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (!saveTimer) saveTimer = setTimeout(saveStore, 5000);
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = null;
  prune();
  clearTimeout(saveTimer); // prune() may have scheduled another save; this one covers it
  saveTimer = null;
  const data = {
    groups: [...groups.values()].map((g) => ({
      a: g.authorId,
      t: g.t,
      m: g.entries.map((e) => [e.channelId, e.messageId]),
    })),
    authors: Object.fromEntries(authors),
  };
  try {
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, STORE_FILE); // write-then-rename so a crash can't leave half a file
  } catch (err) {
    console.error('Could not save bridge-data.json:', err.message);
  }
}

loadStore();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    saveStore();
    process.exit(0);
  });
}
// ──────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

// channelId -> Promise<Webhook>. Caching the promise stops two messages
// arriving at once from each creating their own webhook.
const webhookCache = new Map();

function getRelayWebhook(channel) {
  if (!webhookCache.has(channel.id)) {
    const p = (async () => {
      const hooks = await channel.fetchWebhooks();
      let hook = hooks.find((h) => h.owner?.id === client.user.id && h.name === 'Bridge');
      if (!hook) hook = await channel.createWebhook({ name: 'Bridge' });
      return hook;
    })();
    p.catch(() => webhookCache.delete(channel.id));
    webhookCache.set(channel.id, p);
  }
  return webhookCache.get(channel.id);
}

// Run a webhook action; if the webhook was deleted in Discord, rebuild it once and retry.
async function withWebhook(channel, fn) {
  try {
    return await fn(await getRelayWebhook(channel));
  } catch (err) {
    if (err.code !== RESTJSONErrorCodes.UnknownWebhook) throw err;
    webhookCache.delete(channel.id);
    return fn(await getRelayWebhook(channel));
  }
}

// Discord rejects webhook names containing "discord"/"clyde"; a zero-width
// space *inside* the word gets around that.
function safeName(name) {
  const cleaned = name.replace(/discord|clyde/gi, (m) => `${m[0]}​${m.slice(1)}`).slice(0, 80);
  return cleaned.trim() || 'User';
}

function emojiToken(emoji) {
  if (!emoji.id) return emoji.name;
  return `${emoji.animated ? 'a:' : ''}${emoji.name}:${emoji.id}`;
}

function emojiKeyOf(emoji) {
  return emoji.id ?? emoji.name;
}

function isForward(message) {
  return message.reference?.type === MessageReferenceType.Forward;
}

// Text + attachments to relay. Forwarded messages keep their content in a snapshot.
// cleanContent turns <@id>/<#id>/<@&id> into readable names, since raw mentions
// show as "unknown" in the other servers.
function relayBody(message) {
  if (isForward(message)) {
    const snap = message.messageSnapshots?.first();
    const text = snap?.content ? `*Forwarded:*\n${snap.content}` : '*Forwarded message*';
    const files = snap ? [...snap.attachments.values()].map((a) => a.url) : [];
    return { text, files };
  }
  return {
    text: message.cleanContent || '',
    files: [...message.attachments.values()].map((a) => a.url),
  };
}

function fitContent(quote, text) {
  let content = `${quote}${text}`;
  if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT - 1) + '…';
  return content || undefined;
}

// Gather reply context once: who/what is being replied to, plus the link
// group of that message so we can build a per-server jump link.
async function getReplyContext(message) {
  if (!message.reference?.messageId || isForward(message)) return null;
  if (message.reference.channelId && message.reference.channelId !== message.channel.id) return null;
  const refId = message.reference.messageId;

  let ref;
  try {
    ref = await message.channel.messages.fetch(refId);
  } catch {
    return null;
  }

  const refName = ref.member?.displayName ?? ref.author?.username ?? 'someone';
  const withoutQuote = (ref.cleanContent || '')
    .split('\n')
    .filter((line) => !line.startsWith('> ↩️'))
    .join('\n');
  let snippet = withoutQuote.replace(/\n/g, ' ').replace(/[\[\]]/g, '').trim();
  if (!snippet && ref.attachments.size > 0) snippet = '[attachment]';
  if (snippet.length > 80) snippet = snippet.slice(0, 77) + '...';

  return { refName, snippet, group: linkIndex.get(refId) || null };
}

// Build the quote line for one destination. If we know the replied-to
// message's copy in that destination's server, hyperlink to it.
function formatReplyQuote(ctx, destChannelId, destGuildId) {
  if (!ctx) return '';
  const sibling = ctx.group?.entries.find((e) => e.channelId === destChannelId);
  if (sibling && destGuildId) {
    const url = `https://discord.com/channels/${destGuildId}/${destChannelId}/${sibling.messageId}`;
    return `> ↩️ [${ctx.refName}: ${ctx.snippet}](${url})\n`;
  }
  return `> ↩️ **${ctx.refName}**: ${ctx.snippet}\n`;
}

// ── DELETING ──────────────────────────────────────────────
// Delete one message and every copy of it. skipId = a message already gone.
async function deleteGroupEverywhere(group, skipId = null) {
  if (group.deleted) return { ok: 0, failed: 0 };
  group.deleted = true; // also tells an in-progress relay to stop and clean up
  removeGroup(group);

  let ok = 0;
  let failed = 0;
  for (const [i, e] of group.entries.entries()) {
    if (e.messageId === skipId) continue;
    try {
      const channel = await client.channels.fetch(e.channelId);
      if (i === 0) await channel.messages.delete(e.messageId); // original: needs Manage Messages
      else await withWebhook(channel, (hook) => hook.deleteMessage(e.messageId));
      ok++;
    } catch (err) {
      if (err.code === RESTJSONErrorCodes.UnknownMessage) continue; // already gone
      failed++;
      console.error(`Delete failed for ${e.messageId} in ${e.channelId}:`, err.message);
    }
  }
  return { ok, failed };
}

// Delete many groups fast (used by /ban): bulk-delete per channel where Discord allows it.
async function deleteManyGroups(list) {
  const byChannel = new Map();
  for (const group of list) {
    if (group.deleted) continue;
    group.deleted = true;
    removeGroup(group);
    for (const e of group.entries) {
      if (!byChannel.has(e.channelId)) byChannel.set(e.channelId, []);
      byChannel.get(e.channelId).push(e.messageId);
    }
  }

  let ok = 0;
  let failed = 0;
  // Bulk delete only works on messages under 14 days old (small safety margin).
  const bulkCutoff = Date.now() - (14 * 24 * 60 - 10) * 60 * 1000;

  for (const [channelId, ids] of byChannel) {
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch {
      failed += ids.length;
      continue;
    }

    const recent = ids.filter((id) => SnowflakeUtil.timestampFrom(id) > bulkCutoff);
    const oneByOne = ids.filter((id) => SnowflakeUtil.timestampFrom(id) <= bulkCutoff);

    for (let i = 0; i < recent.length; i += 100) {
      const chunk = recent.slice(i, i + 100);
      if (chunk.length < 2) {
        oneByOne.push(...chunk);
        continue;
      }
      try {
        await channel.bulkDelete(chunk, true);
        ok += chunk.length;
      } catch (err) {
        console.error(`Bulk delete failed in ${channelId} (${err.message}); trying one by one.`);
        oneByOne.push(...chunk);
      }
    }

    for (const id of oneByOne) {
      try {
        await channel.messages.delete(id);
        ok++;
      } catch (err) {
        if (err.code === RESTJSONErrorCodes.UnknownMessage) continue;
        failed++;
        console.error(`Delete failed for ${id} in ${channelId}:`, err.message);
      }
    }
  }
  return { ok, failed };
}

// A message was deleted in Discord.
function onMessageDeleted(messageId) {
  const group = linkIndex.get(messageId);
  if (!group) return;

  if (group.entries[0].messageId === messageId) {
    // Original deleted (by its author or a mod in its own server): remove the copies too.
    deleteGroupEverywhere(group, messageId).catch((err) => console.error('Delete mirror error:', err.message));
  } else {
    // A copy was deleted normally: that stays local. Use "Delete everywhere" to spread it.
    group.entries = group.entries.filter((e) => e.messageId !== messageId);
    linkIndex.delete(messageId);
    scheduleSave();
  }
}
// ──────────────────────────────────────────────────────────

client.once(Events.ClientReady, (c) => {
  console.log(`Bridge online as ${c.user.tag}`);
  console.log(`Mode: ${inTestMode() ? 'TEST (test-channels.json)' : 'LIVE (channels.json)'}`);
  console.log(`Bridging ${BRIDGED_CHANNELS.length} channels.`);
});

async function relayMessage(message) {
  if (message.author.bot || message.webhookId) return;
  if (!BRIDGED_CHANNELS.includes(message.channel.id)) return;
  if (BLACKLIST.has(message.author.id)) return; // blacklisted: stays local only

  const { text, files } = relayBody(message);
  if (!text && files.length === 0) return;

  const authorName = message.member?.displayName ?? message.author.username;
  const tag = CHANNEL_TAGS.get(message.channel.id) || message.guild?.name || 'Unknown';
  const displayName = safeName(`${authorName} • ${tag}`);
  const avatarURL = message.author.displayAvatarURL();

  authors.set(message.author.id, {
    name: authorName,
    username: message.author.username,
    server: tag,
    last: Date.now(),
  });

  const replyCtx = await getReplyContext(message);

  // Register the group up front so edits/deletes made mid-relay are caught.
  const group = { authorId: message.author.id, t: message.createdTimestamp, entries: [] };
  groups.set(message.id, group);
  addEntry(group, { channelId: message.channel.id, messageId: message.id });

  for (const channelId of BRIDGED_CHANNELS) {
    if (channelId === message.channel.id) continue;
    if (group.deleted) break;

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) continue;

      const quote = formatReplyQuote(replyCtx, channelId, channel.guildId);
      const base = { username: displayName, avatarURL, allowedMentions: { parse: [] } };

      let sent;
      try {
        sent = await withWebhook(channel, (hook) =>
          hook.send({ ...base, content: fitContent(quote, text), files })
        );
      } catch (err) {
        if (!files.length) throw err;
        // Usually a file over the upload limit: send links instead so the text still arrives.
        console.error(`Attachment upload to ${channelId} failed (${err.message}); sending links.`);
        sent = await withWebhook(channel, (hook) =>
          hook.send({ ...base, content: fitContent(quote, [text, ...files].filter(Boolean).join('\n')) })
        );
      }

      if (!sent?.id) continue;
      if (group.deleted) {
        // Original was deleted (or its author banned) while we were relaying.
        await withWebhook(channel, (hook) => hook.deleteMessage(sent.id)).catch(() => {});
      } else {
        addEntry(group, { channelId, messageId: sent.id });
      }
    } catch (err) {
      console.error(`Failed to relay to ${channelId}:`, err.message);
    }
  }
}

// Relay one message at a time so copies arrive in the same order as the originals.
let relayQueue = Promise.resolve();
client.on(Events.MessageCreate, (message) => {
  relayQueue = relayQueue
    .then(() => relayMessage(message))
    .catch((err) => console.error('Relay error:', err.message));
});

// Count of non-bot users who have this emoji on a message.
function humanCount(msg, key) {
  const r = msg?.reactions.cache.find((x) => emojiKeyOf(x.emoji) === key);
  if (!r) return 0;
  return r.count - (r.me ? 1 : 0);
}

async function mirrorReaction(reaction, user, action) {
  if (user.partial) {
    try { await user.fetch(); } catch { return; }
  }
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }

  const group = linkIndex.get(reaction.message.id);
  if (!group) return;
  const entries = [...group.entries];

  const token = emojiToken(reaction.emoji);
  const key = emojiKeyOf(reaction.emoji);

  if (action === 'add') {
    for (const sibling of entries) {
      if (sibling.messageId === reaction.message.id) continue;
      try {
        const channel = await client.channels.fetch(sibling.channelId);
        const msg = await channel.messages.fetch(sibling.messageId);
        await msg.react(token);
      } catch (err) {
        console.error(`Reaction mirror failed for ${sibling.messageId}:`, err.message);
      }
    }
    return;
  }

  // Remove: only pull the bot's reaction from a copy when no human on any
  // *other* copy still has that emoji (someone elsewhere may still be reacting).
  const msgs = await Promise.all(
    entries.map(async (s) => {
      try {
        const channel = await client.channels.fetch(s.channelId);
        return await channel.messages.fetch({ message: s.messageId, force: true });
      } catch {
        return null;
      }
    })
  );
  const counts = msgs.map((m) => humanCount(m, key));
  const total = counts.reduce((a, b) => a + b, 0);

  for (let i = 0; i < entries.length; i++) {
    const msg = msgs[i];
    if (!msg || entries[i].messageId === reaction.message.id) continue;
    if (total - counts[i] > 0) continue;
    const r = msg.reactions.cache.find((x) => emojiKeyOf(x.emoji) === key);
    if (!r?.me) continue;
    try {
      await r.users.remove(client.user.id);
    } catch (err) {
      console.error(`Reaction mirror failed for ${entries[i].messageId}:`, err.message);
    }
  }
}

client.on(Events.MessageReactionAdd, (reaction, user) =>
  mirrorReaction(reaction, user, 'add').catch((err) => console.error('Reaction error:', err.message))
);
client.on(Events.MessageReactionRemove, (reaction, user) =>
  mirrorReaction(reaction, user, 'remove').catch((err) => console.error('Reaction error:', err.message))
);

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    const group = linkIndex.get(newMessage.id);
    if (!group) return;
    if (group.entries[0].messageId !== newMessage.id) return; // only the original's edits are mirrored

    if (newMessage.partial) {
      try { newMessage = await newMessage.fetch(); } catch { return; }
    }
    if (newMessage.author?.bot || newMessage.webhookId) return;
    // Skip embed/link-preview updates that don't change the text.
    if (oldMessage && !oldMessage.partial && oldMessage.content === newMessage.content) return;

    const replyCtx = await getReplyContext(newMessage);
    const { text } = relayBody(newMessage);

    for (const sibling of [...group.entries]) {
      if (sibling.messageId === newMessage.id) continue;
      try {
        const channel = await client.channels.fetch(sibling.channelId);
        const quote = formatReplyQuote(replyCtx, sibling.channelId, channel.guildId);
        // An empty string (not undefined) so clearing the text also clears it on the copies.
        const content = fitContent(quote, text) ?? '';
        await withWebhook(channel, (hook) =>
          hook.editMessage(sibling.messageId, { content, allowedMentions: { parse: [] } })
        );
      } catch (err) {
        console.error(`Edit mirror failed for ${sibling.messageId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Edit mirror error:', err.message);
  }
});

client.on(Events.MessageDelete, (message) => onMessageDeleted(message.id));
client.on(Events.MessageBulkDelete, (messages) => {
  for (const id of messages.keys()) onMessageDeleted(id);
});

// ── FEATURE MODULES + SLASH COMMANDS ──────────────────────
const setupRoles = require('./roles.js');
const setupMod = require('./mod.js');

// Read/write the channel list for the current mode (same files channels.js uses).
function readChannelList() {
  try {
    const data = JSON.parse(fs.readFileSync(activeChannelsFile(), 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function writeChannelList(list) {
  fs.writeFileSync(activeChannelsFile(), JSON.stringify(list, null, 2) + '\n');
  loadChannels(); // apply right away instead of waiting for the file watcher
}

setupRoles(client);
setupMod(client, {
  groups,
  linkIndex,
  authors,
  deleteGroupEverywhere,
  deleteManyGroups,
  channels: {
    mode: () => (inTestMode() ? 'TEST' : 'LIVE'),
    list: readChannelList,
    add(id, label) {
      const list = readChannelList();
      if (list.some((c) => String(c.id) === id)) return false;
      list.push({ id, label: label || '' });
      writeChannelList(list);
      return true;
    },
    remove(id) {
      const list = readChannelList();
      const next = list.filter((c) => String(c.id) !== id);
      if (next.length === list.length) return false;
      writeChannelList(next);
      return true;
    },
    setTag(id, label) {
      const list = readChannelList();
      const ch = list.find((c) => String(c.id) === id);
      if (!ch) return false;
      ch.label = label;
      writeChannelList(list);
      return true;
    },
  },
  blacklist: {
    has: (id) => BLACKLIST.has(id),
    list: () => [...BLACKLIST],
    add(id) {
      BLACKLIST.add(id);
      saveBlacklist();
    },
    remove(id) {
      const had = BLACKLIST.delete(id);
      if (had) saveBlacklist();
      return had;
    },
  },
});

// Both modules' commands are registered together: guild.commands.set()
// replaces the whole list, so registering them separately would wipe one out.
const allCommands = [...setupRoles.commands, ...setupMod.commands];
async function registerCommands(guild) {
  try {
    await guild.commands.set(allCommands);
  } catch (err) {
    console.error(`Command register failed in ${guild.name}:`, err.message);
  }
}
client.once(Events.ClientReady, async () => {
  for (const guild of client.guilds.cache.values()) await registerCommands(guild);
});
client.on(Events.GuildCreate, registerCommands);

// Without these, a single network hiccup or unhandled rejection can crash the bot.
client.on(Events.Error, (err) => console.error('Client error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing from .env');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
