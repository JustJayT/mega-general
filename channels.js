const fs = require('fs');
const path = require('path');

const MODE_FILE = path.join(__dirname, 'mode.json');

function inTestMode() {
  try {
    return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8')).testMode === true;
  } catch {
    return false; // no mode.json yet -> default to live
  }
}

// The list the CLI reads/writes follows the current mode, matching the bot.
function channelsFile() {
  return path.join(__dirname, inTestMode() ? 'test-channels.json' : 'channels.json');
}

function setMode(next) {
  fs.writeFileSync(MODE_FILE, JSON.stringify({ testMode: next }, null, 2) + '\n');
  console.log(`Mode is now ${next ? 'TEST (test-channels.json)' : 'LIVE (channels.json)'}.`);
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(channelsFile(), 'utf8'));
  } catch {
    return []; // file missing or empty — start fresh
  }
}

function save(channels) {
  fs.writeFileSync(channelsFile(), JSON.stringify(channels, null, 2) + '\n');
}

function list() {
  const channels = load();
  const mode = inTestMode() ? 'TEST' : 'LIVE';
  if (channels.length === 0) {
    console.log(`\n[${mode}] No channels linked yet.`);
    console.log('Add one with:  node channels.js add <id> <tag>\n');
    return;
  }
  console.log(`\n[${mode}] Linked channels (${channels.length}):\n`);
  channels.forEach((c, i) => {
    const label = c.label ? `  —  ${c.label}` : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${c.id}${label}`);
  });
  console.log('');
}

function add(id, label) {
  if (!id) {
    console.log('Usage: node channels.js add <channelId> <tag>');
    return;
  }
  const channels = load();
  if (channels.some((c) => c.id === id)) {
    console.log(`Channel ${id} is already linked.`);
    return;
  }
  channels.push({ id, label: label || '' });
  save(channels);
  console.log(`Added ${id}${label ? ` (${label})` : ''}.  Now ${channels.length} linked.`);
}

function remove(id) {
  if (!id) {
    console.log('Usage: node channels.js remove <channelId>');
    return;
  }
  const channels = load();
  const idx = channels.findIndex((c) => c.id === id);
  if (idx === -1) {
    console.log(`Channel ${id} isn't in the list.`);
    return;
  }
  const [removed] = channels.splice(idx, 1);
  save(channels);
  console.log(`Removed ${removed.id}${removed.label ? ` (${removed.label})` : ''}.  Now ${channels.length} linked.`);
}

function label(id, newLabel) {
  if (!id) {
    console.log('Usage: node channels.js tag <channelId> <tag>');
    return;
  }
  const channels = load();
  const ch = channels.find((c) => c.id === id);
  if (!ch) {
    console.log(`Channel ${id} isn't linked yet — add it first.`);
    return;
  }
  ch.label = newLabel || '';
  save(channels);
  console.log(`Set tag for ${id} to "${ch.label}".`);
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'list':
  case 'ls':
    list();
    break;
  case 'add':
    add(args[0], args.slice(1).join(' '));
    break;
  case 'remove':
  case 'rm':
    remove(args[0]);
    break;
  case 'label':
  case 'tag':
    label(args[0], args.slice(1).join(' '));
    break;
  case 'toggle':
    setMode(!inTestMode());
    break;
  case 'mode':
    if (!args[0]) {
      console.log(`Current mode: ${inTestMode() ? 'TEST (test-channels.json)' : 'LIVE (channels.json)'}`);
    } else if (['test', 'on'].includes(args[0])) {
      setMode(true);
    } else if (['live', 'off'].includes(args[0])) {
      setMode(false);
    } else {
      console.log('Usage: node channels.js mode [test|live]   (or: node channels.js toggle)');
    }
    break;
  default:
    console.log(`
Channel manager for the bridge bot.

Commands operate on whichever list matches the current mode
(LIVE -> channels.json, TEST -> test-channels.json).

Usage:
  node channels.js list                Show linked channels (current mode)
  node channels.js add <id> <tag>      Link a channel (tag optional)
  node channels.js tag <id> <tag>      Set/change the tag on a linked channel
  node channels.js remove <id>         Unlink a channel
  node channels.js toggle              Flip between LIVE and TEST mode
  node channels.js mode [test|live]    Show or set the mode

The tag is what shows after each username in relayed messages,
e.g. a channel tagged "AIS" relays as  Username • AIS

Examples:
  node channels.js add 983046488546480129 Main Server
  node channels.js tag 983046488546480129 AIS
  node channels.js toggle
`);
}