import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';

/**
 * This script logs in with your BOT TOKEN, discovers APP_ID automatically,
 * then deletes ALL global commands and ALL guild commands across guilds
 * the bot is in (or a single GUILD_ID if you set it).
 *
 * Secrets needed: TOKEN
 * Optional: GUILD_ID (to target a single guild)
 */

const TOKEN = process.env.TOKEN;
const ONE_GUILD_ID = process.env.GUILD_ID || ''; // leave empty to clear all guilds the bot is in

if (!TOKEN) {
  console.error('Missing TOKEN in Secrets.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once('ready', async () => {
  try {
    const APP_ID = client.application.id;
    console.log('🆔 Application ID:', APP_ID);

    // 1) Clear GLOBAL
    console.log('🔻 Clearing GLOBAL commands...');
    const globalCmds = await rest.get(Routes.applicationCommands(APP_ID));
    for (const c of globalCmds) {
      await rest.delete(Routes.applicationCommand(APP_ID, c.id));
      console.log('  • deleted global:', c.name);
    }

    // 2) Clear GUILD(s)
    const guildIds = ONE_GUILD_ID ? [ONE_GUILD_ID] : client.guilds.cache.map(g => g.id);
    for (const gid of guildIds) {
      console.log('🔻 Clearing GUILD commands for', gid, '...');
      const guildCmds = await rest.get(Routes.applicationGuildCommands(APP_ID, gid)).catch(() => []);
      for (const c of guildCmds) {
        await rest.delete(Routes.applicationGuildCommand(APP_ID, gid, c.id));
        console.log('  • deleted guild:', c.name);
      }
    }

    console.log('✅ Done. All slash commands cleared.');
  } catch (e) {
    console.error('Cleanup error:', e);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(TOKEN);
