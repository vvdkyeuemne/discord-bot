// clearCommands.js
// XÓA TOÀN BỘ SLASH COMMANDS CŨ (GLOBAL + GUILD)
// YÊU CẦU: đã đặt "type": "module" trong package.json

import 'dotenv/config';
import { REST, Routes } from 'discord.js';

// ✅ NHẬP THÔNG TIN Ở ĐÂY
const BOT_CLIENT_ID = '1403570560511905862'; // Application ID (Client ID) của bot
const GUILD_IDS = ['1403572945389097050']; // Có thể thêm nhiều server ID nếu cần

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

async function clearGlobal() {
  try {
    await rest.put(Routes.applicationCommands(BOT_CLIENT_ID), { body: [] });
    console.log('✅ Đã xóa toàn bộ GLOBAL commands.');
  } catch (err) {
    console.error('❌ Lỗi xóa GLOBAL:', err?.message || err);
  }
}

async function clearGuilds() {
  for (const gid of GUILD_IDS) {
    try {
      await rest.put(Routes.applicationGuildCommands(BOT_CLIENT_ID, gid), { body: [] });
      console.log(`✅ Đã xóa toàn bộ GUILD commands trong server ${gid}.`);
    } catch (err) {
      console.error(`❌ Lỗi xóa GUILD ${gid}:`, err?.message || err);
    }
  }
}

(async () => {
  console.log('🔄 Bắt đầu dọn lệnh...');
  await clearGlobal();
  await clearGuilds();
  console.log('🎉 Xong! Hãy chạy lại bot để đăng ký bộ lệnh mới.');
})();
