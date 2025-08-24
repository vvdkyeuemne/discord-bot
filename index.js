// ===================== index.js (full) =====================
// - /playsc: SoundCloud tìm kiếm phân trang 5 kết quả/trang (◀️ ▶️)
// - Mỗi trang gửi 5 EMBEDS => 5 ảnh (mỗi embed 1 kết quả)
// - Mô tả gồm: Artist • BPM • Thời lượng • ▶Plays • ❤Likes
// - Tự lấy/refresh SoundCloud client_id, cache tìm kiếm 5 phút
// - Voice: đợi READY + xử lý Stage Channel + thêm logs
// ===========================================================

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { createCanvas, loadImage } from '@napi-rs/canvas';
import * as play from 'play-dl';
import * as gtrans from '@vitalets/google-translate-api';
import {
  joinVoiceChannel,
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,              // << thêm
} from '@discordjs/voice';

// ===== Optional tokens
if (process.env.YT_COOKIE) {
  play.setToken({ youtube: { cookie: process.env.YT_COOKIE } });
}
if (process.env.SC_CLIENT_ID) {
  play.setToken({ soundcloud: { client_id: process.env.SC_CLIENT_ID } });
}
// >>> auto get free SoundCloud client_id
(async () => {
  try {
    if (!process.env.SC_CLIENT_ID) {
      const id = await play.getFreeClientID();
      if (id) {
        play.setToken({ soundcloud: { client_id: id } });
        console.log('🎧 SoundCloud client_id (free):', id.slice(0, 12) + '…');
      }
    }
  } catch (e) {
    console.warn('⚠️ Lỗi lấy SC client_id free:', e?.message || e);
  }
})();

// ------------------- tiny web keepalive -------------------
const app = express();
app.get('/', (_req, res) => res.send('Bot is alive'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`🌐 Web server on ${port}`));

// ------------------- discord client -------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ]
});

// ------------------- files -------------------
const DATA_FILE = path.join(process.cwd(), 'wins.json');
const WELCOME_FILE = path.join(process.cwd(), 'welcome.json');

let wins = {};
let welcomes = {};
async function saveWelcomes() {
  try {
    await fs.writeFile(WELCOME_FILE, JSON.stringify(welcomes, null, 2), 'utf8');
  } catch (e) {
    console.warn('saveWelcomes error:', e?.message || e);
  }
}
// Tạo payload chào mừng (embed + content tuỳ chỉnh)
function buildWelcomePayload(member, data, { demo = false } = {}) {
  const guild = member.guild;
  const countFmt = new Intl.NumberFormat('vi-VN').format(guild.memberCount);

  const avatar  = member.user.displayAvatarURL({ size: 512 });
  const iconURL = guild.iconURL?.({ size: 256 }) || null;
  const banner  = guild.bannerURL?.({ size: 1024 }) || null;

  const embed = new EmbedBuilder()
    .setColor(0x00D084)
    .setTitle(demo ? '🧪 (Demo) chào mừng' : '🎉 Chào mừng thành viên mới!')
    .setDescription(
      `Xin chào ${member.user.username}!\n` +
      `Chào mừng bạn đến với **${guild.name}**.\n` +
      `Bạn là thành viên thứ **${countFmt}** ✨`
    )
    .setThumbnail(avatar)
    .setTimestamp();

  if (iconURL) embed.setAuthor({ name: guild.name, iconURL });
  if (banner)  embed.setImage(banner);

  // Thay thế placeholder trong thông điệp tuỳ chỉnh
  let custom = String(data?.message || '')
    .replaceAll('{member}', `${member}`)
    .replaceAll('{server}', guild.name)
    .replaceAll('{count}', countFmt)
    .trim();

  return {
    content: custom ? `*${custom}*` : null,
    embeds: [embed],
  };
}
client.on('guildMemberAdd', async (member) => {
  try {
    const data = welcomes[member.guild.id];
    if (!data) return; // chưa cấu hình

    // Lấy channel: ưu tiên cache, fallback fetch
    let ch = member.guild.channels.cache.get(data.channelId);
    if (!ch) {
      try { ch = await member.guild.channels.fetch(data.channelId).catch(() => null); } catch {}
    }
    if (!ch || !ch.isTextBased?.()) return;

    const payload = buildWelcomePayload(member, data, { demo: false });
    await ch.send(payload);
  } catch (e) {
    console.error('❌ Không gửi được welcome:', e);
  }
});

const COIN_FILE = path.join(process.cwd(), 'coins.json');
let coins = {};
// ===== RPSLS state + badges =====
const RPS_FILE   = path.join(process.cwd(), 'rpsls.json');   // optional backup
const BADGE_FILE = path.join(process.cwd(), 'badges.json');

let rpslsState = new Map();   // guildId -> tournament state
let badges     = {};          // { uid: [badgeName,..] }

async function loadBadges(){
  try { badges = JSON.parse(await fs.readFile(BADGE_FILE,'utf8')); } catch { badges = {}; }
}
async function saveBadges(){
  try { await fs.writeFile(BADGE_FILE, JSON.stringify(badges,null,2),'utf8'); } catch {}
}
function addBadge(uid, name){
  if (!badges[uid]) badges[uid] = [];
  if (!badges[uid].includes(name)) badges[uid].push(name);
  saveBadges().catch(()=>{});
}

// ==== RPSLS core helpers ====
const RPS = {
  moves: ['rock','paper','scissors','lizard','spock'],
  emoji(m){ return ({ rock:'🪨', paper:'📄', scissors:'✂️', lizard:'🦎', spock:'🖖' })[m] || '❓'; },
  win(a,b){
    const W = {
      rock:['scissors','lizard'],
      paper:['rock','spock'],
      scissors:['paper','lizard'],
      lizard:['spock','paper'],
      spock:['scissors','rock']
    };
    if (a===b) return 0;
    return W[a].includes(b) ? 1 : -1;
  }
};
async function updateLobby(interaction, st) {
  // danh sách tên người chơi
  const names = st.players.map(u => `<@${u}>`).join('\n') || '(chưa có)';

  // embed lobby
  const embed = new EmbedBuilder()
    .setColor(0x7c65ff)
    .setTitle('🎮 RPSLS Tournament – Đăng ký')
    .setDescription(`Slots: **${st.slots}** • Phí: **${st.fee.toLocaleString('vi-VN')}** • Thưởng: **${st.reward.toLocaleString('vi-VN')}**\nNhấn **Tham gia** để vào giải.`)
    .addFields({ name: 'Người chơi', value: names })
    .setFooter({ text: `TID: ${st.tid}` });

  try {
    // Lấy channel và EDIT message lobby bằng MessageManager
    const ch = await interaction.client.channels.fetch(st.channelId);
    if (!ch || !ch.isTextBased()) return;

    await ch.messages.edit(
      st.msgLobbyId,
      { embeds: [embed], components: lobbyButtons(st.tid) }
    );
  } catch (e) {
    console.error('[RPSLS] updateLobby failed:', e);
  }
}
// === Bắt đầu giải & tạo cặp đấu ===
async function startTournament(client, st) {
  try {
    // đánh dấu đã bắt đầu
    st.started = true;
    st.round = 1;
    st.moves = new Map();        // key: `${round}-${uid}` -> 'rock'|'paper'|'scissors'|'lizard'|'spock'
    st.winners = [];           // danh sách người thắng của round hiện tại
    st.currentPairIndex = 0;   // index cặp đang đánh trong st.bracket
    st.currentPair = null;     // cặp hiện tại
    st.resolvedPairs = new Set(); // đánh dấu các cặp đã xử lý xong
    
    // tạo cặp theo thứ tự người chơi
    const players = [...st.players];
    if (players.length < 2) return;

    const pairs = [];
    for (let i = 0; i < players.length; i += 2) {
      const a = players[i];
      const b = players[i + 1];
      if (b) pairs.push({ a, b });
    }

    st.bracket = pairs;
    st.currentPair = pairs[0];
    st.currentPairIndex = 0;
st.currentPair = st.bracket[0];
const ch = await client.channels.fetch(st.channelId);
const p = st.currentPair;
await ch.send({
  content: `**Round ${st.round}**: <@${p.a}> vs <@${p.b}> — chọn nước đi!`,
  components: [ rpsPlayRow(st.tid, st.round) ],
});

  } catch (e) {
    console.error('[RPSLS] startTournament error:', e);
  }
}

// Hàng nút chọn nước đi cho RPSLS
function rpsPlayRow(tid, round) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_rock`).setLabel('Rock').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_paper`).setLabel('Paper').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_scissors`).setLabel('Scissors').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_lizard`).setLabel('Lizard').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_spock`).setLabel('Spock').setStyle(ButtonStyle.Primary),
  );
}
// === TikTok auto settings (JSON) ===
const TIKTOK_SETTINGS_FILE = path.join(process.cwd(), "tiktok-settings.json");
let tiktokSettings = { guilds: {} };

// Load file JSON tiktok-settings.json
async function loadTikTokSettings() {
  try {
    const raw = await fs.readFile(TIKTOK_SETTINGS_FILE, "utf8");
    tiktokSettings = JSON.parse(raw || "{}") || { guilds: {} };
  } catch {
    tiktokSettings = { guilds: {} };
  }
}

// Lưu file JSON tiktok-settings.json
async function saveTikTokSettings() {
  await fs.writeFile(
    TIKTOK_SETTINGS_FILE,
    JSON.stringify(tiktokSettings, null, 2)
  );
}

// Kiểm tra 1 message có cần auto xử lý TikTok không
function isTikTokAutoEnabledForMessage(msg) {
  if (!msg.guildId) return false; 
  const g = tiktokSettings.guilds[msg.guildId];
  if (!g || g.mode === "off") return false;
  if (g.mode === "server") return true;
  if (g.mode === "channel") return msg.channelId === g.channelId;
  return false;
  }

// extend loaders to include coins
async function saveCoins(){ await saveJsonSafe(COIN_FILE, coins); }


async function loadJsonSafe(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { await fs.writeFile(file, JSON.stringify(fallback, null, 2)); return fallback; }
}
async function saveJsonSafe(file, obj) { try { await fs.writeFile(file, JSON.stringify(obj, null, 2)); } catch {} }
async function loadAll() { wins = await loadJsonSafe(DATA_FILE, {}); welcomes = await loadJsonSafe(WELCOME_FILE, {}); coins = await loadJsonSafe(COIN_FILE, {}); }
async function saveWins(){ await saveJsonSafe(DATA_FILE, wins); }
function ensureGuild(gid){ if(!wins[gid]) wins[gid] = {}; }
function addWin(gid, uid){ ensureGuild(gid); wins[gid][uid] = (wins[gid][uid] || 0) + 1; return wins[gid][uid]; }
function getTop(gid, limit=10){ ensureGuild(gid); const arr = Object.entries(wins[gid]); arr.sort((a,b)=>b[1]-a[1]); return arr.slice(0,limit); }

// ----- coin helpers -----
function getBal(uid){ return Number(coins[uid] || 0); }
function addBal(uid, amt){ coins[uid] = getBal(uid) + Number(amt); if (!Number.isFinite(coins[uid])) coins[uid] = 0; saveCoins(); return coins[uid]; }
function resetWins(gid){ wins[gid] = {}; }

// ===== QUIZ: dữ liệu & tiện ích =====
const QUIZ_REWARD = 1000;           // coin thưởng cho mỗi câu đúng
const QUIZ_DURATION_MS = 15000;     // thời gian trả lời (15s)
const quizCooldown = new Map();     // cooldown theo channel
const QUIZ_COOLDOWN_MS = 10000;     // 10s chống spam /quiz
let QUIZ_BANK = [
  { q: "HTTP 404 là gì?", choices: ["OK","Forbidden","Not Found","Server Error"], ans: 2, exp: "404 = tài nguyên không tồn tại." },
  { q: "Ngôn ngữ chạy trên Node.js?", choices: ["Python","Java","JavaScript","C#"], ans: 2, exp: "Node.js thực thi JavaScript." },
  { q: "Thủ đô Nhật Bản?", choices: ["Seoul","Tokyo","Kyoto","Osaka"], ans: 1, exp: "Tokyo." },
];

async function loadQuizBank() {
  try {
    const pathJson = path.join(process.cwd(), 'quiz.json');
    const exists = await fs.access(pathJson).then(()=>true).catch(()=>false);
    if (!exists) return;
    const raw = await fs.readFile(pathJson, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.every(x => x && x.q && Array.isArray(x.choices) && x.choices.length===4 && Number.isInteger(x.ans))) {
      QUIZ_BANK = arr;
      console.log(`[QUIZ] Loaded ${arr.length} questions from quiz.json`);
    } else {
      console.warn('[QUIZ] quiz.json format invalid. Using built-in samples.');
    }
  } catch (e) {
    console.warn('[QUIZ] Could not load quiz.json:', e?.message || e);
  }
}

// trộn mảng
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
// lấy 1 câu ngẫu nhiên, trộn đáp án nhưng vẫn giữ chỉ mục đúng
function pickQuiz(){
  const base = QUIZ_BANK[Math.floor(Math.random()*QUIZ_BANK.length)];
  const idxs = [0,1,2,3];
  const shuf = shuffle(idxs);
  const choices = shuf.map(i => base.choices[i]);
  const ans = shuf.indexOf(base.ans);
  return { q: base.q, choices, ans, exp: base.exp };
}


// ------------------- utils

// ====== helpers for Tai Xiu animation ======
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const diceFace = (n) => ['⚀','⚁','⚂','⚃','⚄','⚅'][Math.max(1, Math.min(6, n)) - 1];

 // -------------------
function chunkText(str, size=3800){ if(!str) return []; const out=[]; for (let i=0;i<str.length;i+=size) out.push(str.slice(i,i+size)); return out; }
function formatUptime(ms){ const s=Math.floor(ms/1000); const d=Math.floor(s/86400); const h=Math.floor((s%86400)/3600); const m=Math.floor((s%3600)/60); const sec=s%60; const p=[]; if(d)p.push(`${d}d`); if(h)p.push(`${h}h`); if(m)p.push(`${m}m`); p.push(`${sec}s`); return p.join(' '); }
function pingStyle(p){ if(p<80) return {color:0x57F287,emoji:'🟢'}; if(p<150) return {color:0xFEE75C,emoji:'🟡'}; return {color:0xED4245,emoji:'🔴'}; }
const fmtBytes = (b)=>{ const u=['B','KB','MB','GB','TB']; let i=0,n=b; while(n>=1024&&i<u.length-1){n/=1024;i++;} return `${n.toFixed(n>=100?0:n>=10?1:2)} ${u[i]}`; };

// ------------------- weather helpers -------------------
const WMO = {0:{d:'☀️',n:'🌙',t:'Trời quang'},1:{d:'🌤️',n:'☁️',t:'Nắng nhẹ / Ít mây'},2:{d:'⛅',n:'☁️',t:'Nhiều mây'},3:{d:'☁️',n:'☁️',t:'U ám'},
45:{d:'🌫️',n:'🌫️',t:'Sương mù'},48:{d:'🌫️',n:'🌫️',t:'Sương mù băng'},
51:{d:'🌦️',n:'🌧️',t:'Mưa phùn nhẹ'},53:{d:'🌦️',n:'🌧️',t:'Mưa phùn vừa'},55:{d:'🌧️',n:'🌧️',t:'Mưa phùn to'},
56:{d:'🌧️❄️',n:'🌧️❄️',t:'Mưa phùn băng'},57:{d:'🌧️❄️',n:'🌧️❄️',t:'Mưa phùn băng nặng'},
61:{d:'🌦️',n:'🌧️',t:'Mưa nhẹ'},63:{d:'🌧️',n:'🌧️',t:'Mưa vừa'},65:{d:'🌧️☔',n:'🌧️☔',t:'Mưa to'},
66:{d:'🌧️❄️',n:'🌧️❄️',t:'Mưa băng'},67:{d:'🌧️❄️',n:'🌧️❄️',t:'Mưa băng to'},
71:{d:'🌨️',n:'🌨️',t:'Tuyết nhẹ'},73:{d:'🌨️',n:'🌨️',t:'Tuyết vừa'},75:{d:'❄️',n:'❄️',t:'Tuyết to'},
77:{d:'❄️',n:'❄️',t:'Bông tuyết'},
80:{d:'🌦️',n:'🌧️',t:'Mưa rào nhẹ'},81:{d:'🌧️',n:'🌧️',t:'Mưa rào vừa'},82:{d:'⛈️',n:'⛈️',t:'Mưa rào to'},
85:{d:'🌨️',n:'🌨️',t:'Mưa tuyết nhẹ'},86:{d:'❄️',n:'❄️',t:'Mưa tuyết to'},
95:{d:'⛈️',n:'⛈️',t:'Dông'},96:{d:'⛈️🌩️',n:'⛈️🌩️',t:'Dông có mưa đá'},99:{d:'⛈️🌩️',n:'⛈️🌩️',t:'Dông kèm mưa đá to'}};
const degToDir=(deg)=>['Bắc','Bắc-Đông Bắc','Đông Bắc','Đông-Đông Bắc','Đông','Đông-Đông Nam','Đông Nam','Nam-Đông Nam','Nam','Nam-Tây Nam','Tây Nam','Tây-Tây Nam','Tây','Tây-Tây Bắc','Tây Bắc','Bắc-Tây Bắc'][Math.round(((deg%360)/22.5))%16];
const toUnix = (iso)=> Math.floor(new Date(iso).getTime()/1000);
const fmtDay = (iso) => { const d = new Date(iso); const wd = ['CN','T2','T3','T4','T5','T6','T7'][d.getDay()]; return `${wd} ${d.getDate()}/${d.getMonth()+1}`; };

// ------------------- Gemini + Guess -------------------
const guessGames = new Map();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ------------------- MUSIC core (YouTube + SoundCloud) -------------------
const music = new Map(); // gid -> { connection, player, volume, queue: [], now: {title,url,by} }
function getQ(gid){
  if(!music.has(gid)) music.set(gid,{ connection:null, player:null, volume:1, queue:[], now:null });
  return music.get(gid);
}

// >>> ensureConnected: đợi READY + xử lý Stage + logs
async function ensureConnected(interaction){
  const q = getQ(interaction.guildId);
  const vc = interaction.member?.voice?.channel;
  if (!vc) throw new Error('Bạn cần vào kênh thoại trước.');

  // Dùng lại nếu đã có sẵn
  if (q.connection && q.player) return q;

  // Kết nối
  q.connection = joinVoiceChannel({
    channelId: vc.id,
    guildId: vc.guild.id,
    adapterCreator: vc.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  // Đợi READY tối đa 30s
  await entersState(q.connection, VoiceConnectionStatus.Ready, 30_000).catch(err => {
    try { q.connection.destroy(); } catch {}
    throw new Error('Không kết nối voice được: ' + (err?.message || err));
  });

  // Tạo player & subscribe
  q.player = createAudioPlayer({ behaviors:{ noSubscriber: NoSubscriberBehavior.Pause }});
  q.connection.subscribe(q.player);

  // Nếu là Stage Channel: bỏ suppressed để bot có tiếng
  if (vc.type === ChannelType.GuildStageVoice) {
    try {
      const me = await vc.guild.members.fetchMe();
      if (me?.voice?.suppressed) await me.voice.setSuppressed(false);
    } catch {}
  }

  // Logs chẩn đoán (gộp gọn, tránh đăng ký trùng)
q.player.on('stateChange', (oldState, newState) => {
  console.log('🎧 Player:', oldState.status, '->', newState.status);
});

// Khi player phát xong (Idle) thì tự qua bài kế tiếp
// ⚠️ Nếu vừa tua (seek) thì bỏ qua lần Idle phát sinh do .stop()
q.player.on(AudioPlayerStatus.Idle, () => {
  if (q.seeking) {        // flag được set trong lệnh /seek
    q.seeking = false;    // reset để lần Idle sau hoạt động bình thường
    return;
  }
  try { playNext(interaction.guildId); } catch (e) { console.error(e); }
});
// Nếu player lỗi thì cũng nhảy tiếp bài
q.player.on('error', (err) => {
  console.error('Player error:', err);
  try { playNext(interaction.guildId); } catch (e) { console.error('Error→playNext error:', e); }
});

// Log trạng thái connection & dọn dẹp khi rớt kết nối
q.connection.on('stateChange', (oldState, newState) => {
  console.log('🔌 Conn:', oldState.status, '->', newState.status);

  // Nếu bị disconnect thì hủy connection và xóa queue của guild
  if (newState.status === VoiceConnectionStatus.Disconnected) {
    try { q.connection.destroy(); } catch {}
    music.delete(interaction.guildId);
  }
});

return q;
}

function isSCAuthError(err) {
  const m = (err?.message || String(err)).toLowerCase();
  return m.includes('soundcloud') || m.includes('client id') || m.includes('401') || m.includes('403') || m.includes('429');
}
async function refreshSCClientID(tag = '') {
  try {
    const id = await play.getFreeClientID();
    if (id) {
      play.setToken({ soundcloud: { client_id: id } });
      console.log(`🔄 Refreshed SC client_id ${tag?`(${tag})`:''}: ${id.slice(0, 12)}…`);
      return id;
    }
  } catch (e) { console.warn('⚠️ refresh SC id error:', e?.message || e); }
  return null;
}
async function scSearchTracks(term, limit = 5) {
  try {
    return await play.search(term, { limit, source: { soundcloud: 'tracks' } });
  } catch (e) {
    if (isSCAuthError(e)) {
      await refreshSCClientID('search');
      return await play.search(term, { limit, source: { soundcloud: 'tracks' } });
    }
    throw e;
  }
}
// >>> makeResource: retry khi SC client_id hết hạn
async function makeResource(url, vol=1){
  try {
    const s = await play.stream(url, { quality: 2, discordPlayerCompatibility: true });
    const res = createAudioResource(s.stream, { inputType: s.type, inlineVolume: true });
    res.volume.setVolume(vol);
    return res;
  } catch (e) {
    if (/soundcloud\.com/i.test(url) && isSCAuthError(e)) {
      console.warn('🔁 stream retry (SoundCloud):', e?.message || e);
      await refreshSCClientID('stream');
      const s2 = await play.stream(url, { quality: 2, discordPlayerCompatibility: true });
      const res2 = createAudioResource(s2.stream, { inputType: s2.type, inlineVolume: true });
      res2.volume.setVolume(vol);
      return res2;
    }
    throw e;
  }
}
async function playNext(gid){
  const q = getQ(gid);
  const track = q.queue.shift();
  if (!track) { q.now = null; return; }
  try {
    const res = await makeResource(track.url, q.volume);
    q.now = track;
    q.player.play(res);
  } catch (e) {
    console.error('makeResource failed:', e);
    return playNext(gid); // skip broken
  }
}

// ------------------- SC search cache + pagination store -------------------
const scSearchCache = new Map(); // key: termLower -> { time: ms, results: [...] }
const SC_CACHE_TTL = 5 * 60 * 1000; // 5 phút
const SC_PAGE_SIZE = 5;
const scSearchStore = new Map();       // nonce -> {authorId, results:[], time}
const SC_STORE_TTL = 10 * 60 * 1000;   // 10 phút

function parseTimeToSec(x) {
  if (!x && x !== 0) return null;
  if (typeof x === 'number' && isFinite(x)) return x > 3600000 ? Math.round(x / 1000) : Math.round(x);
  const s = String(x).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(':').map(v => parseInt(v, 10));
  if (parts.some(isNaN)) return null;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}
function fmtDur(sec) {
  if (sec == null) return '';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}
function fmtCompact(n) {
  if (n == null) return '';
  let num = Number(n);
  if (!Number.isFinite(num)) return '';
  const units = ['', 'K', 'M', 'B', 'T'];
  let i = 0; while (num >= 1000 && i < units.length - 1) { num /= 1000; i++; }
  const val = (i === 0) ? Math.round(num).toString() : (num >= 10 ? Math.round(num).toString() : num.toFixed(1));
  return `${val}${units[i]}`;
}
function pickNum(...vals) {
  for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n >= 0) return Math.round(n); }
  return null;
}
function pickUploader(r) {
  return (
    r?.user?.name || r?.user?.username ||
    r?.channel?.name ||
    r?.publisher?.artist || r?.publisher?.name || r?.publisher?.username ||
    r?.uploader?.name || r?.uploader ||
    'SoundCloud'
  );
}
function pickCover(r) {
  return (
    r?.thumbnail?.url || r?.thumbnail ||
    r?.thumbnails?.[0]?.url ||
    r?.artwork_url || r?.artworkUrl ||
    r?.image?.url || null
  );
}
// Lấy meta chi tiết 1 bài (artist/bpm/duration/cover/plays/likes)
async function scGetMeta(url) {
  try {
    const info = await play.soundcloud(url);
    const cover = pickCover(info);
    const artist = info?.publisher?.artist || info?.user?.username || info?.user?.name || null;
    const bpm = info?.bpm ?? info?.publisher?.bpm ?? null;
    const durationSec =
      parseTimeToSec(
        info?.durationInSec ?? info?.duration ?? info?.duration_ms ??
        info?.duration_raw ?? info?.duration?.ms ?? info?.duration?.seconds
      );
    const plays = pickNum(
      info?.playCount, info?.plays, info?.play_count,
      info?.playbackCount, info?.playback_count,
      info?.raw?.playback_count, info?.raw?.track?.playback_count,
      info?.stats?.playback_count, info?.stats?.playCount
    );
    const likes = pickNum(
      info?.likes, info?.likesCount, info?.likes_count,
      info?.favoritings_count, info?.favorites_count,
      info?.raw?.likes_count, info?.raw?.track?.likes_count,
      info?.stats?.likes_count, info?.user_favorite_count
    );
    return { cover, artist, bpm, durationSec, plays, likes };
  } catch (e) {
    if (isSCAuthError(e)) {
      await refreshSCClientID('meta');
      try { return await scGetMeta(url); } catch {}
    }
    return {};
  }
}

// ====== HIỂN THỊ 5 ẢNH: renderSCPage gửi 5 embeds (mỗi kết quả 1 embed)
async function renderSCPage(nonce, page) {
  const store = scSearchStore.get(nonce);
  if (!store) throw new Error('Hết hạn kết quả.');
  const total = store.results.length;
  const totalPages = Math.max(1, Math.ceil(total / SC_PAGE_SIZE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const start = page * SC_PAGE_SIZE;
  const slice = store.results.slice(start, start + SC_PAGE_SIZE);

  // enrich meta cho 5 bài hiển thị
  await Promise.all(slice.map(async (it) => {
    if (it._enriched) return;
    const meta = await scGetMeta(it.url);
    if (!it.desc && meta.artist) it.desc = String(meta.artist);
    if (!it.cover && meta.cover) it.cover = meta.cover;
    it.durationSec ??= meta.durationSec ?? null;
    it.bpm ??= meta.bpm ?? null;
    it.plays ??= meta.plays ?? null;
    it.likes ??= meta.likes ?? null;
    it._enriched = true;
  }));

  // Dữ liệu cho menu (<=100 ký tự) & embed (đầy đủ)
  const views = slice.map(r => {
    const bitsArr = [
      String(r.desc || 'SoundCloud'),
      r.bpm ? `${r.bpm} BPM` : null,
      r.durationSec != null ? fmtDur(r.durationSec) : null,
      (r.plays != null) ? `▶ ${fmtCompact(r.plays)}` : null,
      (r.likes != null) ? `❤ ${fmtCompact(r.likes)}` : null,
    ].filter(Boolean);

    const descEmbed = bitsArr.join(' • ');
    const descMenu  = descEmbed.slice(0, 100);

    return {
      label: String(r.title).slice(0, 100),
      value: r.url,
      descMenu,
      descEmbed,
    };
  });

  // Select menu
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`sc_select|${store.authorId}|${nonce}`)
    .setPlaceholder(`Chọn 1 bài để phát 🎧 (${page+1}/${totalPages})`)
    .addOptions(views.map(v => ({ label: v.label, value: v.value, description: v.descMenu })));
  const rowMenu = new ActionRowBuilder().addComponents(menu);

  // Nút phân trang
  const btnPrev = new ButtonBuilder()
    .setCustomId(`sc_page|${store.authorId}|${nonce}|${page-1}`)
    .setLabel('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page<=0);
  const btnNext = new ButtonBuilder()
    .setCustomId(`sc_page|${store.authorId}|${nonce}|${page+1}`)
    .setLabel('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page>=totalPages-1);
  const rowPager = new ActionRowBuilder().addComponents(btnPrev, btnNext);

  // 5 EMBEDS — mỗi embed một kết quả + thumbnail riêng
  const embeds = views.map((v, i) => {
    const e = new EmbedBuilder()
      .setTitle(`**${start + i + 1}.** ${v.label}`)
      .setDescription(v.descEmbed || '—')
      .setColor(0xff5500)
      .setFooter({ text: `Cache 5 phút • Trang ${page+1}/${totalPages}` });
    const thumb = slice[i]?.cover || store.results[start + i]?.cover;
    if (thumb) e.setThumbnail(String(thumb));
    return e;
  });

  return { embeds, components: [rowMenu, rowPager] };
}

// ------------------- command list -------------------
const commands = [
  new SlashCommandBuilder().setName('uptime').setDescription('Xem thời gian bot online, ping, RAM/CPU'),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Xem thông tin máy chủ hiện tại'),
  new SlashCommandBuilder()
    .setName('setwelcome')
    .setDescription('Bật chào mừng & chọn kênh')
    .addChannelOption(o=>o.setName('channel').setDescription('Kênh chào mừng').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
    .addStringOption(o=>o.setName('message').setDescription('Thông điệp (hỗ trợ {user}, {server}, {count})')),
  new SlashCommandBuilder().setName('disablewelcome').setDescription('Tắt thông báo chào mừng (chỉ admin)'),
  new SlashCommandBuilder().setName('testwelcome').setDescription('Gửi thử thông báo chào mừng (chỉ admin)'),
  new SlashCommandBuilder().setName('roll').setDescription('Xúc xắc n-mặt (mặc định 6)').addIntegerOption(o=>o.setName('faces').setDescription('Số mặt (2-1000)').setMinValue(2).setMaxValue(1000)),
  new SlashCommandBuilder().setName('8ball').setDescription('Hỏi tôi điều gì đó, tôi sẽ tiên tri 😎').addStringOption(o=>o.setName('question').setDescription('Câu hỏi của bạn').setRequired(true)),
  new SlashCommandBuilder().setName('avatar').setDescription('Lấy avatar của một user').addUserOption(o=>o.setName('user').setDescription('Chọn user')),
  new SlashCommandBuilder().setName('purge').setDescription('Xóa nhanh n tin nhắn (quyền Manage Messages)').addIntegerOption(o=>o.setName('count').setDescription('Số tin (2-100)').setRequired(true)),
  new SlashCommandBuilder().setName('meme').setDescription('Lấy meme ngẫu nhiên từ Reddit'),
  new SlashCommandBuilder().setName('profile').setDescription('Xem thông tin của bạn hoặc người khác').addUserOption(o=>o.setName('user').setDescription('Chọn user')),
  new SlashCommandBuilder().setName('guess').setDescription('Chơi đoán số 1-100').addIntegerOption(o=>o.setName('number').setDescription('Số bạn đoán (1-100)').setRequired(true)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Bảng xếp hạng đoán số của server'),
  new SlashCommandBuilder().setName('resetwins').setDescription('Reset bảng xếp hạng đoán số (chỉ admin)'),
  new SlashCommandBuilder().setName('help').setDescription('Xem tất cả lệnh của bot và cách sử dụng'),
  new SlashCommandBuilder().setName('gemini').setDescription('Hỏi AI Gemini').addStringOption(o=>o.setName('prompt').setDescription('Câu hỏi / yêu cầu').setRequired(true)),
  new SlashCommandBuilder()
    .setName('weather')
    .setDescription('Thời tiết hiện tại và dự báo')
    .addStringOption(o=>o.setName('location').setDescription('Thành phố, quốc gia…').setRequired(true))
    .addStringOption(o=>o.setName('units').setDescription('Đơn vị').addChoices({name:'°C, km/h',value:'metric'},{name:'°F, mph',value:'imperial'}))
    .addIntegerOption(o=>o.setName('days').setDescription('Số ngày dự báo').addChoices({name:'Hôm nay (1)',value:1},{name:'3 ngày',value:3},{name:'7 ngày',value:7})),
  new SlashCommandBuilder()
    .setName('ship')
    .setDescription('Ghép đôi vui vẻ giữa 2 người')
    .addUserOption(o=>o.setName('user1').setDescription('Người thứ nhất'))
    .addUserOption(o=>o.setName('user2').setDescription('Người thứ hai')),
  new SlashCommandBuilder()
    .setName('sendnoti')
    .setDescription('Gửi thông báo (admin) — có xác nhận trước khi gửi')
    .addStringOption(o=>o.setName('content').setDescription('Nội dung thông báo').setRequired(true))
    .addStringOption(o=>o.setName('title').setDescription('Tiêu đề (tuỳ chọn)'))
    .addAttachmentOption(o=>o.setName('image').setDescription('Ảnh đính kèm (tuỳ chọn)'))
    .addStringOption(o=>o.setName('scope').setDescription('Phạm vi gửi').addChoices(
      {name:'Chỉ server này', value:'here'},
      {name:'Tất cả server bot đang ở', value:'all'}
    ))
    .addStringOption(o=>o.setName('mention').setDescription('Ping khi gửi').addChoices(
      {name:'Không ping', value:'none'},{name:'@here', value:'here'},{name:'@everyone', value:'everyone'}
    ))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('invite').setDescription('Lấy link mời bot vào server'),

  // MUSIC (YouTube)
  new SlashCommandBuilder().setName('join').setDescription('Cho bot vào kênh thoại hiện tại'),
  new SlashCommandBuilder().setName('play').setDescription('Phát nhạc YouTube (link/keyword)').addStringOption(o=>o.setName('query').setDescription('Link hoặc từ khóa YouTube').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Bỏ qua bài hiện tại'),
  new SlashCommandBuilder().setName('stop').setDescription('Dừng và rời kênh'),
  new SlashCommandBuilder().setName('pause').setDescription('Tạm dừng'),
  new SlashCommandBuilder().setName('resume').setDescription('Tiếp tục phát'),
  new SlashCommandBuilder().setName('np').setDescription('Bài đang phát'),
  new SlashCommandBuilder().setName('queue').setDescription('Xem hàng đợi'),
  new SlashCommandBuilder().setName('volume').setDescription('Đặt âm lượng (0–200%)').addIntegerOption(o=>o.setName('percent').setDescription('0–200').setRequired(true)),
  new SlashCommandBuilder().setName('seek').setDescription('Tua bài nhạc hiện tại đến vị trí (tính bằng giây).').addIntegerOption(opt =>opt.setName('seconds').setDescription('Số giây cần tua đến').setRequired(true)),

  // MUSIC (SoundCloud)
  new SlashCommandBuilder()
    .setName('playsc')
    .setDescription('Phát nhạc SoundCloud (link hoặc tìm kiếm & chọn bài)')
    .addStringOption(o=>o.setName('query').setDescription('Link SoundCloud hoặc từ khóa').setRequired(true)),

  new SlashCommandBuilder().setName('botstats').setDescription('Thông tin bot & hệ thống'),

  new SlashCommandBuilder()
    .setName('translate')
    .setDescription('Dịch văn bản giữa các ngôn ngữ')
    .addStringOption(o=>o.setName('text').setDescription('Nội dung cần dịch').setRequired(true))
    .addStringOption(o=>o.setName('to').setDescription('Ngôn ngữ đích (vd: en, vi, ja, ko, zh-CN)').setRequired(false))
    .addStringOption(o=>o.setName('from').setDescription('Ngôn ngữ nguồn (để trống để tự nhận diện)').setRequired(false)),

    new SlashCommandBuilder().setName('quiz').setDescription('Đố vui trắc nghiệm 4 đáp án'),

  new SlashCommandBuilder()
    .setName('coin')
    .setDescription('Ví coin ảo vui vẻ')
    .addSubcommand(s=>s.setName('balance').setDescription('Xem số dư').addUserOption(o=>o.setName('user').setDescription('Người dùng')))
    .addSubcommand(s=>s.setName('daily').setDescription('Nhận thưởng mỗi ngày'))
    .addSubcommand(s=>s.setName('give').setDescription('Admin tặng coin').addUserOption(o=>o.setName('user').setDescription('Người nhận').setRequired(true)).addIntegerOption(o=>o.setName('amount').setDescription('Số coin').setRequired(true))),

  new SlashCommandBuilder()
    .setName('taixiu')
    .setDescription('Mini-game Tài Xỉu (coin ảo)')
    .addSubcommand(s=>s.setName('start').setDescription('Bắt đầu ván mới').addIntegerOption(o=>o.setName('thoigian').setDescription('Thời gian đặt cược (giây)').setMinValue(10)).addIntegerOption(o=>o.setName('min').setDescription('Cược tối thiểu').setMinValue(1)).addIntegerOption(o=>o.setName('max').setDescription('Cược tối đa').setMinValue(1)))
    .addSubcommand(s=>s.setName('status').setDescription('Xem tình trạng ván'))
    .addSubcommand(s=>s.setName('cancel').setDescription('Hủy ván hiện tại (admin)')),

  new SlashCommandBuilder()
    .setName('tiktok')
    .setDescription('Tải video TikTok từ link')
    .addStringOption(o =>
    o.setName('url')
    .setDescription('Dán link TikTok vào đây')
    .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('tiktokauto')
    .setDescription('Bật/tắt chế độ tự động xử lý link TikTok trong server/kênh')
    .addStringOption(o =>
    o.setName('mode')
    .setDescription('Chọn chế độ auto')
    .setRequired(true)
    .addChoices(
    { name: 'off (tắt)', value: 'off' },
    { name: 'server (toàn server)', value: 'server' },
    { name: 'channel (chỉ kênh hiện tại)', value: 'channel' }
        )
    ),

new SlashCommandBuilder()
  .setName('fb')
  .setDescription('Tải video/ảnh Facebook (public)')
  .addStringOption(o =>
    o.setName('url')
     .setDescription('Dán link Facebook vào đây')
     .setRequired(true)
  ),

new SlashCommandBuilder()
  .setName('fbauto')
  .setDescription('Bật/tắt chế độ tự động xử lý link Facebook trong server/kênh')
  .addStringOption(o =>
    o.setName('mode')
      .setDescription('Chọn chế độ auto')
      .setRequired(true)
      .addChoices(
        { name: 'off (tắt)', value: 'off' },
        { name: 'server (toàn server)', value: 'server' },
        { name: 'channel (chỉ kênh hiện tại)', value: 'channel' },
      )
  ),
  
new SlashCommandBuilder()
  .setName('insta')
  .setDescription('Tải ảnh/video Instagram (post, reel, photo)')
  .addStringOption(o =>
    o.setName('url')
     .setDescription('Dán link Instagram vào đây')
     .setRequired(true)
  ),

new SlashCommandBuilder()
  .setName('instaauto')
  .setDescription('Bật/tắt chế độ tự động xử lý link Instagram trong server/kênh')
  .addStringOption(o =>
    o.setName('mode')
     .setDescription('Chọn chế độ auto')
     .addChoices(
       { name: 'off (tắt)', value: 'off' },
       { name: 'server (toàn server)', value: 'server' },
       { name: 'channel (chỉ kênh hiện tại)', value: 'channel' },
     )
     .setRequired(true)
  ),
    
  // === /tiktokinfo ===
new SlashCommandBuilder()
  .setName('tiktokinfo')
  .setDescription('Xem thông tin hồ sơ TikTok theo username')
  .addStringOption(o =>
    o.setName('username')
     .setDescription('Username TikTok (bỏ @ cũng được), ví dụ: tiktok')
     .setRequired(true)
  ),

  new SlashCommandBuilder()
  .setName('news')
  .setDescription('Xem tin nhanh từ Google News')
  .addStringOption(o =>
    o.setName('q')
     .setDescription('Từ khoá / chủ đề (bỏ trống để lấy tin mới nhất)')
     .setRequired(false))
  .addIntegerOption(o =>
    o.setName('limit')
     .setDescription('Số bài (1-5)')
     .setMinValue(1)
     .setMaxValue(5)
  ),

  new SlashCommandBuilder()
  .setName('rpsls')
  .setDescription('Giải đấu Kéo–Búa–Bao–Thằn lằn–Spock')
  .addSubcommand(s=>s
    .setName('start')
    .setDescription('Mở đăng ký giải đấu')
    .addIntegerOption(o=>o.setName('slots').setDescription('Số người (4/8/16)').addChoices(
      { name:'4', value:4 }, { name:'8', value:8 }, { name:'16', value:16 }
    ).setRequired(true))
    .addIntegerOption(o=>o.setName('entryfee').setDescription('Phí tham gia (coin)'))
    .addIntegerOption(o=>o.setName('reward').setDescription('Giải thưởng thêm (coin)'))
  )
  .addSubcommand(s=>s.setName('join').setDescription('Tham gia giải đang mở đăng ký'))
  .addSubcommand(s=>s.setName('status').setDescription('Xem tình trạng giải'))
  .addSubcommand(s=>s.setName('cancel').setDescription('Huỷ giải (chỉ admin)')),

new SlashCommandBuilder()
  .setName('capcut')
  .setDescription('Tải video từ link CapCut')
  .addStringOption(o =>
    o.setName('url')
     .setDescription('Link CapCut cần tải')
     .setRequired(true)
  ),

new SlashCommandBuilder()
  .setName('capcutauto')
  .setDescription('Bật/tắt tự động xử lý link CapCut trong server/kênh')
  .addStringOption(o =>
    o.setName('mode')
     .setDescription('Chế độ')
     .addChoices(
       { name: 'off (tắt)', value: 'off' },
       { name: 'server (toàn server)', value: 'server' },
       { name: 'channel (chỉ kênh hiện tại)', value: 'channel' },
     )
     .setRequired(true)
  ),  
].map(c=>c.toJSON());

// ------------------- register guild commands -------------------
const GUILD_IDS = ['1403572945389097050','1329819713450278952','1405161470055940186'];
async function registerCommandsForGuilds(){
  const rest = new REST({ version:'10' }).setToken(process.env.TOKEN);
  try { await rest.put(Routes.applicationCommands(client.user.id), { body: [] }); } catch(e){ console.warn('clear global failed:', e?.message); }
  for (const gid of GUILD_IDS) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: commands });
      console.log(`✅ Registered for guild ${gid}`);
    } catch (e) {
      console.error(`❌ Register failed for guild ${gid}:`, e?.message);
    }
  }
}
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await loadAll();
  await registerCommandsForGuilds();
  await loadBadges().catch(()=>{});
});

// ====== TÀI XỈU: state theo guild + helpers =====
const taiXiuState = new Map(); // guildId -> state

const TX = {
  // gieo 3 xúc xắc
  roll() {
    const d = [1,2,3].map(() => 1 + Math.floor(Math.random() * 6));
    const sum = d[0] + d[1] + d[2];
    const triple = (d[0] === d[1] && d[1] === d[2]);
    const side = triple ? 'house' : (sum >= 11 ? 'tai' : 'xiu');
    return { dice: d, sum, triple, side };
  },

  // định dạng số VN
  fmt(n) { return Number(n || 0).toLocaleString('vi-VN'); },

  // thời gian HH:mm:ss
  now() { 
    return new Date().toLocaleTimeString('vi-VN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }); 
  },

  // render Embed chính của phiên
  render(gid) {
    const s = taiXiuState.get(gid);
    const left = Math.max(0, Math.ceil((s.endsAt - Date.now()) / 1000));

    // chuẩn bị dữ liệu
    const listTai = [...(s.bets?.values() ?? [])].filter(b => b.side === 'tai');
    const listXiu = [...(s.bets?.values() ?? [])].filter(b => b.side === 'xiu');
    const sum = arr => arr.reduce((a, b) => a + (Number(b.amount) || 0), 0);

    // trả về Embed
    return new EmbedBuilder()
      .setTitle('🎲 Tài Xỉu CLB – Mini Game')
      .setColor(0x00bfff)
      .setDescription(`⏱️ **Còn lại:** **${left}** giây\n👑 **Người làm cái:** ${s.dealerId ? `<@${s.dealerId}>` : 'Chưa có'}`)
      .addFields(
        { name: '🔵 Tài', value: `Người cược: **${listTai.length}**\nTổng: **${this.fmt(sum(listTai))}** coin`, inline: false },
        { name: '🔴 Xỉu', value: `Người cược: **${listXiu.length}**\nTổng: **${this.fmt(sum(listXiu))}** coin`, inline: false },
      )
      .setFooter({ text: `Phiên #${s.roundId} • ${this.now()}` });
  },

  // hàng nút khi đang mở cược
  row(roundId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tx_bet_tai_${roundId}`).setStyle(ButtonStyle.Primary).setLabel('💙 Đặt TÀI'),
      new ButtonBuilder().setCustomId(`tx_bet_xiu_${roundId}`).setStyle(ButtonStyle.Danger ).setLabel('❤️ Đặt XỈU'),
      new ButtonBuilder().setCustomId(`tx_dealer_${roundId}`).setStyle(ButtonStyle.Secondary).setLabel('👑 Làm Cái'),
    );
  },

  // hàng nút khi đã khoá cược (hiện chữ “🔒 …”)
  rowDisabled(roundId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tx_lock_tai_${roundId}`).setStyle(ButtonStyle.Secondary).setLabel('🔒 Đặt Tài'),
      new ButtonBuilder().setCustomId(`tx_lock_xiu_${roundId}`).setStyle(ButtonStyle.Secondary).setLabel('🔒 Đặt Xỉu'),
      new ButtonBuilder().setCustomId(`tx_lock_dealer_${roundId}`).setStyle(ButtonStyle.Secondary).setLabel('🔒 Làm Cái'),
    );
  },
};

function rpsButtons(tid, round){
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_rock`).setLabel('Đá').setEmoji('🪨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_paper`).setLabel('Bao').setEmoji('📄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_scissors`).setLabel('Kéo').setEmoji('✂️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_lizard`).setLabel('Thằn lằn').setEmoji('🦎').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rps_play_${tid}_${round}_spock`).setLabel('Spock').setEmoji('🖖').setStyle(ButtonStyle.Secondary),
  );
  return [row];
}
function lobbyButtons(tid){
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rps_join_${tid}`).setLabel('Tham gia').setEmoji('🙋').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rps_leave_${tid}`).setLabel('Rút').setEmoji('🏃').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`rps_start_${tid}`).setLabel('Bắt đầu').setEmoji('🚀').setStyle(ButtonStyle.Primary),
    )
  ];
}

// ------------------- buttons / select menus -------------------
const sendnotiTemp = new Map();

 // ----- Buttons handler (một listener duy nhất) -----
client.on(Events.InteractionCreate, async (interaction) => {
  // Guard cho button
  const isBtn = typeof interaction.isButton === 'function' && interaction.isButton();
  const id = isBtn ? String(interaction.customId || '') : '';
  console.log('Interaction type:', interaction.type, 'customId:', interaction.customId);
  
  // ===== TÀI XỈU =====
if (isBtn && id.startsWith('tx_')) {
  const parts = id.split('_');              // ["tx","bet|dealer","<roundId>"] hoặc ["tx","bet","tai|xiu","<roundId>"]
  const action = parts[1];
  const roundId = action === 'bet' ? parts[3] : parts[2];
  const s = taiXiuState.get(interaction.guildId);

  if (!s || String(s.roundId) !== String(roundId)) {
    await interaction.reply({ content:'⚠️ Phiên đã kết thúc hoặc không tồn tại.', ephemeral:true });
    return;
  }
  if (s.locked) {
    await interaction.reply({ content:'⛔ Đã khoá đặt cược, vui lòng chờ kết quả!', ephemeral:true });
    return;
  }

  if (action === 'dealer') {
    s.dealerId = interaction.user.id;
    await interaction.update({ embeds:[TX.render(interaction.guildId)], components:[TX.row(s.roundId)] });
    return;
  }

    if (action === 'bet') {
  // LẤY side TỪ customId: tx_bet_<side>_<roundId>
  const side = parts[2];              // 'tai' | 'xiu'
  const roundId = parts[3];

  const modal = new ModalBuilder()
    .setCustomId(`tx_modal_${side}_${roundId}`)        // <-- dùng side ở đây
    .setTitle(side === 'tai' ? '🎲 ĐẶT TÀI!' : '🎲 ĐẶT XỈU!')  // <-- và ở đây
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Nhập số coin muốn cược')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('ví dụ: 1000')
          .setRequired(true)
      )
    );
  await interaction.showModal(modal);
  return;
}
  // ==== Modal TÀI/XỈU ====
if (interaction.isModalSubmit() && interaction.customId.startsWith('tx_modal_')) {
  // customId: tx_modal_<side>_<roundId>
  const [, , side, rid] = interaction.customId.split('_');

  const gid = interaction.guildId;
  const s   = taiXiuState.get(gid);
  if (!s || String(s.roundId) !== String(rid)) {
    return interaction.reply({ content:'⚠️ Phiên không tồn tại hoặc đã kết thúc.', ephemeral:true });
  }
  if (s.locked) {
    return interaction.reply({ content:'⛔ Đã khoá đặt cược, vui lòng chờ kết quả.', ephemeral:true });
  }

  const raw = interaction.fields.getTextInputValue('amount') || '0';
  const amount = Math.floor(Number(String(raw).replace(/[_.\s]/g,'')) || 0);
  if (amount < s.min || amount > s.max) {
    return interaction.reply({
      content:`⚠️ Giới hạn: ${s.min.toLocaleString('vi-VN')} – ${s.max.toLocaleString('vi-VN')} coin.`,
      ephemeral:true
    });
  }

  // Ví tiền (nếu có)
  if (typeof getBal === 'function' && typeof addBal === 'function') {
    const bal = getBal(interaction.user.id) || 0;
    if (bal < amount) {
      return interaction.reply({ content:'💸 Không đủ coin.', ephemeral:true });
    }
    addBal(interaction.user.id, -amount);
  }

  // Lưu cược
  s.bets ??= new Map();
  const prev = s.bets.get(interaction.user.id) || { side, amount: 0 };
  s.bets.set(interaction.user.id, { side, amount: (prev.side === side ? prev.amount : 0) + amount });

  // Cập nhật message chính ngay lập tức
  try {
    await ch.messages.edit(s.msgId, { embeds: [TX.render(gid)], components: [TX.row(s.roundId)] });
  } catch (e) {
    console.error('[TX] update after bet failed:', e);
  }

  return interaction.reply({
    content:`✅ Đặt **${amount.toLocaleString('vi-VN')}** coin cho **${side.toUpperCase()}** thành công!`,
    ephemeral:true
  });
}
  }
// ===== RPSLS buttons =====
if (isBtn && id.startsWith('rps_')) {
  // Log khi bấm nút
  console.log('[RPSLS] click:', id, 'at', new Date().toISOString());

  // ACK NGAY để tránh timeout 3s
  const t0 = Date.now();
  let acked = false;
  try {
    await interaction.deferReply({ ephemeral: true });
    acked = true;
    console.log('[RPSLS] deferReply OK in', Date.now() - t0, 'ms');
  } catch (e) {
    console.error('[RPSLS] deferReply FAILED:', e);
    return; // không ACK được thì dừng, tránh lỗi tiếp
  }

  try {
    const gid = interaction.guildId;
    const st  = rpslsState.get(gid);

    if (!st) {
      await interaction.editReply({ content: '⚠️ Không có giải.' });
      return;
    }
const pid = st.currentPair ? `${st.round}-${st.currentPair.a}-${st.currentPair.b}` : null;
if (pid && st.resolvedPairs?.has(pid)) {
  await interaction.editReply({ content: '⏳ Cặp này đã được xử lý, vui lòng chờ round mới.' });
  return;
}
    
    // JOIN
    if (id.startsWith('rps_join_')) {
      if (st.started) { await interaction.editReply({ content: 'Đã bắt đầu.' }); return; }
      if (st.players.includes(interaction.user.id)) { await interaction.editReply({ content: 'Bạn đã tham gia.' }); return; }
      if (st.players.length >= st.slots) { await interaction.editReply({ content: '❌ Đủ slot.' }); return; }
      if (st.fee > 0 && typeof getBal === 'function' && getBal(interaction.user.id) < st.fee) {
        await interaction.editReply({ content: '💸 Không đủ coin.' }); return;
      }
      if (st.fee > 0 && typeof addBal === 'function') addBal(interaction.user.id, -st.fee);
      st.players.push(interaction.user.id);

      await updateLobby(interaction, st).catch(console.error);
      await interaction.editReply({ content: '✅ Đã tham gia!' });
      return;
    }

    // LEAVE
    if (id.startsWith('rps_leave_')) {
      if (st.started) { await interaction.editReply({ content: 'Đã bắt đầu.' }); return; }
      const i = st.players.indexOf(interaction.user.id);
      if (i >= 0) st.players.splice(i, 1);
      await updateLobby(interaction, st).catch(console.error);
      await interaction.editReply({ content: '🏃 Đã rút.' });
      return;
    }

    // START
    if (id.startsWith('rps_start_')) {
      const isHostOrAdmin = (interaction.user.id === st.host) ||
        interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
      if (!isHostOrAdmin) { await interaction.editReply({ content: '❌ Chỉ host/admin.' }); return; }
      if (st.players.length < 2) { await interaction.editReply({ content: '⚠️ Cần ít nhất 2 người.' }); return; }

      await interaction.editReply({ content: '🚀 Bắt đầu!' });
      return startTournament(interaction.client, st);
    }

   // PLAY
if (id.startsWith('rps_play_')) {
  // id format: rps_play_<tid>_<round>_<move>
  const parts = id.split('_');
  const tid   = parts[2];
  const round = Number(parts[3]) || 0;
  const move  = parts[4]; // rock|paper|scissors|lizard|spock

  const gid = interaction.guildId;
  const st  = rpslsState.get(gid);

  if (!st || !st.started || st.tid !== tid || st.round !== round) {
    await interaction.editReply({ content: '⚠️ Round khác hoặc giải đã kết thúc.' });
    return;
  }

  const pair = st.currentPair;
  if (!pair || (pair.a !== interaction.user.id && pair.b !== interaction.user.id)) {
    await interaction.editReply({ content: '❌ Chưa tới lượt bạn.' });
    return;
  }

  if (!RPS.moves.includes(move)) {
    await interaction.editReply({ content: '❌ Nước đi không hợp lệ.' });
    return;
  }

  const key = `${round}-${interaction.user.id}`;
  if (st.moves.has(key)) {
    await interaction.editReply({ content: '⏳ Bạn đã chọn rồi.' });
    return;
  }

  st.moves.set(key, move);
  await interaction.editReply({ content: `Bạn đã chọn **${RPS.emoji(move)}**.` });

  // Kiểm tra đủ 2 nước đi
  const aMove = st.moves.get(`${round}-${pair.a}`);
  const bMove = st.moves.get(`${round}-${pair.b}`);
  if (!aMove || !bMove) return;

  // Quyết định thắng/thua/hòa
  let winner = null;
  const w = RPS.win(aMove, bMove); // 1: a thắng, -1: b thắng, 0: hòa
  const ch = await interaction.client.channels.fetch(st.channelId);

  if (w === 0) {
    await ch.send(`**Round ${round}**: hòa (${RPS.emoji(aMove)} vs ${RPS.emoji(bMove)}) → chọn lại!`);
    st.moves.delete(`${round}-${pair.a}`);
    st.moves.delete(`${round}-${pair.b}`);
    await ch.send({
      content: `<@${pair.a}> vs <@${pair.b}> — chọn nước đi!`,
      components: [ rpsPlayRow(st.tid, round) ],
    });
    return;
  } else {
    winner = (w === 1) ? pair.a : pair.b;
    await ch.send(
      `**Round ${round}**: <@${pair.a}> (${RPS.emoji(aMove)}) vs <@${pair.b}> (${RPS.emoji(bMove)}) → **<@${winner}> thắng**!`
    );
    st.winners.push(winner);
    if (pid) st.resolvedPairs.add(pid);
  }

  // Sang cặp tiếp theo trong cùng round
  st.currentPairIndex = (st.currentPairIndex ?? 0) + 1;
  if (st.currentPairIndex < st.bracket.length) {
    st.currentPair = st.bracket[st.currentPairIndex];
    const p = st.currentPair;
    await ch.send({
      content: `**Round ${st.round}**: <@${p.a}> vs <@${p.b}> — chọn nước đi!`,
      components: [ rpsPlayRow(st.tid, st.round) ],
    });
    return;
  }
  // Hết round – chuẩn bị round mới hoặc kết thúc
if (st.winners.length === 1) {
  const champ = st.winners[0];

  // Tổng thưởng = quỹ lệ phí + phần thưởng cấu hình
  const feePool   = (st.fee ?? 0) * (st.players?.length ?? 0);
  const basePrize = st.reward ?? 0;
  const prize     = feePool + basePrize;

  // Cộng coin cho quán quân (nếu hàm addBal có tồn tại trong bot của bạn)
  if (typeof addBal === 'function' && prize > 0) {
    try { await addBal(champ, prize); } catch (_) {}
  }
  // Gắn huy hiệu quán quân
if (typeof addBadge === 'function') {
  try { addBadge(champ, '🏆 Quán quân RPSLS'); } catch (_) {}
        }

  await ch.send({
    content: `🏆 **Giải kết thúc!** Quán quân: <@${champ}> nhận **${prize.toLocaleString('vi-VN')}** coin.`,
  });

  // Xoá state giải
  rpslsState.set(gid, null);
  return;
}

  // Tạo bracket round kế tiếp từ winners
  st.bracket = [];
  for (let i = 0; i < st.winners.length; i += 2) {
    const a = st.winners[i];
    const b = st.winners[i + 1];
    if (b) st.bracket.push({ a, b });
  }
  st.round += 1;
  st.winners = [];
  st.currentPairIndex = 0;
  st.moves = new Map();
  st.currentPair = st.bracket[0];

  const p2 = st.currentPair;
  await ch.send({
    content: `**Round ${st.round}**: <@${p2.a}> vs <@${p2.b}> — chọn nước đi!`,
    components: [ rpsPlayRow(st.tid, st.round) ],
  });
  return;
      }

  } catch (e) {
    console.error('[RPSLS] handler error:', e);
    // Chỉ gửi khi đã ACK (acked = true)
    if (acked && !interaction.replied && !interaction.deferred) {
      // bình thường không vào đây vì đã defer + editReply, nhưng giữ dự phòng
      await interaction.followUp({ content: '❌ Lỗi xử lý nút RPSLS.', ephemeral: true }).catch(() => {});
    } else {
      // đã defer => dùng editReply
      await interaction.editReply({ content: '❌ Lỗi xử lý nút RPSLS.' }).catch(() => {});
    }
  }
}
  
       if (isBtn && id === 'meme_refresh') {
        await interaction.deferUpdate();
        try {
          const { data } = await axios.get('https://meme-api.com/gimme');
          const { title, url, postLink, author, subreddit, ups } = data;
          const embed = new EmbedBuilder()
          .setTitle(title || 'Meme')
          .setURL(postLink || 'https://reddit.com')
          .setImage(url)
          .addFields(
            { name: 'Subreddit', value: `r/${subreddit}`, inline: true },
            { name: 'Tác giả', value: author || 'N/A', inline: true },
            { name: '👍', value: String(ups ?? 0), inline: true },
          )
          .setColor(0x5865F2);
          await interaction.followUp({ embeds:[embed], components:[row] });
          
      // ===== Quiz: trả lời =====
if (isBtn && id.startsWith('quiz_ans_')) {
  const parts = id.split('_');                // ["quiz","ans","<interactionId>","<idx>"]
  const quizKey = parts[2];
  const idxStr  = parts[3];
        if (!global.quizStore) global.quizStore = new Map();
        const data = global.quizStore.get(quizKey);
        if (!data) {
          return interaction.reply({ content: '⏰ Hết thời gian hoặc câu hỏi đã đóng!', ephemeral: true });
        }
        if (Date.now() > data.endAt) {
          global.quizStore.delete(quizKey);
          return interaction.reply({ content: '⏰ Hết thời gian trả lời!', ephemeral: true });
        }
        if (data.chosen.has(interaction.user.id)) {
          return interaction.reply({ content: '🙅 Bạn đã chọn rồi!', ephemeral: true });
        }

        data.chosen.add(interaction.user.id);

        const picked = Number(idxStr);
        const correct = (picked === data.ans);

        let rewardText = '';
        if (correct) {
          try {
            const balAfter = addBal(interaction.user.id, QUIZ_REWARD);
            rewardText = '\n💰 +' + QUIZ_REWARD.toLocaleString('vi-VN') + ' coin — Số dư: **' + balAfter.toLocaleString('vi-VN') + '**';
          } catch {}
        }

        return interaction.reply({
          ephemeral: true,
          content: correct
            ? '✅ Chính xác!' + rewardText + '\nℹ️ ' + (data.exp || '')
            : '❌ Chưa đúng. Đáp án đúng là **' + ['A','B','C','D'][data.ans] + '**.\nℹ️ ' + (data.exp || '')
        });
      }
} catch { await interaction.followUp('⚠️ Lấy meme thất bại.'); }
        return;
      }

      // ===== sendnoti: xác nhận / huỷ =====
if (isBtn && id.startsWith('sendnoti_confirm|')) {
  const [, authorId, scope, mention] = id.split('|');
  if (interaction.user.id !== authorId) {
    return interaction.reply({ content: '🚫 Chỉ người tạo thông báo mới bấm được.', ephemeral: true });
  }

  const cache = sendnotiTemp.get(authorId);
  if (!cache) {
    return interaction.reply({ content: '⚠️ Hết hạn xác nhận. Dùng lại /sendnoti.', ephemeral: true });
  }

  const { title, content, imageUrl } = cache;
  const targets = (scope === 'all')
    ? client.guilds.cache
    : client.guilds.cache.filter(g => g.id === interaction.guildId);

  let ok = 0, fail = 0;
  for (const g of targets.values()) {
    const ch = g.systemChannel || g.channels.cache.find(c => c.type===ChannelType.GuildText && c.viewable && c.permissionsFor(g.members.me).has('SendMessages'));
    if (!ch) { fail++; continue; }
    try {
      const embed = new EmbedBuilder()
        .setTitle(title || '📢 Thông báo toàn server')
        .setDescription(content)
        .setColor(0xF1c40F)
        .setFooter({ text: `Gửi bởi ${interaction.user.tag}` })
        .setTimestamp();
      if (imageUrl) embed.setImage(imageUrl);

      const pingText = mention==='everyone' ? '@everyone' : (mention==='here' ? '@here' : '');
      await ch.send({ content: pingText || undefined, embeds: [embed] });
      ok++;
    } catch { fail++; }
  }

  sendnotiTemp.delete(authorId);
  return interaction.update({ content: `✅ Đã gửi xong.\n• Thành công: **${ok}** server\n• Thất bại: **${fail}**`, components: [] });
}

if (isBtn && id.startsWith('sendnoti_cancel|')) {
  sendnotiTemp.delete(interaction.user.id);
  return interaction.update({ content: '🛑 Đã hủy gửi.', components: [] });
}

      // Phân trang SoundCloud
if (isBtn && id.startsWith('sc_page|')) {
  try {
    const [, authorId, nonce, pageStr] = id.split('|');
    if (interaction.user.id !== authorId) {
      return interaction.reply({ content: '🚫 Chỉ người yêu cầu mới dùng được bộ phân trang này.', ephemeral: true });
    }

    const page = parseInt(pageStr, 10) || 0;
    const view = await renderSCPage(nonce, page);
    return interaction.update(view);
  } catch (e) {
    console.error('SC pager error:', e);
    try {
      return interaction.reply({ content: '⚠️ Không chuyển trang được (kết quả có thể đã hết hạn).', ephemeral: true });
    } catch {}
  }
  return;
}

    // ===== ship reroll =====
if (isBtn && id.startsWith('ship_reroll|')) {
  await interaction.deferUpdate();
  try {
    const [, aId, bId] = id.split('|');
    const a = await interaction.guild.members.fetch(aId).catch(() => null);
    const b = await interaction.guild.members.fetch(bId).catch(() => null);
    if (!a || !b) {
      return interaction.followUp({ content: '⚠️ Không tìm thấy thành viên!', ephemeral: true });
    }

    const percent = Math.floor(Math.random() * 101);
    const file    = await makeShipCard(a, b, percent);
    const embed   = new EmbedBuilder()
      .setTitle(`${loveEmoji(percent)}  Match Meter:  ${percent}%`)
      .setDescription(`**${a.toString()}** ♥ **${b.toString()}**`)
      .setImage('attachment://ship.png')
      .setColor(0xff66aa);

    const cid = `ship_reroll|${a.id}|${b.id}`;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(cid).setLabel('🔁 Reroll').setStyle(ButtonStyle.Primary)
    );

    await interaction.followUp({ embeds: [embed], files: [file], components: [row] });
        return;
} catch (e) {
      console.error('Button handler error:', e);
    }
    return;
      } 

// ====== Tai Xiu modal submit ======
  if (interaction.isModalSubmit() && interaction.customId.startsWith('tx_modal_')) {
    const [_, __, side, roundId] = interaction.customId.split('_');
    const s = taiXiuState.get(interaction.guild.id);
    if (!s || String(s.roundId)!==String(roundId)) return interaction.reply({ content:'⚠️ Phiên đã kết thúc hoặc không tồn tại.', ephemeral:true });

    if (s.locked) return interaction.reply({ content:'⛔ Đã khóa đặt cược (5 giây cuối). Vui lòng đợi kết quả!', ephemeral:true });


    const amount = Number(interaction.fields.getTextInputValue('amount').replace(/[^\d]/g,''));
    if (!Number.isFinite(amount) || amount < s.min || amount > s.max)
      return interaction.reply({ content:`❌ Số coin không hợp lệ. Phải từ ${TX.fmt(s.min)} đến ${TX.fmt(s.max)}.`, ephemeral:true });

    const bal = getBal(interaction.user.id);
    if (bal < amount) return interaction.reply({ content:`💸 Số dư không đủ. Bạn còn **${TX.fmt(bal)}** coin.`, ephemeral:true });

    addBal(interaction.user.id, -amount);
    if (s.bets.has(interaction.user.id)) {
      const old = s.bets.get(interaction.user.id);
      if (old.side !== side) { addBal(interaction.user.id, old.amount); return interaction.reply({ content:'⚠️ Bạn đã cược bên kia trong phiên này.', ephemeral:true }); }
      old.amount += amount;
    } else {
      s.bets.set(interaction.user.id, { side, amount });
    }
    s.total[side] += amount;

    await interaction.reply({ content:`✅ Đặt **${TX.fmt(amount)}** coin cho **${side=='tai'?'TÀI':'XỈU'}** thành công!`, ephemeral:true });

    try {
      const channel = await client.channels.fetch(s.channelId);
      const msg = await channel.messages.fetch(s.msgId);
      await msg.edit({ embeds:[TX.render(interaction.guild.id)], components:[ s.locked ? TX.rowDisabled(s.roundId) : TX.row(s.roundId) ] });
    } catch {}
        }

// String select menu (SoundCloud chọn bài)
if (interaction.isStringSelectMenu()) {
  try {
    // Chỉ xử lý menu của SoundCloud
    if (!interaction.customId.startsWith('sc_select|')) return;

    const parts = interaction.customId.split('|');
    const authorId = parts[1];

    // Chỉ người đã mở menu mới được chọn
    if (interaction.user.id !== authorId) {
      return interaction.reply({ content: '⚠️ Chỉ người yêu cầu mới chọn được bài này.', ephemeral: true });
    }

    const url = interaction.values?.[0];
    if (!url) {
      return interaction.reply({ content: '⚠️ Không nhận được URL bài hát.', ephemeral: true });
    }

    // Update ngay để tránh timeout
    await interaction.update({ content: '⏳ Đang thêm vào hàng đợi...', components: [] });

    const q = await ensureConnected(interaction);
    let title = 'SoundCloud Track';

    try {
      // Ưu tiên lấy metadata trực tiếp từ URL
      const info = await play.soundcloud(url).catch(() => null);

      if (info) {
        title = info.name || info.title || title;
        q.queue.push({
          title,
          url: info.url || url,
          duration: info.durationInSec || 0,   // 👈 rất quan trọng cho /np & /seek
          user: interaction.user.tag,
        });
      } else {
        // Fallback: thử search lại 1 kết quả theo URL
        const sc = await scSearchTracks(url, 1).catch(() => []);
        if (sc && sc.length) {
          const r = sc[0];
          title = r.title || r.name || title;
          q.queue.push({
            title,
            url: r.url || url,
            duration: r.durationInSec || 0,    // 👈 giữ duration
            user: interaction.user.tag,
          });
        } else {
          return interaction.followUp({ content: '⚠️ Không lấy được thông tin bài hát.', ephemeral: true });
        }
      }

      // Nếu player đang rảnh thì phát luôn
      if (q.player.state.status !== AudioPlayerStatus.Playing) {
        playNext(interaction.guildId);
      }

      return interaction.followUp({ content: `🎧 Đã thêm **${title}** vào hàng đợi.`, ephemeral: true });
    } catch (e) {
      console.error('SC select inner error:', e);
      return interaction.followUp({ content: '⚠️ Lỗi khi thêm bài từ SoundCloud.', ephemeral: true });
    }
  } catch (e) {
    console.error('SC select outer error:', e);
    try {
      if (interaction.deferred || interaction.replied) {
        return await interaction.followUp({ content: '⚠️ Lỗi khi thêm bài từ SoundCloud.', ephemeral: true });
      }
      return interaction.reply({ content: '⚠️ Lỗi khi thêm bài từ SoundCloud.', ephemeral: true });
    } catch {}
  }
}
});

// ------------------- slash handlers -------------------
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {// ====== /quiz ======
if (interaction.commandName === 'quiz') {
  const last = quizCooldown.get(interaction.channelId) || 0;
  if (Date.now() - last < QUIZ_COOLDOWN_MS) {
    return interaction.reply({ content: '⏳ Đợi một chút rồi thử lại nhé!', ephemeral: true });
  }
  quizCooldown.set(interaction.channelId, Date.now());

  const quiz = pickQuiz();
  const labels = ['A','B','C','D'];
  const embed = new EmbedBuilder()
    .setTitle('🧠 Đố vui trắc nghiệm')
    .setDescription(`**Câu hỏi:** ${quiz.q}\\n\\n${quiz.choices.map((c,i)=>`**${labels[i]}**. ${c}`).join('\\n')}`)
    .setColor(0x5865F2)
    .setFooter({ text: `Bạn có ${(QUIZ_DURATION_MS/1000)} giây để trả lời` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`quiz_ans_${interaction.id}_0`).setLabel('A').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`quiz_ans_${interaction.id}_1`).setLabel('B').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`quiz_ans_${interaction.id}_2`).setLabel('C').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`quiz_ans_${interaction.id}_3`).setLabel('D').setStyle(ButtonStyle.Primary),
  );

  if (!global.quizStore) global.quizStore = new Map();
  global.quizStore.set(interaction.id, { ans: quiz.ans, exp: quiz.exp, endAt: Date.now()+QUIZ_DURATION_MS, chosen: new Set() });

  const msg = await interaction.reply({ embeds:[embed], components:[row] });

  setTimeout(async () => {
    try {
      const data = global.quizStore.get(interaction.id);
      if (!data) return;
      const disabledRow = new ActionRowBuilder().addComponents(
        row.components.map(b => ButtonBuilder.from(b).setDisabled(true))
      );
      await interaction.editReply({ components:[disabledRow] }).catch(()=>{});
      global.quizStore.delete(interaction.id);
    } catch {}
  }, QUIZ_DURATION_MS);
  return;
}

    // ====== /coin ======
    if (interaction.commandName === 'coin') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'balance') {
        const u = interaction.options.getUser('user') || interaction.user;
        const bal = getBal(u.id);
        return interaction.reply({ content:`👛 Số dư của **${u.tag}**: **${bal.toLocaleString('vi-VN')}** coin` });
      }
      if (sub === 'daily') {
        const key = `daily_${interaction.user.id}`;
        const now = Date.now();
        const last = coins[key] || 0;
        if (now - last < 24*60*60*1000) {
          const remain = Math.ceil((24*60*60*1000 - (now-last))/3600000);
          return interaction.reply({ content:`⏳ Bạn đã nhận daily rồi. Thử lại sau khoảng **${remain} giờ**.`, ephemeral:true });
        }
        coins[key] = now; await saveCoins();
        const reward = 1000 + Math.floor(Math.random()*2000);
        const bal = addBal(interaction.user.id, reward);
        return interaction.reply({ content:`✅ Nhận daily **${reward.toLocaleString('vi-VN')}** coin. Số dư mới: **${bal.toLocaleString('vi-VN')}**` });
      }
      if (sub === 'give') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator))
          return interaction.reply({ content:'❌ Chỉ admin.', ephemeral:true });
        const u = interaction.options.getUser('user', true);
        const amt = interaction.options.getInteger('amount', true);
        const bal = addBal(u.id, amt);
        return interaction.reply({ content:`🎁 Đã cộng **${amt.toLocaleString('vi-VN')}** coin cho **${u.tag}**. Số dư: **${bal.toLocaleString('vi-VN')}**` });
      }
    }

    // ====== /taixiu ======
    if (interaction.commandName === 'taixiu') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'start') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator))
          return interaction.reply({ content:'❌ Chỉ admin mới được bắt đầu ván.', ephemeral:true });
        if (taiXiuState.has(interaction.guild.id))
          return interaction.reply({ content:'⚠️ Đang có ván diễn ra. Dùng `/taixiu status` để xem.', ephemeral:true });

        const t = interaction.options.getInteger('thoigian') ?? 30;
        const min = interaction.options.getInteger('min') ?? 10;
        const max = interaction.options.getInteger('max') ?? 1_000_000;

        const roundId = Math.floor(1000 + Math.random()*9000);
        const endsAt = Date.now() + t*1000;
        const state = { roundId, channelId: interaction.channel.id, msgId: null, timer: null, endsAt, dealerId: null, locked: false, min, max, bets: new Map(), total:{tai:0,xiu:0} };
        taiXiuState.set(interaction.guild.id, state);

        const msg = await interaction.reply({ embeds:[TX.render(interaction.guild.id)], components:[TX.row(roundId)] });
        state.msgId = (await interaction.fetchReply()).id;

        state.timer = setTimeout(async ()=>{
          const s = taiXiuState.get(interaction.guild.id);
if (!s) return;
try {
  // lock main round message
  const ch = await client.channels.fetch(s.channelId);
  const msg = await ch.messages.fetch(s.msgId);
  s.locked = true;
  await msg.edit({
    embeds: [TX.render(interaction.guild.id)],
    components: [ TX.rowDisabled(s.roundId) ]
  });

  // rolling animation as new message (sequential lock-in)
const rollingTitle = '🎲 Đang lắc xúc xắc...';
const baseColor    = 0x00bfff;

// helper: render 1–3 viên (null => ô trống)
const renderRoll = (a, b, c) => {
  const f = (n) => (n == null ? '▫️' : diceFace(n));
  return new EmbedBuilder()
    .setTitle(rollingTitle)
    .setDescription(`${f(a)}  ${f(b)}  ${f(c)}`)
    .setColor(baseColor)
    .setFooter({ text: `Phiên #${s.roundId} • ${TX.now()}` });
};

// gửi khung đầu tiên
let rollMsg = await ch.send({ embeds: [renderRoll(null, null, null)] });

// “nặn” từng viên: đợt 1 → đợt 2 → đợt 3
const spinOnce = () => 1 + Math.floor(Math.random() * 6);

// Đợt 1
for (let i = 0; i < 8; i++) {
  await rollMsg.edit({ embeds: [renderRoll(spinOnce(), null, null)] });
  await sleep(120);
}
const d1 = spinOnce();
await rollMsg.edit({ embeds: [renderRoll(d1, null, null)] });
await sleep(250);

// Đợt 2
for (let i = 0; i < 8; i++) {
  await rollMsg.edit({ embeds: [renderRoll(d1, spinOnce(), null)] });
  await sleep(120);
}
const d2 = spinOnce();
await rollMsg.edit({ embeds: [renderRoll(d1, d2, null)] });
await sleep(250);

// Đợt 3
for (let i = 0; i < 8; i++) {
  await rollMsg.edit({ embeds: [renderRoll(d1, d2, spinOnce())] });
  await sleep(120);
}
const d3 = spinOnce();
await rollMsg.edit({ embeds: [renderRoll(d1, d2, d3)] });
await sleep(350);

// CHỐT kết quả
const kq = {
  dice: [d1, d2, d3],
  sum:  d1 + d2 + d3,
  triple: (d1 === d2 && d2 === d3),
  side: (d1 === d2 && d2 === d3) ? 'house' : ((d1 + d2 + d3) >= 11 ? 'tai' : 'xiu'),
};

  // official roll and payout
  const winners = kq.side;
  const winnersList = [];
  const losersList = [];
  if (winners === 'tai' || winners === 'xiu') {
    for (const [uid, bet] of s.bets.entries()) {
      if (bet.side === winners) {
        addBal(uid, bet.amount * 2);
        winnersList.push({ uid, amount: bet.amount });
      } else {
        losersList.push({ uid, amount: bet.amount });
      }
    }
  }

  const fmt = (n)=> Number(n||0).toLocaleString('vi-VN');
  const top = (arr)=> arr.slice(0,10).map(x=> `• <@${x.uid}>: **${fmt(x.amount)}**`).join('\n') || '—';

  const resultEmbed = new EmbedBuilder()
    .setTitle('🎯 Kết quả Tài Xỉu')
    .setColor(winners==='tai'?0x3498db : winners==='xiu'?0xe74c3c : 0x95a5a6)
    .setDescription(
      `🎲 **Xúc xắc:** ${diceFace(kq.dice[0])} ${diceFace(kq.dice[1])} ${diceFace(kq.dice[2])}\n` +
      `= \`${kq.dice.join(' + ')} = ${kq.sum}\`` +
      `\n${kq.triple ? '💥 **Bộ ba đồng số** → Nhà cái thắng!' : `🏁 **Kết quả:** ${winners==='tai' ? '🔵 TÀI' : '🔴 XỈU'}`}`
    )
    .addFields(
      { name:'🔵 Tài (tổng)', value:`${fmt(s.total.tai)} coin`, inline:true },
      { name:'🔴 Xỉu (tổng)', value:`${fmt(s.total.xiu)} coin`, inline:true },
    )
    .setFooter({ text: `Kết thúc phiên #${s.roundId}` })

// ===== cập nhật "cầu" (history) =====
try {
  const gid = (interaction && (interaction.guild?.id || interaction.channel?.guildId)) || 'global';
  if (!global.txHistory) global.txHistory = new Map();
  const hist = global.txHistory.get(gid) || [];

  // Tính tổng điểm an toàn từ kq.sum hoặc mảng kq.dice
  let totalLocal = null;
  try {
    if (kq && typeof kq.sum === 'number') {
      totalLocal = Number(kq.sum);
    } else if (kq && Array.isArray(kq.dice) && kq.dice.length >= 3) {
      totalLocal = (Number(kq.dice[0])||0) + (Number(kq.dice[1])||0) + (Number(kq.dice[2])||0);
    }
  } catch(e){ totalLocal = null; }

  // Nhãn kết quả
  let resLabel = '—';
  try {
    if (kq && kq.triple) {
      resLabel = 'Nhà cái';
    } else if (typeof totalLocal === 'number') {
      resLabel = totalLocal >= 11 ? 'Tài' : 'Xỉu';
    } else if (typeof winners === 'string') {
      const lw = winners.toLowerCase();
      if (lw.includes('tai')) resLabel = 'Tài';
      else if (lw.includes('xiu')) resLabel = 'Xỉu';
    }
  } catch(e){}

  hist.push({ total: (typeof totalLocal === 'number' ? totalLocal : null), result: resLabel, time: Date.now() });
  if (hist.length > 40) hist.shift();
  global.txHistory.set(gid, hist);

  const trend = hist.map(h => (h.result === 'Tài' ? '🔵' : '🔴')).join(' ');
  let streak = 1;
  for (let i = hist.length - 2; i >= 0; i--) {
    if (hist[i].result === hist[hist.length - 1].result) streak++;
    else break;
  }

  try {
    resultEmbed.addFields(
      { name: '📈 Cầu (last ' + hist.length + ')', value: trend || '—', inline: false },
      { name: '🔥 Chuỗi', value: String(streak), inline: true }
    );
  } catch {}
} catch(e) {
  console.error('txHistory update error:', e);
}

  if (winners==='tai' || winners==='xiu') {
    resultEmbed.addFields(
      { name:'✅ Trả coin cho (thắng)', value: top(winnersList), inline:false },
      { name:'❌ Mất coin (thua)', value: top(losersList), inline:false },
    );
  }

  await ch.send({ embeds: [resultEmbed] });

try {
  await rollMsg.edit({
  embeds: [
    new EmbedBuilder()
      .setTitle('🎲 Đang lắc xúc xắc...')
      .setDescription('✅ Xong!')
      .setColor(0x2ecc71)
      .setFooter({
        text: 'Phiên #' + ((s && s.roundId) ? s.roundId : 'N/A') + ' • ' + new Date().toLocaleString()
      })
  ]
});
  setTimeout(() => rollMsg.delete().catch(() => {}), 1500);
} catch (e) {
  console.error('Could not finalize/cleanup rollMsg:', e);
}


} catch (e) {
  console.error('TaiXiu finalize error:', e);
}
clearTimeout(s.timer);
taiXiuState.delete(interaction.guild.id);}, t*1000);
// update every 5s
        const interval = setInterval(async ()=>{
          const s = taiXiuState.get(interaction.guild.id);
          if (!s) { clearInterval(interval); return; }
          const left = Math.max(0, Math.ceil((s.endsAt - Date.now())/1000));
          if (!s.locked && left <= 5) s.locked = true;
          try { 
            await interaction.editReply({ 
              embeds:[TX.render(interaction.guild.id)],
              components:[ s.locked ? TX.rowDisabled(s.roundId) : TX.row(s.roundId) ]
            }); 
          } catch {}
          if (Date.now() >= s.endsAt) clearInterval(interval);
        }, 5000);
        return;
      }

      if (sub === 'status') {
        const s = taiXiuState.get(interaction.guild.id);
        if (!s) return interaction.reply({ content:'ℹ️ Chưa có ván nào. Dùng `/taixiu start` để bắt đầu.', ephemeral:true });
        return interaction.reply({ embeds:[TX.render(interaction.guild.id)], ephemeral:true });
      }

      if (sub === 'cancel') {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator))
          return interaction.reply({ content:'❌ Chỉ admin mới được hủy ván.', ephemeral:true });
        const s = taiXiuState.get(interaction.guild.id);
        if (!s) return interaction.reply({ content:'ℹ️ Không có ván nào để hủy.', ephemeral:true });
        clearTimeout(s.timer); taiXiuState.delete(interaction.guild.id);
        return interaction.reply({ content:`🛑 Đã hủy phiên #${s.roundId}.`, ephemeral:true });
      }
    }
if (interaction.commandName === 'rpsls') {
  const sub = interaction.options.getSubcommand();
  const gid = interaction.guild.id;
  if (!rpslsState.has(gid)) rpslsState.set(gid, null);

  const get = (uid)=> (typeof getBal==='function' ? getBal(uid) : 0);
  const add = (uid,amt)=> (typeof addBal==='function' ? addBal(uid,amt) : 0);

  if (sub === 'start') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content:'❌ Chỉ admin mới mở giải.', ephemeral:true });
    const slots  = interaction.options.getInteger('slots', true);
    const fee    = interaction.options.getInteger('entryfee') ?? 0;
    const reward = interaction.options.getInteger('reward')  ?? 0;

    const tid = Date.now().toString(36);
    const state = {
      tid, guildId: gid, host: interaction.user.id, channelId: interaction.channel.id,
      slots, fee, reward,
      players: [], started:false, round:0,
      bracket: [], moves:new Map(), msgLobbyId:null, currentPair:null
    };
    rpslsState.set(gid, state);

    const embed = new EmbedBuilder()
      .setColor(0x7c5cff)
      .setTitle('🎮 RPSLS Tournament – Đăng ký')
      .setDescription(`Slots: **${slots}** • Phí: **${fee.toLocaleString('vi-VN')}** • Thưởng: **${reward.toLocaleString('vi-VN')}**\nNhấn **Tham gia** để vào giải.`)
      .addFields({ name:'Người chơi', value:'(chưa có)' })
      .setFooter({ text:`TID: ${tid}` });

    await interaction.reply({ embeds: [embed], components: lobbyButtons(tid) });
const msg = await interaction.fetchReply();
state.msgLobbyId = msg.id;              // ✅ chỉ lưu id message
return;
  }

  if (sub === 'join') {
    const st = rpslsState.get(gid);
    if (!st || st.started) return interaction.reply({ content:'⚠️ Chưa có giải đang mở.', ephemeral:true });
    if (st.players.includes(interaction.user.id)) return interaction.reply({ content:'Bạn đã tham gia.', ephemeral:true });
    if (st.players.length >= st.slots) return interaction.reply({ content:'📦 Đã đủ slot.', ephemeral:true });
    if (st.fee>0 && get(interaction.user.id)<st.fee) return interaction.reply({ content:'💸 Không đủ coin.', ephemeral:true });
    if (st.fee>0) add(interaction.user.id, -st.fee);
    st.players.push(interaction.user.id);
    await updateLobby(interaction, st);
    return interaction.reply({ content:'✅ Đã tham gia!', ephemeral:true });
  }

  if (sub === 'status') {
    const st = rpslsState.get(gid);
    if (!st) return interaction.reply({ content:'Không có giải.', ephemeral:true });
    const txt = st.started
      ? `Round **${st.round}** • Cặp: ${st.currentPair ? `<@${st.currentPair.a}> vs <@${st.currentPair.b}>` : '—'}`
      : `Đang đăng ký: **${st.players.length}/${st.slots}**`;
    return interaction.reply({ content: txt, ephemeral:true });
  }

  if (sub === 'cancel') {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content:'❌ Chỉ admin.', ephemeral:true });
    rpslsState.set(gid, null);
    return interaction.reply({ content:'🧹 Đã huỷ giải.', ephemeral:true });
  }
}

// helpers cho RPSLS flow
async function updateLobby(interaction, st){
  const names = st.players.map(u=>`• <@${u}>`).join('\n') || '(chưa có)';
  const embed = new EmbedBuilder()
    .setColor(0x7c5cff)
    .setTitle('🎮 RPSLS Tournament – Đăng ký')
    .setDescription(`Slots: **${st.slots}** • Phí: **${st.fee.toLocaleString('vi-VN')}** • Thưởng: **${st.reward.toLocaleString('vi-VN')}**`)
    .addFields({ name:'Người chơi', value:names })
    .setFooter({ text:`TID: ${st.tid}` });
  try{
    const ch  = await interaction.client.channels.fetch(st.channelId);
    const msg = await ch.messages.fetch(st.msgLobbyId);
    await msg.edit({ embeds:[embed], components: lobbyButtons(st.tid) });
  }catch{}
}

async function startTournament(client, st){
  st.started = true; st.round = 1;
  const arr = [...st.players];
  for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  st.bracket = []; for(let i=0;i<arr.length;i+=2) st.bracket.push([arr[i],arr[i+1]]);
  const ch = await client.channels.fetch(st.channelId);
  await ch.send({ content:`🚀 **Bắt đầu giải!** ${st.bracket.length} cặp trong Round 1.` });
  playNextPair(client, st).catch(()=>{});
}
async function playNextPair(client, st){
  if (!st.bracket.length){
    if (st.players.length>1){
      st.round++; const a=[...st.players]; st.players=[]; st.bracket=[];
      for(let i=0;i<a.length;i+=2) st.bracket.push([a[i],a[i+1]]);
      const ch = await client.channels.fetch(st.channelId);
      await ch.send({ content:`📣 **Round ${st.round}** bắt đầu!` });
      return playNextPair(client, st);
    }
    const champion = st.players[0];
    const ch = await client.channels.fetch(st.channelId);
    await ch.send({ content:`👑 **Vô địch:** <@${champion}>!` });
    if (st.reward && typeof addBal==='function') try{ addBal(champion, st.reward); }catch{}
    addBadge(champion,'RPSLS Champion');
    rpslsState.set(st.guildId, null);
    return;
  }
  const [a,b] = st.bracket.shift(); st.currentPair = { a,b };
  const ch = await client.channels.fetch(st.channelId);
  await ch.send({ content:`⚔️ **Round ${st.round}**: <@${a}> vs <@${b}> – chọn trong **30s**!`, components: rpsButtons(st.tid, st.round) });
  for(const uid of [a,b]) st.moves.delete(`${st.round}-${uid}`);
  setTimeout(async ()=>{
    const ma = st.moves.get(`${st.round}-${a}`) || RPS.moves[Math.floor(Math.random()*5)];
    const mb = st.moves.get(`${st.round}-${b}`) || RPS.moves[Math.floor(Math.random()*5)];
    const res = RPS.win(ma, mb);
    const line = `🧠 <@${a}> ${RPS.emoji(ma)} vs ${RPS.emoji(mb)} <@${b}>`;
    const ch = await client.channels.fetch(st.channelId);
    if (res===0){ await ch.send({ content:`${line}\n🔁 Hoà! Đấu lại.` }); st.bracket.unshift([a,b]); }
    else { const win = res===1?a:b; const lose=res===1?b:a; await ch.send({ content:`${line}\n✅ Thắng: <@${win}> • ❌ Thua: <@${lose}>` }); st.players.push(win); }
    st.currentPair=null; playNextPair(client, st).catch(()=>{});
  }, 30_000);
}
    
    // uptime
    if (interaction.commandName === 'uptime') {
      const ws = client.ws.ping, up = formatUptime(client.uptime ?? 0);
      const { color, emoji } = pingStyle(ws);
      const botRam = fmtBytes(process.memoryUsage().rss);
      const totalMem = os.totalmem(), freeMem = os.freemem(), usedMem = totalMem - freeMem;
      const sysRam = `${fmtBytes(usedMem)} / ${fmtBytes(totalMem)} (${((usedMem/totalMem)*100).toFixed(1)}%)`;
      const load1 = (os.loadavg?.()[0]) || 0, cores = (os.cpus?.().length) || 1;
      const cpuText = `${Math.min(100,(load1/cores)*100).toFixed(1)}% (1m load)`;
      const embed = new EmbedBuilder()
        .setTitle(`${emoji} Uptime & System`)
        .addFields(
          { name:'WS Ping', value:`${ws}ms`, inline:true },
          { name:'Uptime', value:up, inline:true },
          { name:'🧠 RAM (Bot)', value:botRam, inline:true },
          { name:'🖥️ RAM (System)', value:sysRam, inline:true },
          { name:'🧮 CPU', value:cpuText, inline:true }
        ).setColor(color).setTimestamp();
      return interaction.reply({ embeds:[embed] });
    }

    // serverinfo
    if (interaction.commandName === 'serverinfo') {
      const g = interaction.guild;
      await Promise.allSettled([g.fetch(), g.channels.fetch(), g.roles.fetch(), g.emojis.fetch(), g.stickers.fetch()]);
      const created = Math.floor(g.createdTimestamp / 1000), ownerId = g.ownerId;
      const ch = g.channels.cache;
      const numText = ch.filter(c => [ChannelType.GuildText,ChannelType.GuildAnnouncement,ChannelType.GuildForum].includes(c.type)).size;
      const numVoice = ch.filter(c => [ChannelType.GuildVoice,ChannelType.GuildStageVoice].includes(c.type)).size;
      const numCat = ch.filter(c => c.type === ChannelType.GuildCategory).size;
      const numThreads = ch.filter(c => [ChannelType.PublicThread,ChannelType.PrivateThread,ChannelType.AnnouncementThread].includes(c.type)).size;
      const embed = new EmbedBuilder()
        .setTitle(`🛡️ Thông tin máy chủ: ${g.name}`)
        .setThumbnail(g.iconURL({ size:1024 }) || interaction.client.user.displayAvatarURL())
        .addFields(
          { name:'🆔 ID', value:g.id, inline:true },
          { name:'👑 Owner', value:ownerId ? `<@${ownerId}>` : 'Không rõ', inline:true },
          { name:'📅 Tạo lúc', value:`<t:${created}:F>\n(<t:${created}:R>)`, inline:true },
          { name:'👥 Thành viên', value:`${g.memberCount}`, inline:true },
          { name:'🚀 Boosts', value:`${g.premiumSubscriptionCount ?? 0} (Tier ${String(g.premiumTier || 'None')})`, inline:true },
          { name:'🏷️ Roles', value:String(g.roles.cache.size), inline:true },
          { name:'💬 Text/News/Forum', value:String(numText), inline:true },
          { name:'🔊 Voice/Stage', value:String(numVoice), inline:true },
          { name:'📁 Categories', value:String(numCat), inline:true },
          { name:'🧵 Threads', value:String(numThreads), inline:true },
          { name:'😄 Emojis', value:String(g.emojis.cache.size), inline:true },
          { name:'🏷️ Stickers', value:String(g.stickers.cache.size), inline:true },
        ).setColor(0x5865F2).setTimestamp();
      const buttons = new ActionRowBuilder();
      const icon = g.iconURL({ size:1024 }); const banner = g.bannerURL({ size:1024 });
      if (icon) buttons.addComponents(new ButtonBuilder().setLabel('🔗 Mở Icon').setStyle(ButtonStyle.Link).setURL(icon));
      if (banner) buttons.addComponents(new ButtonBuilder().setLabel('🔗 Mở Banner').setStyle(ButtonStyle.Link).setURL(banner));
      return interaction.reply({ embeds:[embed], components: buttons.components.length?[buttons]:[] });
    }

    if (interaction.commandName === 'setwelcome') {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ Cần quyền **Administrator**.', ephemeral: true });
  }

  const ch = interaction.options.getChannel('channel', true);
  const message = interaction.options.getString('message') || '';

  welcomes[interaction.guildId] = { channelId: ch.id, message };
  await saveWelcomes?.(); // nếu bạn đã có hàm này
  // nếu chưa có, dán hàm ở cuối trả lời này

  return interaction.reply({
    content: `✅ Đã bật chào mừng tại <#${ch.id}>.\n` +
             `• Thông điệp: ${message ? `\`${message}\`` : '_(để trống)_'}`,
    ephemeral: true
  });
}
    if (interaction.commandName === 'disablewelcome') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
        return interaction.reply({ content:'❌ Cần quyền **Administrator**.', ephemeral:true });
      delete welcomes[interaction.guildId]; await saveWelcomes();
      return interaction.reply('🛑 Đã tắt thông báo chào mừng.');
    }
    if (interaction.commandName === 'testwelcome') {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({ content: '❌ Cần quyền **Administrator**.', ephemeral: true });
  }

  const data = welcomes[interaction.guildId];
  if (!data) {
    return interaction.reply({ content: '⚠️ Chưa cấu hình chào mừng. Dùng `/setwelcome` trước.', ephemeral: true });
  }

  // Lấy channel đã cấu hình (ưu tiên cache, fallback fetch)
  let ch = interaction.guild.channels.cache.get(data.channelId);
  if (!ch) {
    try { ch = await interaction.guild.channels.fetch(data.channelId).catch(() => null); } catch {}
  }
  if (!ch || !ch.isTextBased?.()) {
    return interaction.reply({ content: '⚠️ Kênh chào mừng không hợp lệ hoặc bot không gửi được.', ephemeral: true });
  }

  // Tạo payload demo & gửi
  const payload = buildWelcomePayload(
    interaction.member ?? await interaction.guild.members.fetch(interaction.user.id),
    data,
    { demo: true }
  );
  await ch.send(payload);

  return interaction.reply({ content: '✅ Đã gửi thử chào mừng (demo).', ephemeral: true });
}

    // roll / 8ball / avatar / purge / meme / profile
    if (interaction.commandName === 'roll') {
      const faces = interaction.options.getInteger('faces') ?? 6;
      const result = 1 + Math.floor(Math.random() * faces);
      return interaction.reply(`🎲 Kết quả xúc xắc ${faces} mặt: **${result}**`);
    }
    if (interaction.commandName === '8ball') {
      const q = interaction.options.getString('question');
      const a = ['Chắc chắn rồi!','Có thể lắm...','Không đâu 😅','Hỏi lại sau nhé!','Triển thôi!','Hôm nay chưa phải lúc','Tỉ lệ 50/50','Tín hiệu tích cực!'];
      return interaction.reply(`🎱 **Q:** ${q}\n**A:** ${a[Math.floor(Math.random()*a.length)]}`);
    }
    if (interaction.commandName === 'avatar') {
      const user = interaction.options.getUser('user') ?? interaction.user;
      return interaction.reply({ content:`🖼️ Avatar của **${user.tag}**: ${user.displayAvatarURL({ size: 1024 })}` });
    }
    if (interaction.commandName === 'purge') {
      const count = interaction.options.getInteger('count');
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages))
        return interaction.reply({ content:'❌ Cần quyền **Manage Messages**.', ephemeral:true });
      if (count < 2 || count > 100) return interaction.reply({ content:'Chỉ xóa 2–100 tin.', ephemeral:true });
      const msgs = await interaction.channel.messages.fetch({ limit: count });
      await interaction.channel.bulkDelete(msgs, true);
      return interaction.reply({ content:`🧹 Đã xóa **${msgs.size}** tin.` });
    }
    if (interaction.commandName === 'meme') {
      await interaction.deferReply();
      try {
        const { data } = await axios.get('https://meme-api.com/gimme');
        const { title, url, postLink, author, subreddit, ups } = data;
        const embed = new EmbedBuilder()
          .setTitle(title || 'Meme').setURL(postLink || 'https://reddit.com').setImage(url)
          .addFields({ name:'Subreddit', value:`r/${subreddit}`, inline:true },
                     { name:'Tác giả', value:author || 'N/A', inline:true },
                     { name:'👍', value:String(ups ?? 0), inline:true })
          .setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('meme_refresh').setLabel('🔁 Meme khác').setStyle(ButtonStyle.Primary)
        );
        return interaction.editReply({ embeds:[embed], components:[row] });
      } catch { return interaction.editReply('⚠️ Lấy meme thất bại.'); }
    }
    if (interaction.commandName === 'profile') {
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const user = await interaction.client.users.fetch(targetUser.id, { force: true }).catch(() => targetUser);
      const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      const avatarURL = user.displayAvatarURL({ size: 1024 }), bannerURL = user.bannerURL?.({ size: 1024 }) || null;
      const created = Math.floor(user.createdTimestamp / 1000);
      const joined = member?.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
      let rolesText = 'Không có', highestRole = '—';
      if (member) {
        const roles = member.roles.cache.filter(r => r.name !== '@everyone').sort((a,b)=>b.position-a.position);
        const topRoles = roles.map(r => `<@&${r.id}>`).slice(0, 10);
        rolesText = topRoles.length ? topRoles.join(', ') + (roles.size > 10 ? ` … (+${roles.size - 10})` : '') : 'Không có';
        highestRole = roles.first()?.toString() || '—';
      }
      const boostText = member?.premiumSince ? `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>` : 'Không';
      const color = member?.displayHexColor && member.displayHexColor !== '#000000' ? parseInt(member.displayHexColor.replace('#',''), 16) : 0x00AE86;
      const embed = new EmbedBuilder()
        .setTitle(`Thông tin của ${user.tag}`).setThumbnail(avatarURL)
        .addFields(
          { name:'🆔 ID', value:user.id, inline:true },
          { name:'🤖 Bot?', value:user.bot ? 'Có' : 'Không', inline:true },
          { name:'📝 Nickname', value:member?.nickname || '—', inline:true },
          { name:'📅 Tạo tài khoản', value:`<t:${created}:F>\n(<t:${created}:R>)`, inline:true },
          { name:'📥 Tham gia server', value: joined ? `<t:${joined}:F>\n(<t:${joined}:R>)` : 'Không rõ', inline:true },
          { name:'💠 Highest role', value:highestRole, inline:true },
          { name:'🏷️ Roles', value:rolesText, inline:false },
          { name:'🚀 Boost server từ', value:boostText, inline:true }
        ).setColor(color)
        .setFooter({ text:`Yêu cầu bởi ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() }).setTimestamp();
      const b = badges[targetUser.id] || [];
      // ===== HUY HIỆU (badges) =====

// badges lưu trong file (loại "tĩnh")
const staticBadges = badges[targetUser.id] || [];

// badges "động" (tự tính theo điều kiện)
const dynBadges = [];

// ví dụ các ngưỡng coin -> huy hiệu
const gcoins = (coins?.[interaction.guildId]?.[targetUser.id]) ?? 0;
if (gcoins >= 10_000_000) dynBadges.push('👑 Đại gia 10M+');
else if (gcoins >= 1_000_000) dynBadges.push('💎 Đại gia 1M+');

// admin -> huy hiệu
if (member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
  dynBadges.push('🛡️ Admin');
}

// gộp & loại trùng
const allBadges = [...new Set([...staticBadges, ...dynBadges])];

// thêm field vào embed
embed.addFields({
  name: '🎖️ Huy hiệu',
  value: allBadges.length ? allBadges.join(' · ') : 'Không có',
  inline: false,
});
      if (bannerURL) embed.setImage(bannerURL);
      const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('🔗 Mở Avatar').setStyle(ButtonStyle.Link).setURL(avatarURL));
      if (bannerURL) buttons.addComponents(new ButtonBuilder().setLabel('🔗 Mở Banner').setStyle(ButtonStyle.Link).setURL(bannerURL));
      return interaction.reply({ embeds:[embed], components:[buttons] });
    }

    // guess
    if (interaction.commandName === 'guess') {
      const guess = interaction.options.getInteger('number', true);
      if (guess < 1 || guess > 100) return interaction.reply({ content:'⚠️ Chỉ nhập số 1–100.', ephemeral:true });
      const key = interaction.user.id;
      if (!guessGames.has(key)) {
        const target = Math.floor(Math.random() * 100) + 1;
        guessGames.set(key, target);
        return interaction.reply(`🎯 **Bắt đầu game!** Mình đã chọn số 1–100.\nLần đoán: **${guess}**`);
      } else {
        const target = guessGames.get(key);
        if (guess === target) {
          guessGames.delete(key);
          const total = addWin(interaction.guildId, key); await saveWins();
          return interaction.reply(`✅ Chính xác! Số của mình là **${target}**.\n🏆 **Bạn đã thắng ${total} lần**!`);
        } else if (guess < target) return interaction.reply(`🔼 Số của mình **lớn hơn** ${guess}.`);
        else return interaction.reply(`🔽 Số của mình **nhỏ hơn** ${guess}.`);
      }
    }
    if (interaction.commandName === 'leaderboard') {
      const top = getTop(interaction.guildId, 10);
      if (top.length === 0) return interaction.reply('🤷 Chưa có ai thắng game đoán số.');
      const lines = await Promise.all(top.map(async ([uid, count], idx) => {
        const m = await interaction.guild.members.fetch(uid).catch(() => null);
        const name = m?.displayName || `<@${uid}>`;
        const medal = idx===0?'🥇':idx===1?'🥈':idx===2?'🥉':`#${idx+1}`;
        return `${medal} ${name}: **${count}** thắng`;
      }));
      const embed = new EmbedBuilder().setTitle('🏆 Bảng xếp hạng đoán số').setDescription(lines.join('\n')).setColor(0xF1C40F);
      return interaction.reply({ embeds:[embed] });
    }
    if (interaction.commandName === 'resetwins') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
        return interaction.reply({ content:'❌ Cần quyền **Administrator**.', ephemeral:true });
      resetWins(interaction.guildId); await saveWins();
      return interaction.reply('🗑️ Đã reset BXH.');
    }

// ==== HELP CONFIG: gom nhóm lệnh theo tên (để render đẹp) ====
const HELP_CATEGORIES = [
  { key: 'auto',    title: '⚡ Tự động tải',     names: ['fbauto','instaauto','tiktokauto'] },
  { key: 'dl',      title: '📥 Downloader',     names: ['fb','insta','tiktok','news', 'capcut'] },

  // Music (tuỳ bot bạn đang có lệnh nào – để đủ phổ biến)
  { key: 'music',   title: '🎵 Music',          names: ['join','play','playsc','skip','stop','pause','resume','queue','volume','npl'] },

  // Welcome/Moderation (ví dụ – bạn có lệnh nào thì liệt kê)
  { key: 'welcome', title: '👋 Welcome',        names: ['setwelcome','disablewelcome','testwelcome'] },
  { key: 'mod',     title: '🛡️ Moderation',    names: ['sendnoti','devsync'] },

  // Fun / Games
  { key: 'fun',     title: '🎲 Vui vẻ',         names: ['roll','8ball','ship','meme','guess','leaderboard','resetwins','taixiu','rpsls'] },

  // Info/Tools
  { key: 'info',    title: '🧰 Tiện ích',       names: ['uptime','serverinfo','profile','botstats','invite','weather','avatar','purge'] },
];

// icon nhỏ trước từng tên lệnh (tuỳ chọn cho đẹp)
function iconFor(name='') {
  const m = {
    fb:'🅵', insta:'🅸', tiktok:'🆃', news:'📰',
    fbauto:'⚡', instaauto:'⚡', tiktokauto:'⚡',
    play:'▶️', playsc:'🎵', join:'🔊', pause:'⏸️', resume:'▶️', skip:'⏭️', stop:'⏹️', queue:'📜', volume:'🔉', npl:'📜',
    roll:'🎲', '8ball':'🎱', ship:'💘', meme:'🖼️', guess:'🔢', leaderboard:'🏆', resetwins:'♻️',
    uptime:'⏱️', serverinfo:'🏠', profile:'🪪', botstats:'📊', invite:'🔗', weather:'⛅', avatar:'🖼️', purge:'🧹',
    setwelcome:'👋', disablewelcome:'🚫', testwelcome:'🧪',
    sendnoti:'📣', devsync:'🔧',
  };
  return m[name] || '•';
}

// ==== paging utils ====
const HELP_PAGE_GROUP_SIZE = 3; // mỗi trang hiển thị 3 nhóm
const HELP_DESC_MAX = 80;       // cắt mô tả quá dài

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function cutDesc(s='') {
  const t = String(s || '');
  return t.length > HELP_DESC_MAX ? t.slice(0, HELP_DESC_MAX) + '…' : t;
}
    
    // ==== /help (phân trang) ====
if (interaction.commandName === 'help') {
  try {
    await interaction.deferReply({ ephemeral: true });

    // Lấy danh sách lệnh đã đăng ký (ưu tiên guild → fallback global)
    let cmds;
    try {
      cmds = await interaction.client.application.commands.fetch({ guildId: interaction.guildId });
    } catch {
      cmds = await interaction.client.application.commands.fetch();
    }

    // Chuẩn hoá
    let all = [...cmds.values()]
      .map(c => ({
        name: String(c.name || '').toLowerCase(),
        description: String(c.description || ''),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Gom theo nhóm đã cấu hình → chỉ lấy nhóm có ít nhất 1 lệnh tồn tại
    const sections = [];
    const picked = new Set();

    for (const cat of HELP_CATEGORIES) {
      const items = all.filter(c => cat.names.includes(c.name));
      if (!items.length) continue;

      picked.add(...items.map(i => i.name));

      const lines = items.map(i => {
        const icon = iconFor(i.name);
        const desc = cutDesc(i.description || 'Không mô tả');
        return `${icon} \`/${i.name}\` — ${desc}`;
      });

      sections.push({
        title: cat.title,
        body: lines.join('\n')
      });
    }

    // Mục "Khác" (các lệnh hợp lệ nhưng không có trong map)
    const others = all.filter(c => !HELP_CATEGORIES.some(cat => cat.names.includes(c.name)));
    if (others.length) {
      const lines = others.map(i => `• \`/${i.name}\` — ${cutDesc(i.description || 'Không mô tả')}`);
      sections.push({ title: '🍀 Khác', body: lines.join('\n') });
    }

    // Nếu rỗng
    if (!sections.length) {
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(0xE04F5F)
          .setTitle('❌ Không thấy lệnh nào')
          .setDescription('Có thể bot chưa đăng ký slash commands cho server này.')
        ],
        ephemeral: true
      });
    }

    // Chia trang: mỗi trang N nhóm
    const pages = chunk(sections, HELP_PAGE_GROUP_SIZE).map((groups, idx, arr) => {
      const embed = new EmbedBuilder()
        .setColor(0x00AAEE)
        .setTitle(`📖 Danh sách lệnh • Trang ${idx + 1}/${arr.length}`)
        .setDescription('Dùng **`/<lệnh>`** để gọi. Danh sách này tự động lấy từ slash commands đã đăng ký.')
        .setTimestamp();

      for (const g of groups) {
        embed.addFields({ name: g.title, value: g.body });
      }
      return embed;
    });

    // Nút điều hướng
    const makeRow = (page, total) => new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`help_prev`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⬅️')
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(`help_close`)
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌'),
      new ButtonBuilder()
        .setCustomId(`help_next`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('➡️')
        .setDisabled(page >= total - 1),
    );

    let page = 0;
    const reply = await interaction.editReply({
      embeds: [pages[page]],
      components: [makeRow(page, pages.length)],
      ephemeral: true
    });

    // Collector cho buttons (chỉ tác giả bấm được)
    const collector = reply.createMessageComponentCollector({
      time: 60_000, // 60s
      filter: (i) => i.user.id === interaction.user.id
    });

    collector.on('collect', async (btn) => {
      try {
        if (btn.customId === 'help_close') {
          collector.stop('closed');
          return btn.update({ components: [] }); // ẩn nút
        }
        if (btn.customId === 'help_prev' && page > 0) page--;
        if (btn.customId === 'help_next' && page < pages.length - 1) page++;

        await btn.update({
          embeds: [pages[page]],
          components: [makeRow(page, pages.length)],
        });
      } catch (e) { /* ignore */ }
    });

    collector.on('end', async () => {
      try {
        await interaction.editReply({
          components: [makeRow(page, pages.length).setComponents(
            ...makeRow(page, pages.length).components.map(b => ButtonBuilder.from(b).setDisabled(true))
          )]
        });
      } catch {}
    });

  } catch (e) {
    console.error('help paging error:', e);
    const fb = new EmbedBuilder()
      .setColor(0xE04F5F)
      .setTitle('⚠️ Không thể hiển thị trợ giúp')
      .setDescription('Đã xảy ra lỗi khi dựng danh sách lệnh.');
    await interaction.editReply({ embeds: [fb], ephemeral: true }).catch(() => {});
  }
}
    // gemini
    if (interaction.commandName === 'gemini') {
      const prompt = interaction.options.getString('prompt', true);
      await interaction.deferReply();
      try {
        if (!process.env.GEMINI_API_KEY) return interaction.editReply('⚠️ Chưa thấy GEMINI_API_KEY trong Secrets.');
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const result = await model.generateContent(prompt);
        const response = (result && result.response && (result.response.text?.() || result.response.text)) || 'Không có nội dung trả lời.';
        const chunks = chunkText(response, 3800);
        const first = new EmbedBuilder()
          .setTitle('🤖 Gemini AI').addFields({ name:'📥 Câu hỏi', value:(prompt || 'N/A').slice(0,1024) })
          .setDescription(chunks[0] || 'N/A').setColor(0x00bfff)
          .setFooter({ text:`Yêu cầu bởi ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
          .setTimestamp();
        await interaction.editReply({ embeds:[first] });
        for (let i=1;i<chunks.length;i++)
          await interaction.followUp({ embeds:[ new EmbedBuilder().setTitle(`🤖 Gemini AI (tiếp ${i+1}/${chunks.length})`).setDescription(chunks[i]).setColor(0x00bfff) ]});
      } catch (err) { console.error('Gemini error =>', err); return interaction.editReply('⚠️ Lỗi khi gọi Gemini API.'); }
    }
    // translate
    if (interaction.commandName === 'translate') {
      const textIn = interaction.options.getString('text', true);
      const to = interaction.options.getString('to') || 'vi';
      const from = interaction.options.getString('from') || 'auto';

      if (textIn.length > 1900) {
        return interaction.reply({ content: '❗ Văn bản dài quá ( >1900 ký tự ). Hãy rút gọn.', ephemeral: true });
      }

      await interaction.deferReply();
      try {
        // Google Translate public endpoint (không cần API key)
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(textIn)}`;
        const { data } = await axios.get(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 15000
        });

        // Lấy kết quả
        const segments = Array.isArray(data?.[0]) ? data[0] : [];
        const translated = segments.map(s => s?.[0]).filter(Boolean).join('');
        const detected = (data && (data[2] || data?.[8]?.[0]?.[0])) || 'auto';
        if (!translated) throw new Error('Empty translation');

        // Cắt text để không vượt limit
        const cut = (s, n = 1000) => (s.length > n ? s.slice(0, n) + '…' : s);
        const srcText = cut(textIn);
        const outText = cut(translated);

        // Lấy giờ VN
        const now = new Date();
        const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });

        // Embed đẹp + emoji
        const embed = new EmbedBuilder()
          .setTitle('🌐 Dịch văn bản')
          .setDescription(`\`${detected}\` → \`${to}\``)
          .addFields(
            { name: '🌸 Gốc', value: srcText || '—' },
            { name: '💬 Dịch', value: outText || '—' },
          )
          .setColor(0x00bfff)
          .setFooter({
            text: `Yêu cầu bởi ${interaction.user.tag}`,
            iconURL: interaction.user.displayAvatarURL()
          })
          .setTimestamp(now);

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('Translate error:', err);
        return interaction.editReply('⚠️ Không dịch được. Thử mã ngôn ngữ khác (vd: `en`, `vi`, `ja`, `ko`, `zh-CN`) hoặc thử lại sau.');
      }
    }


    // weather
    if (interaction.commandName === 'weather') {
      const q = interaction.options.getString('location', true);
      const units = interaction.options.getString('units') || 'metric';
      const days = interaction.options.getInteger('days') || 1;
      await interaction.deferReply();
      try {
        const g = await geocode(q);
        const w = await fetchWeather(g.lat, g.lon, units, days);
        const c = w.current, daily = w.daily;
        const emo = (WMO[c.weather_code] || {})[(c.is_day ? 'd' : 'n')] || '🌡️';
        const desc = (WMO[c.weather_code]?.t) || 'Thời tiết';
        const titleName = `${g.name}, ${g.country}`;
        const embed = new EmbedBuilder()
          .setTitle(`${emo} Thời tiết ở ${titleName}`)
          .setDescription(desc)
          .addFields(
            { name:'Nhiệt độ', value:`${c.temperature_2m}°`, inline:true },
            { name:'Cảm giác', value:`${c.apparent_temperature}°`, inline:true },
            { name:'Độ ẩm', value:`${c.relative_humidity_2m}%`, inline:true },
            { name:'Mây', value:`${c.cloud_cover}%`, inline:true },
            { name:'Gió', value:`${c.wind_speed_10m} ${units==='imperial'?'mph':'km/h'} • ${degToDir(c.wind_direction_10m)} (giật ${c.wind_gusts_10m})`, inline:false },
            { name:'Áp suất', value:`${c.pressure_msl} hPa`, inline:true },
            { name:'Mưa (hiện tại)', value:`${c.precipitation} mm`, inline:true },
            { name:'Hôm nay', value:`⬆️ ${daily.temperature_2m_max[0]}°  ⬇️ ${daily.temperature_2m_min[0]}° • ☂️ ${daily.precipitation_probability_max?.[0] ?? 0}%`, inline:false },
            { name:'Mặt trời', value:`🌅 <t:${toUnix(daily.sunrise[0])}:t>  •  🌇 <t:${toUnix(daily.sunset[0])}:t>`, inline:false },
            { name:'UV (tối đa)', value:`${daily.uv_index_max?.[0] ?? '—'}`, inline:true }
          ).setFooter({ text:`Timezone: ${g.timezone} • Nguồn: Open-Meteo` }).setColor(0x00bfff).setTimestamp();
        const lines = [];
        for (let i=0;i<Math.min(days, daily.time.length);i++){
          const code = daily.weather_code[i];
          const emoD = (WMO[code]?.d) || '🌡️';
          const hi  = daily.temperature_2m_max[i];
          const lo  = daily.temperature_2m_min[i];
          const ppt = daily.precipitation_probability_max?.[i] ?? 0;
          lines.push(`${emoD} **${fmtDay(daily.time[i])}**  ⬆️ ${hi}°  ⬇️ ${lo}°  •  ☂️ ${ppt}%`);
        }
        if (lines.length) embed.addFields({ name:`Dự báo ${lines.length} ngày`, value:lines.join('\n') });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`weather_refresh|${g.lat}|${g.lon}|${units}|${titleName}|${days}`).setLabel('🔁 Cập nhật').setStyle(ButtonStyle.Primary)
        );
        return interaction.editReply({ embeds:[embed], components:[row] });
      } catch { return interaction.editReply('⚠️ Không tìm thấy địa danh hoặc lỗi khi lấy thời tiết.'); }
    }

    // ship
    if (interaction.commandName === 'ship') {
      const u1 = interaction.options.getUser('user1');
      const u2 = interaction.options.getUser('user2');
      let a,b;
      if (u1 && u2) {
        a = await interaction.guild.members.fetch(u1.id).catch(()=>null);
        b = await interaction.guild.members.fetch(u2.id).catch(()=>null);
      } else if (u1) {
        a = await interaction.guild.members.fetch(u1.id).catch(()=>null);
        b = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
      } else if (u2) {
        a = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
        b = await interaction.guild.members.fetch(u2.id).catch(()=>null);
      } else {
        await interaction.guild.members.fetch().catch(()=>{});
        const arr = interaction.guild.members.cache.filter(m => !m.user.bot);
        if (arr.size < 2) return interaction.reply('⚠️ Không đủ thành viên.');
        const list = [...arr.values()];
        const i = Math.floor(Math.random()*list.length);
        let j = Math.floor(Math.random()*(list.length-1)); if (j>=i) j++;
        a = list[i]; b = list[j];
      }
      if (!a || !b) return interaction.reply('⚠️ Không tìm thấy thành viên hợp lệ.');
      if (a.id === b.id) return interaction.reply('😅 Cần 2 người khác nhau để ghép đôi.');

      await interaction.deferReply();
      const percent = Math.floor(Math.random()*101);
      const file = await makeShipCard(a,b,percent);
      const embed = new EmbedBuilder()
        .setTitle(loveEmoji(percent)+' Match Meter: '+percent+'%')
        .setDescription('**'+a.toString()+'** ❤️ **'+b.toString()+'**')
        .setImage('attachment://ship.png').setColor(0xff66aa);
      const cid = 'ship_reroll|'+a.id+'|'+b.id;
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(cid).setLabel('🔁 Reroll').setStyle(ButtonStyle.Primary));
      return interaction.editReply({ embeds:[embed], files:[file], components:[row] });
    }

    // sendnoti
    if (interaction.commandName === 'sendnoti') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
        return interaction.reply({ content:'❌ Cần quyền **Administrator**.', ephemeral:true });

      const content = interaction.options.getString('content', true);
      const title = interaction.options.getString('title') || '📢 Thông báo toàn server';
      const image = interaction.options.getAttachment('image');
      const scope = interaction.options.getString('scope') || 'here';
      const mention = interaction.options.getString('mention') || 'none';
      const imageUrl = image?.url || null;

      sendnotiTemp.set(interaction.user.id, { title, content, imageUrl });
      setTimeout(()=>sendnotiTemp.delete(interaction.user.id), 1000*60*5);

      const preview = new EmbedBuilder()
        .setTitle(title).setDescription(content).setColor(0xF1C40F)
        .setFooter({ text:`Gửi bởi ${interaction.user.tag}` }).setTimestamp();
      if (imageUrl) preview.setImage(imageUrl);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sendnoti_confirm|${interaction.user.id}|${scope}|${mention}`).setLabel('✅ Xác nhận gửi').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`sendnoti_cancel|${interaction.user.id}`).setLabel('❎ Hủy').setStyle(ButtonStyle.Danger),
      );
      return interaction.reply({ content:`**Phạm vi:** ${scope==='all'?'Tất cả server':'Chỉ server này'}\n**Ping:** ${mention==='here'?'@here':mention==='everyone'?'@everyone':'Không'}`, embeds:[preview], components:[row], ephemeral:true });
    }

    // invite
    if (interaction.commandName === 'invite') {
      const appId = client.user.id;
      const min = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=274878221376`;
      const admin = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=8`;
      const embed = new EmbedBuilder()
        .setTitle('🔗 Mời bot vào server')
        .setDescription('Chọn **một** trong hai link bên dưới:\n• **Quyền tối thiểu**: đủ dùng cho các lệnh hiện tại\n• **Quyền Admin**: tiện nếu bạn không muốn cấu hình quyền từng kênh')
        .setColor(0x2ecc71)
        .setFooter({ text:`Yêu cầu bởi ${interaction.user.tag}` }).setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🟩 Quyền tối thiểu').setStyle(ButtonStyle.Link).setURL(min),
        new ButtonBuilder().setLabel('🛡️ Quyền Admin').setStyle(ButtonStyle.Link).setURL(admin),
      );
      return interaction.reply({ embeds:[embed], components:[row], ephemeral:true });
    }

    // MUSIC (YouTube)
    if (interaction.commandName === 'join') {
      try { await ensureConnected(interaction); return interaction.reply('✅ Đã vào kênh thoại.'); }
      catch (e) { return interaction.reply({ content:`⚠️ ${e.message}`, ephemeral:true }); }
    }
    if (interaction.commandName === 'play') {
      const query = interaction.options.getString('query', true);
      await interaction.deferReply();
      try {
        const q = await ensureConnected(interaction);
        const items = await resolveYouTube(query);
        for (const t of items) q.queue.push({ ...t, by: interaction.user.tag });
        if (q.player.state.status !== AudioPlayerStatus.Playing) await playNext(interaction.guildId);
        return interaction.editReply(`🎵 Đã thêm: **${items[0].title}**${items.length>1?` (+${items.length-1} bài trong playlist)`:''}`);
      } catch (e) {
        console.error(e); return interaction.editReply('⚠️ Không thể thêm/phát bài này.');
      }
    }
    if (interaction.commandName === 'skip') {
      const q = getQ(interaction.guildId);
      if (!q.player || !q.now) return interaction.reply('🤷 Chưa phát gì.');
      q.player.stop(); return interaction.reply('⏭️ Đã bỏ qua.');
    }
    if (interaction.commandName === 'stop') {
      const q = getQ(interaction.guildId);
      try { q.queue=[]; q.now=null; q.player?.stop(); q.connection?.destroy(); music.delete(interaction.guildId);}catch{}
      return interaction.reply('🛑 Đã dừng & rời kênh.');
    }
    if (interaction.commandName === 'pause') {
      const q=getQ(interaction.guildId); if(!q.player) return interaction.reply('🤷 Chưa phát gì.');
      q.player.pause(true); return interaction.reply('⏸️ Đã tạm dừng.');
    }
    if (interaction.commandName === 'resume') {
      const q=getQ(interaction.guildId); if(!q.player) return interaction.reply('🤷 Chưa phát gì.');
      q.player.unpause(); return interaction.reply('▶️ Tiếp tục phát.');
    }
    if (interaction.commandName === 'np') {
  const q = getQ(interaction.guildId);
  if (!q.now) {
    return interaction.reply('🤷 Không có bài nào đang phát.');
  }

  // Tính thời gian đã phát và tổng thời lượng
  const pos = Math.floor((q.player.state.resource.playbackDuration || 0) / 1000);
  const dur = q.now.duration || 0;

  // Thanh tiến trình (10 ô)
  const totalBars = 10;
  const progress = dur ? Math.round((pos / dur) * totalBars) : 0;
  const bar = '▬'.repeat(progress) + '🔘' + '▬'.repeat(totalBars - progress);

  return interaction.reply(
    `🎶 **Đang phát:** [${q.now.title}](${q.now.url})\n` +
    `⏱️ ${fmtTime(pos)} / ${fmtTime(dur)}\n` +
    `${bar}`
  );
   }
    if (interaction.commandName === 'queue') {
      const q=getQ(interaction.guildId);
      if (!q.now && !q.queue.length) return interaction.reply('📭 Hàng đợi trống.');
      const lines=[ q.now ? `▶️ **${q.now.title}** (đang phát)` : '', ...q.queue.map((t,i)=>`${i+1}. ${t.title}`) ].filter(Boolean);
      return interaction.reply(lines.join('\n'));
    }
    if (interaction.commandName === 'volume') {
      const p = Math.max(0, Math.min(200, interaction.options.getInteger('percent', true)));
      const q = getQ(interaction.guildId);
      q.volume = p/100;
      try { q.player?.state?.resource?.volume?.setVolume(q.volume); } catch {}
      return interaction.reply(`🔊 Âm lượng: **${p}%**`);
    }
   // == /seek: tua bài đang phát ==
if (interaction.commandName === 'seek') {
  const q = getQ(interaction.guildId);
  if (!q || !q.now || !q.player) {
    return interaction.reply({ content: '🤷 Không có bài nào đang phát để tua.', ephemeral: true });
  }

  // lấy tham số
  let seconds = interaction.options.getInteger('seconds', true);
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;

  // cắt không vượt quá duration (nếu có)
  const dur = Number(q.now.duration || 0);
  if (dur && seconds >= dur) seconds = Math.max(0, dur - 1);

  const currentUrl = q.now.url;
  const currentTitle = q.now.title || '—';
  if (!currentUrl) {
    return interaction.reply({ content: '❌ Không xác định được URL bài hiện tại để tua.', ephemeral: true });
  }

  try {
    // Đặt cờ: lần Idle do stop() sẽ bị bỏ qua
    q.seeking = true;

    // dừng player hiện tại (phát sinh Idle)
    try { q.player.stop(); } catch {}

    let streamObj = null;

    // 1) thử seek trực tiếp theo URL
    try {
      streamObj = await play.stream(currentUrl, { seek: seconds });
    } catch {}

    // 2) nếu vẫn null -> lấy info rồi stream từ info (ổn định hơn cho SoundCloud/HLS)
    if (!streamObj) {
      try {
        const info = await play.soundcloud(currentUrl).catch(() => null);
        if (info) streamObj = await play.stream(info, { seek: seconds });
      } catch {}
    }

    if (streamObj?.stream) {
      // tạo resource từ stream của play-dl
      const res = createAudioResource(streamObj.stream, { inputType: streamObj.type, inlineVolume: true });
      if (q.volume != null && res.volume) res.volume.setVolume(q.volume);
      q.player.play(res);
    } else {
      // 3) fallback cuối: thử ffmpeg -ss (sẽ không hiệu quả với 1 số HLS)
      const res = createAudioResource(currentUrl, {
        inlineVolume: true,
        ffmpeg: { before_options: `-ss ${seconds}` },
      });
      if (q.volume != null && res.volume) res.volume.setVolume(q.volume);
      q.player.play(res);
    }

    // lưu offset để /np cộng thêm và hiển thị đúng
    q.seekOffset = seconds;

    return interaction.reply(`⏩ Đã tua đến **${seconds}s** trong bài **${currentTitle}**`);
  } catch (err) {
    console.error('Seek error:', err);
    // phục hồi phát lại để tránh im lặng
    try {
      const back = await play.stream(q.now?.url || '').catch(() => null);
      if (back?.stream) {
        const r0 = createAudioResource(back.stream, { inputType: back.type, inlineVolume: true });
        if (q.volume != null && r0.volume) r0.volume.setVolume(q.volume);
        q.player.play(r0);
      }
    } catch {}
    return interaction.reply({ content: '❌ Tua bị lỗi. Thử lại sau nhé.', ephemeral: true });
  } finally {
    // nếu vì lý do nào đó Idle không tới, reset cờ sau 1.5s
    setTimeout(() => { if (q.seeking) q.seeking = false; }, 1500);
  }
}
    
 // MUSIC (SoundCloud) – phát trực tiếp URL + tìm kiếm
if (interaction.commandName === 'playsc') {
  const query = interaction.options.getString('query', true);
  await interaction.deferReply({ ephemeral: true });

  // ===== CASE A: URL SoundCloud -> phát trực tiếp
  if (/^https?:\/\/(on\.)?soundcloud\.com\/\S+/i.test(query)) {
    try {
      const q = await ensureConnected(interaction);

      const info = await play.soundcloud(query).catch(() => null);
      if (!info) {
        return interaction.editReply({ content: '❌ Không tìm thấy bài.' });
      }

      // track đưa vào hàng đợi (NHỚ có duration để /np và /seek dùng)
      const track = {
        title: info.name || info.title,
        url: info.url || query,
        duration: info.durationInSec || 0,
        user: interaction.user.username,
      };

      q.queue.push(track);
      if (q.player.state.status !== AudioPlayerStatus.Playing) {
        playNext(interaction.guildId);
      }

      return interaction.editReply({ content: `🎧 Đã thêm **${track.title}** vào hàng đợi.` });
    } catch (e) {
      console.error('playsc URL error:', e);
      return interaction.editReply({ content: '⚠️ Không thể phát link này. Thử link khác hoặc từ khoá.' });
    }
  }

  // ===== CASE B: TÌM KIẾM (trả về danh sách chọn)
  try {
    const term = query.trim().toLowerCase();
    const now = Date.now();
    const cached = scSearchCache.get(term);
    let results;

    const stillValid =
      cached &&
      (now - cached.time < SC_CACHE_TTL) &&
      Array.isArray(cached.results) &&
      cached.results.length;

    if (stillValid) {
      results = cached.results;
      console.log('🎵 SoundCloud search dùng cache cho:', term);
    } else {
      const found = await scSearchTracks(term, 20);
      results = (found || [])
        .map(r => ({
          title: r.title || r.name || 'Bài không tên',
          url: r.url,
          desc: String(pickUploader(r)),
          cover: pickCover(r) || null,
          durationSec: r.durationInSec ?? null, // giữ duration để handler pick dùng
          bpm: r.bpm ?? null,
          plays: r.playback_count ?? r.playCount ?? null,
          likes: r.likes_count ?? r.likes ?? null,
        }))
        .filter(x => x.url);

      if (results.length) {
        scSearchCache.set(term, { time: now, results });
      }
    }

    if (!results || !results.length) {
      return interaction.editReply({ content: '🙁 Không tìm thấy bài phù hợp.' });
    }

    // Lưu store theo nonce để phân trang/chọn
    const nonce = interaction.id;
    scSearchStore.set(nonce, {
      authorId: interaction.user.id,
      results,
      time: Date.now(),
    });
    setTimeout(() => scSearchStore.delete(nonce), SC_STORE_TTL);

    const view = await renderSCPage(nonce, 0);
    return interaction.editReply(view);
  } catch (e) {
    console.error('playsc search error:', e);
    return interaction.editReply({ content: '⚠️ Lỗi tìm kiếm SoundCloud. Thử lại sau nhé.' });
  }
        }   

    // botstats
    if (interaction.commandName === 'botstats') {
      const ws = client.ws.ping; const { color } = pingStyle(ws);
      const botRam = fmtBytes(process.memoryUsage().rss);
      const totalMem = os.totalmem(), freeMem = os.freemem(), usedMem = totalMem - freeMem;
      const sysRam = `${fmtBytes(usedMem)} / ${fmtBytes(totalMem)} (${((usedMem/totalMem)*100).toFixed(1)}%)`;
      const load1 = (os.loadavg?.()[0]) || 0, cores = (os.cpus?.().length) || 1;
      const cpuText = `${os.cpus?.()[0]?.model || 'CPU'}\nTải 1m ~ ${(load1/cores*100).toFixed(1)}% của ${cores} cores`;
      const embed = new EmbedBuilder()
        .setTitle('📊 Bot Statistics')
        .addFields(
          { name:'🟥 WS Ping', value:`${ws}ms`, inline:false },
          { name:'🤖 Bot', value:client.user.tag, inline:false },
          { name:'🟢 Node.js', value:process.version, inline:false },
          { name:'🧠 RAM (Bot)', value:botRam, inline:false },
          { name:'🖥️ RAM (System)', value:sysRam, inline:false },
          { name:'🧮 CPU', value:cpuText, inline:false }
        ).setColor(color).setTimestamp();
      return interaction.reply({ embeds:[embed] });
    }

  } catch (err) {
    console.error('Handler error:', err);
    try {
      if (interaction.deferred && !interaction.replied) {
        return await interaction.editReply({ content:'⚠️ Có lỗi xảy ra khi xử lý lệnh.' });
      }
      if (!interaction.replied) {
        return await interaction.reply({ content:'⚠️ Có lỗi xảy ra khi xử lý lệnh.', ephemeral:true });
      }
      return await interaction.followUp({ content:'⚠️ Có lỗi xảy ra khi xử lý lệnh.', ephemeral:true });
    } catch {}
  }
  // === /news handler (Google News) ===
if (interaction.commandName === 'news') {
  const q = (interaction.options.getString('q') || '').trim();
  const limitOpt = interaction.options.getInteger('limit');
  const limit = Math.max(1, Math.min(5, limitOpt ?? 5));

  await interaction.deferReply(); // công khai (không ephemeral)

  try {
    const items = await fetchGoogleNews(q, limit);
    if (!items.length) {
      return interaction.editReply('🙁 Không tìm thấy tin phù hợp.');
    }

    const title = q ? `📰 Tin mới cho “${q}”` : '📰 Tin mới nhất';
    const embed = new EmbedBuilder()
      .setColor(0x2b6cb0)
      .setTitle(title)
      .setDescription(
        items.map((a, i) =>
          `**${i + 1}. [${a.title}](${a.link})**\n` +
          `${a.source ? `🗞️ ${a.source} • ` : ''}${timeAgo(a.date)}`
        ).join('\n\n')
      )
      .setFooter({ text: 'Nguồn: Google News' })
      .setTimestamp(new Date());

    return interaction.editReply({ embeds: [embed] });
  } catch (e) {
    console.error('news error:', e);
    return interaction.editReply('⚠️ Lỗi lấy tin. Thử lại sau nhé.');
  }
}
  // === /tiktokinfo: xem thông tin hồ sơ TikTok ===
if (interaction.commandName === 'tiktokinfo') {
  const raw = interaction.options.getString('username', true);
  const username = raw.replace(/^@/, '').trim().toLowerCase();

  if (!username) {
    return interaction.reply({ content: '⚠️ Vui lòng nhập username TikTok.', ephemeral: true });
  }

  await interaction.deferReply(); // trả lời công khai

  try {
    const u = await fetchTikTokUserInfo(username);
if (!u) {
  return interaction.editReply('❌ Không tìm thấy người dùng TikTok này.');
}

// cố lấy avatar (API hoặc fallback)
let avatar = u.avatar;
if (!avatar) avatar = await resolveTikTokAvatar(u);
console.log('TikTok avatar URL (final):', avatar);
// 👇 NEW: fallback region
let region = u.region || u.country || '';
if (!region) region = await resolveTikTokRegion(u);
console.log('TikTok region raw:', u.region, u.country, '→ resolved:', region);

const embed = new EmbedBuilder()
  .setColor(0xEE1D52) // màu TikTok
  .setAuthor({
    name: `@${u.uniqueId}${u.verified ? ' • ✔️ Verified' : ''}`,
    iconURL: avatar || undefined,
  })
  .setTitle(u.nickname || u.uniqueId)
  .setURL(`https://www.tiktok.com/@${u.uniqueId}`)
  .setThumbnail(avatar || undefined)
  .setDescription(u.signature || '—');

if (avatar) {
  embed.setImage(avatar); // ảnh lớn bên dưới
}

embed.addFields(
  { name: '👥 Follower',  value: fmtNum(u.followerCount),  inline: true },
  { name: '🤝 Following', value: fmtNum(u.followingCount), inline: true },
  { name: '❤️ Likes',     value: fmtNum(u.heartCount),     inline: true },
  { name: '🎬 Video',      value: fmtNum(u.videoCount),     inline: true },
  { name: '🌐 Khu vực', value: region || 'VN', inline: true },
)
.setFooter({ text: 'Nguồn: TikWM API (public)' })
.setTimestamp(new Date());
return interaction.editReply({ embeds: [embed] });
} catch (e) {
  console.error('tiktokinfo error:', e);
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply('⚠️ Lỗi khi lấy thông tin người dùng. Thử lại sau nhé.');
    }
  } catch {}
  return interaction.reply({
    content: '⚠️ Lỗi khi lấy thông tin người dùng. Thử lại sau nhé.',
    ephemeral: true
  });
}   // <-- kết thúc try/catch
}   // <-- kết thúc if (interaction.commandName === 'tiktokinfo')

  // === /insta handler ===
if (interaction.commandName === 'insta') {
  const url = interaction.options.getString('url', true).trim();

  await interaction.deferReply(); // trả lời công khai

  try {
    // GỌI DÙNG TIỆN ÍCH
    const { medias, meta } = await fetchInstagramViaDownr(url);

    if (!Array.isArray(medias) || medias.length === 0) {
      return interaction.editReply('⚠️ Không tải được media từ link Instagram.');
    }

    // --- Embed thông tin ---
    const embed = new EmbedBuilder()
      .setColor(0xff3399)
      .setTitle('📷 Instagram Downloader')
      .setDescription(
        meta?.caption
          ? (meta.caption.length > 800 ? meta.caption.slice(0, 800) + '…' : meta.caption)
          : 'Tải thành công!'
      )
      .setFooter({ text: `Nguồn: Instagram${meta?.author ? ` • Tác giả: ${meta.author}` : ''}` })
      .setTimestamp(new Date());

    if (meta?.thumbnail && /^https?:\/\/\S+/.test(meta.thumbnail)) {
      embed.setImage(meta.thumbnail);
    }

    // === Tạo tối đa 20 nút "Mở media", mỗi row 5 nút ===
const MAX_BTNS = 20;
const btnMedias = medias.slice(0, MAX_BTNS);

const rows = [];
for (let i = 0; i < btnMedias.length; i += 5) {
  const chunk = btnMedias.slice(i, i + 5);

  const row = new ActionRowBuilder().addComponents(
    ...chunk.map((m, idx) => {
      const isVideo = /video/i.test(m.type || '') || /\.mp4(?:\?|$)/i.test(m.url || '');
      const icon = isVideo ? '🎬' : '🖼️';
      const label =
        `${icon} Mở media ${i + idx + 1}` +
        (m.quality ? ` • ${m.quality}` : '');

      return new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(label)
        .setURL(m.url);
    })
  );

  rows.push(row);
}

// Gửi embed + nhiều row nút
await interaction.editReply({
  embeds: [embed],
  components: rows,
});
  } catch (e) {
    console.error('insta handler error:', e);
    const msg = '⚠️ Có lỗi khi xử lý link Instagram.';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg);
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
  }
} 
  // === /instaauto ===
if (interaction.commandName === 'instaauto') {
  const mode = interaction.options.getString('mode', true);
  await loadInstaSettings();
  const gid = interaction.guildId;

  instaSettings.guilds[gid] = {
    mode,
    channelId: interaction.channelId, // dùng khi chọn 'channel'
  };
  await saveInstaSettings();

  const msg =
    mode === 'off'    ? 'Đã tắt auto Instagram cho server này.'
  : mode === 'server' ? 'Đã bật auto Instagram cho toàn server.'
                      : 'Đã bật auto Instagram cho kênh này.';

  return interaction.reply({ content: `✅ ${msg}`, ephemeral: true });
}
 // ===================== /fb handler (Downr) =====================
if (interaction.commandName === 'fb') {
  const link = interaction.options.getString('url', true).trim();
  await interaction.deferReply(); // cho bot thời gian lấy link

  try {
    // gọi downr để lấy media + meta
    const { medias, meta } = await fetchFacebookViaDownr(link);

    if (!medias.length) {
      return interaction.editReply({
        content: '⚠️ Không tìm thấy link tải từ bài viết này. Hãy chắc là bài viết **public** hoặc thử link khác nhé.',
      });
    }

    // ==== gửi EMBED trước (thumbnail + caption + author)
    const embed = new EmbedBuilder()
      .setColor(0x1877f2)
      .setTitle('⬇️ Facebook Downloader')
      .setDescription('✅ Tải thành công! 🎉')
      .setFooter({ text: 'Nguồn: Facebook Public Post' })
      .setTimestamp(new Date());

    if (meta?.thumbnail) embed.setImage(meta.thumbnail);
    if (meta?.caption || meta?.title) {
      embed.addFields({
        name: '📖 Caption',
        value: trimField(meta.caption || meta.title, 1024),
      });
    }
    if (meta?.author) {
      embed.addFields({
        name: '✍️ Tác giả',
        value: trimField(meta.author, 256),
        inline: true,
      });
    }

    await interaction.editReply({ embeds: [embed] });

    // ==== sau đó gửi FILE tốt nhất
    const best = pickBestMedia(medias);
    if (!best?.url) return;

    await interaction.followUp({
      files: [
        {
          attachment: best.url,
          name: safeFilename(
            `facebook.${best.ext || (best.type === 'image' ? 'jpg' : 'mp4')}`
          ),
        },
      ],
    });

  } catch (e) {
    console.error('fb handler error:', e?.response?.status, e?.message);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply('⚠️ Lỗi khi xử lý link Facebook.');
    } else {
      await interaction.reply({ content: '⚠️ Lỗi khi xử lý link Facebook.', ephemeral: true });
    }
  }
}
  // === /fbauto handler ===
if (interaction.commandName === 'fbauto') {
  const mode = interaction.options.getString('mode', true);

  await loadFacebookSettings();
  const gid = interaction.guildId;
  fbSettings.guilds[gid] = fbSettings.guilds[gid] || {};

  if (mode === 'off') {
    delete fbSettings.guilds[gid];
    await saveFacebookSettings();
    return interaction.reply({ content: '✅ Đã tắt auto Facebook cho server này.', ephemeral: true });
  }

  if (mode === 'server') {
    fbSettings.guilds[gid] = { mode: 'server' };
    await saveFacebookSettings();
    return interaction.reply({ content: '✅ Đã bật auto Facebook cho **toàn server**.', ephemeral: true });
  }

  if (mode === 'channel') {
    fbSettings.guilds[gid] = { mode: 'channel', channelId: interaction.channelId };
    await saveFacebookSettings();
    return interaction.reply({ content: '✅ Đã bật auto Facebook cho **kênh này**.', ephemeral: true });
  }
}
  // ====== /capcut ======
if (interaction.commandName === 'capcut') {
  const url = interaction.options.getString('url', true);
  await interaction.deferReply();

  try {
    const { medias, meta } = await fetchCapcutViaDownr(url);
    if (!medias?.length) {
      return interaction.editReply('⚠️ Không lấy được media từ link CapCut.');
    }

    // Ưu tiên video
    const pick =
      medias.find(m => /capcutvod\.com/i.test(m.url)) ||
      medias.find(m => /mime_type=video/i.test(m.url)) ||
      medias.find(m => /video/i.test(m.type)) ||
      medias[0];

    // Embed thông tin
    const embed = new EmbedBuilder()
      .setColor(0x00d084)
      .setTitle(`✂️ CapCut: ${meta.title || 'Template'}`)
      .setURL(meta.originalUrl || url)
      .setDescription(meta.author ? `👤 Tác giả: **${meta.author}**` : '')
      .setFooter({ text: 'Nguồn: CapCut • Downr.org' })
      .setTimestamp(new Date());

    if (meta.thumbnail && /^https?:\/\//i.test(meta.thumbnail)) {
      embed.setImage(meta.thumbnail);
    }

    await interaction.editReply({ embeds: [embed] });

// ==== GỬI VIDEO KHÔNG HIỆN LINK DÀI ====
const chosen = pick || medias.find(m => /video/i.test(m.type)) || medias[0];
if (chosen) {
  const safe = (s) => String(s || '')
    .normalize('NFKD').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_')
    .slice(0, 40);
  const fileName = `capcut_${safe(meta.title)}${chosen.ext ? '.'+chosen.ext : '.mp4'}`;

  try {
    await interaction.followUp({
      files: [{ attachment: chosen.url, name: fileName }]
    });
  } catch (e) {
    try {
      const resp = await axios.get(chosen.url, {
        responseType: 'arraybuffer',
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const buf = Buffer.from(resp.data);

      const LIMIT = 25 * 1024 * 1024; // 25MB
      if (buf.length > LIMIT) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('⬇️ Tải video').setURL(chosen.url),
          new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('✂️ Dùng template').setURL(meta.originalUrl || url)
        );
        await interaction.followUp({ content: '📦 Video lớn hơn giới hạn upload.', components: [row] });
      } else {
        await interaction.followUp({
          files: [{ attachment: buf, name: fileName }]
        });
      }
    } catch {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('⬇️ Tải video').setURL(chosen.url),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('✂️ Dùng template').setURL(meta.originalUrl || url)
      );
      await interaction.followUp({ components: [row] });
    }
  }
}

  } catch (e) {
    console.error('[CapCut handler error]', e);
    return interaction.editReply('❌ Có lỗi khi xử lý link CapCut.');
  }
}
 // === /capcutauto ===
if (interaction.commandName === 'capcutauto') {
  const mode = interaction.options.getString('mode', true);
  await loadCapcutSettings();
  const gid = interaction.guildId;

  capcutSettings.guilds[gid] = {
    mode,
    channelId: interaction.channelId, // dùng khi chọn 'channel'
  };
  await saveCapcutSettings();

  const msg =
    mode === 'off'    ? 'Đã tắt auto CapCut cho server này.'
  : mode === 'server' ? 'Đã bật auto CapCut cho toàn server.'
                      : 'Đã bật auto CapCut cho kênh này.';

  return interaction.reply({ content: `✅ ${msg}`, ephemeral: true });
} 
});

// ------------------- misc helpers -------------------
function loveEmoji(p) { if (p>=90) return '💖💖💖'; if (p>=75) return '💞💞'; if (p>=50) return '💘'; if (p>=25) return '💛'; return '🖤'; }

async function makeShipCard(memberA, memberB, percent) {
  const W=1000,H=400; const canvas=createCanvas(W,H); const ctx=canvas.getContext('2d');
  const g=ctx.createLinearGradient(0,0,W,H); g.addColorStop(0,'#ff8bd3'); g.addColorStop(1,'#a66cff'); ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  for (let i=0;i<10;i++){ const r=Math.random()*80+40,x=Math.random()*W,y=Math.random()*H; const gg=ctx.createRadialGradient(x,y,0,x,y,r); gg.addColorStop(0,'rgba(255,255,255,.2)'); gg.addColorStop(1,'rgba(255,255,255,0)'); ctx.fillStyle=gg; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); }
  ctx.fillStyle='#fff'; ctx.shadowColor='rgba(0,0,0,.25)'; ctx.shadowBlur=10;
  ctx.font='bold 54px sans-serif'; ctx.textAlign='center'; ctx.fillText('Perfect Match?', W/2, 80); ctx.shadowBlur=0;

  const left=220,right=W-220,cy=220,rad=110;
  async function drawAvatar(member, x){
    const url = member.user.displayAvatarURL({ extension: 'png', size: 256 });
    const img = await loadImage(url);
    ctx.save(); ctx.beginPath(); ctx.arc(x, cy, rad, 0, Math.PI*2); ctx.clip();
    ctx.drawImage(img, x-rad, cy-rad, rad*2, rad*2); ctx.restore();
    ctx.lineWidth=8; ctx.strokeStyle='rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.arc(x, cy, rad+4, 0, Math.PI*2); ctx.stroke();
  }
  await drawAvatar(memberA,left); await drawAvatar(memberB,right);

  ctx.fillStyle='#fff'; ctx.font='bold 80px sans-serif'; ctx.fillText('❤', W/2, 160);
  ctx.font='bold 64px sans-serif'; ctx.fillText(`${percent}%`, W/2, 220);
  ctx.font='bold 28px sans-serif'; ctx.fillText(`${memberA.displayName}  ×  ${memberB.displayName}`, W/2, 300);

  const buffer = canvas.toBuffer('image/png');
  return new AttachmentBuilder(buffer, { name:'ship.png' });
}

// ------------------- weather + meme helpers -------------------
async function geocode(name){
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=vi&format=json`;
  const { data } = await axios.get(url);
  if (!data || !data.results || !data.results.length) throw new Error('Không tìm thấy địa danh.');
  const r = data.results[0];
  return { lat:r.latitude, lon:r.longitude, name:r.name, country:r.country, timezone:r.timezone };
}
async function fetchWeather(lat, lon, units='metric', days=1){
  const temperature_unit = units === 'imperial' ? 'fahrenheit' : 'celsius';
  const wind_speed_unit  = units === 'imperial' ? 'mph' : 'kmh';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day,precipitation`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max`
    + `&timezone=auto&forecast_days=${days}`
    + `&temperature_unit=${temperature_unit}&wind_speed_unit=${wind_speed_unit}`;
  const { data } = await axios.get(url);
  return data;
}

// ------------------- YouTube resolver (ví dụ tối giản) -------------------
async function resolveYouTube(query){
  const result = await play.search(query, { limit: 1, source: { youtube: 'video' } });
  if (!result?.length) throw new Error('Không tìm thấy video YouTube.');
  return [{ title: result[0].title || 'YouTube Video', url: result[0].url }];
}

// ------------------- login -------------------
client.login(process.env.TOKEN);


// ================ QUIZ FEATURE (patched) ================

// Lưu trạng thái theo messageId
const quizStore = new Map(); // messageId -> { correct:'A'|'B'|'C'|'D', endsAt:number, timer: Timeout }

function buildQuizEmbed(q, seconds = 15) {
  return new EmbedBuilder()
    .setTitle('🧠 Đố vui trắc nghiệm')
    .setDescription(`**Câu hỏi:** ${q.question}\n\nA. ${q.options.A}\nB. ${q.options.B}\nC. ${q.options.C}\nD. ${q.options.D}`)
    .setFooter({ text: `Bạn có ${seconds} giây để trả lời` });
}
function buildRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('quiz:A').setLabel('A').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('quiz:B').setLabel('B').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('quiz:C').setLabel('C').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('quiz:D').setLabel('D').setStyle(ButtonStyle.Primary).setDisabled(disabled)
  );
}

// Slash command /quiz
// Trong handler interactionCreate của bạn, ở nhánh commandName === 'quiz':
async function handleQuizSlash(interaction, questions) {
  // Lấy 1 câu ngẫu nhiên từ quiz.json
  if (!Array.isArray(questions) || questions.length === 0) {
    // dùng flags 64 thay cho ephemeral để tránh warning
    await interaction.reply({ content: '⚠️ Chưa có câu hỏi trong **quiz.json**', flags: 64 });
    return;
  }
  const q = questions[Math.floor(Math.random() * questions.length)];

  // Trả lời ngay và lấy message để edit về sau
  const msg = await interaction.reply({
    embeds: [buildQuizEmbed(q)],
    components: [buildRow(false)],
    fetchReply: true
  });

  // Lưu trạng thái + tự chấm sau 15s
  const endsAt = Date.now() + 15000;
  const t = setTimeout(async () => {
    const state = quizStore.get(msg.id);
    if (!state) return;
    try {
      // Hết giờ: khóa nút + hiển thị đáp án đúng
      await msg.edit({
        embeds: [
          EmbedBuilder.from(msg.embeds[0]).setFooter({ text: `⏰ Hết giờ • Đáp án đúng: ${state.correct}` })
        ],
        components: [buildRow(true)]
      });
    } catch {}
    quizStore.delete(msg.id);
  }, 15000);

  quizStore.set(msg.id, { correct: q.answer, endsAt, timer: t });
}

// Xử lý click nút
client.on('interactionCreate', async (interaction) => {
  try {
    // Click trên message có nút
    if (interaction.isButton() && interaction.customId.startsWith('quiz:')) {
      // Đáp án người dùng chọn
      const choice = interaction.customId.split(':')[1];
      const msgId = interaction.message?.id;
      const state = quizStore.get(msgId);

      // Không còn trạng thái -> hết hạn hoặc đã chấm
      if (!state) {
        // dùng update để tránh reply 2 lần
        await interaction.update({ components: [buildRow(true)] }).catch(() => {});
        return;
      }

      // Khóa timer & xóa state
      clearTimeout(state.timer);
      quizStore.delete(msgId);

      // Tạo hàng nút đã disable
      const disabledRow = buildRow(true);

      // Chấm điểm & cập nhật message (update để trả lời tương tác nút trong <3s)
      const correct = state.correct;
      const resultText = choice === correct ? `✅ Chính xác! Đáp án đúng là **${correct}**` : `❌ Sai mất rồi. Đáp án đúng là **${correct}**`;

      await interaction.update({
        embeds: [
          EmbedBuilder.from(interaction.message.embeds[0])
            .setFooter({ text: resultText })
        ],
        components: [disabledRow]
      });
      return;
    }

    // Slash /quiz (ví dụ bạn đặt commandName là 'quiz')
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      if (interaction.commandName === 'quiz') {
        // Nạp câu hỏi (đảm bảo đường dẫn đúng)
        let questions = [];
        try {
          questions = JSON.parse(require('fs').readFileSync('./quiz.json', 'utf8'));
        } catch {}
        await handleQuizSlash(interaction, questions);
      }
    }
  } catch (e) {
    console.error('quiz handler error:', e);
    // Tránh lỗi 10062: không reply muộn nữa
  }
});


// Safe reply for handling repeated responses
async function safeReply(interaction, data) {
  try {
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(data);
    } else {
      return await interaction.reply(data);
    }
  } catch (e) {
    try { return await interaction.followUp(data); } catch (_) {}
    throw e;
  }
}

// Handle /quiz
client.on('interactionCreate', async (interaction) => {
  if (interaction.commandName === 'quiz') {
    try {
      await interaction.deferReply(); // ack slash before
      const quiz = pickQuiz();
      if (!quiz) return interaction.editReply({ content: '⚠️ No quiz found.' });
      
      const labels = ['A','B','C','D'];
const embed = new EmbedBuilder();

const desc = `**Question:** ${quiz.q}\n\n${
  quiz.choices.map((c, i) => `**${labels[i]}**. ${c}`).join('\n')
}`;

embed
  .setTitle('🧠 Quiz')
  .setDescription(desc)
  .setColor(0x5865F2)
  .setFooter({ text: `You have ${QUIZ_DURATION_MS / 1000} seconds to answer` });

      const prefix = `quiz:${nonce}`;
      const row = buildQuizRow(prefix, false);

      await interaction.editReply({ embeds: [embed], components: [row] });

      // auto khoá nút khi hết giờ
      setTimeout(async () => {
        const data = quizStore.get(nonce);
        if (!data) return;
        // disable nếu vẫn còn
        try {
          const msg = await interaction.fetchReply();
          await msg.edit({ components: [buildQuizRow(prefix, true)] });
        } catch {}
        quizStore.delete(nonce);
      }, QUIZ_DURATION_MS + 500);
    } catch (e) {
      console.error('quiz cmd error:', e);
      try {
        await interaction.editReply({ content: '⚠️ Không thể tạo câu hỏi lúc này.' });
      } catch {}
    }
  }
});

// Handle quiz answer button
client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('quiz|')) {
    try {
      // ack NGAY để tránh 10062
      if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();

      const [, sid, choiceStr] = interaction.customId.split('|');
      const choiceIdx = Number(choiceStr);
      const data = quizStore.get(sid);

      // hết giờ hoặc session không tồn tại
      if (!data || Date.now() > data.endsAt) {
        return interaction.followUp({ ephemeral:true, content:'⏱️ Hết giờ hoặc phiên đã kết thúc.' }).catch(()=>{});
      }

      // mỗi người chỉ chọn 1 lần
      if (data.chosen.has(interaction.user.id)) {
        return interaction.followUp({ ephemeral:true, content:'🛑 Bạn đã trả lời câu này rồi.' }).catch(()=>{});
      }
      data.chosen.add(interaction.user.id);

      const correct = (choiceIdx === data.ans);

      // thưởng (nếu bạn có addBal)
      let rewardText = '';
      if (correct) {
        try {
          const balAfter = addBal?.(interaction.user.id, QUIZ_REWARD);
          rewardText = `
🐣 +${QUIZ_REWARD.toLocaleString('vi-VN')} coin • Số dư: **${balAfter.toLocaleString('vi-VN')}**`;
        } catch {}
      }

      // phản hồi kết quả (ephemeral)
      await interaction.followUp({
        ephemeral: true,
        content: correct
          ? `✅ Chính xác!${rewardText}${data.exp ? `
ℹ️ ${data.exp}` : ''}`
          : `❌ Chưa đúng. Đáp án đúng là **${['A','B','C','D'][data.ans]}**${data.exp ? `
ℹ️ ${data.exp}` : ''}`
      }).catch(()=>{});
    } catch (e) {
      console.error('quiz button error:', e);
    }
  }
});



// ====================== HÀM CHUNG: lấy dữ liệu & build kết quả ======================
async function fetchTikTokPayload(inputUrlRaw) {
  // 1) Làm sạch & bắt URL
  const m = String(inputUrlRaw || "").match(/https?:\/\/(?:www\.)?(?:vt\.|www\.)?tiktok\.com\/[^\s<>)]+/i);
  if (!m) throw new Error("NO_URL");

  let inputUrl = m[0]
    .replace(/[<>()\[\]\s]/g, "")
    .replace(/[,;]+$/g, "")
    .trim();

  // 2) Resolve vt.tiktok.com nếu có
  let resolvedUrl = inputUrl;
  try {
    if (/https?:\/\/(www\.)?vt\.tiktok\.com/i.test(inputUrl)) {
      const head = await axios.head(inputUrl, {
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
        timeout: 10000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        },
      });
      const loc = head.headers?.location;
      if (loc) {
        resolvedUrl = loc.startsWith("http")
          ? new URL(loc).href
          : new URL(loc, "https://vt.tiktok.com").href;
      }
    }
  } catch { /* bỏ qua, dùng inputUrl */ }

  // 3) Gọi API
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(resolvedUrl)}`;
  const resp = await axios.get(apiUrl, { timeout: 15000 });
  const apiData = resp.data;
  if (!apiData || apiData.code !== 0 || !apiData.data) throw new Error("API_FAIL");

  const v = apiData.data;
  const author = v.author || {};

  // ===== build embed =====
  const nf  = (n) => (n ?? 0).toLocaleString("vi-VN");
  const dur = (s) => {
    const mm = Math.floor((s ?? 0) / 60);
    const ss = Math.floor((s ?? 0) % 60);
    return `${mm}:${String(ss).padStart(2, "0")}`;
  };

  const cover = v.cover || v.dynamic_cover || v.origin_cover || author.avatar || null;

  const likes    = v.digg_count    ?? v.stats?.digg_count    ?? 0;
  const comments = v.comment_count ?? v.stats?.comment_count ?? 0;
  const shares   = v.share_count   ?? v.stats?.share_count   ?? 0;
  const plays    = v.play_count    ?? v.stats?.play_count    ?? 0;
  const duration = v.duration      ?? v.video?.duration      ?? 0;
  const region   = v.region        ?? v.stats?.region        ?? "";

  let title = v.title?.slice(0, 240) || "Video TikTok";
  if ((!title || title === "Video TikTok") && v.music?.title) title = `🎵 ${v.music.title}`;

  const embed = new EmbedBuilder()
    .setColor(0x80d2ea)
    .setTitle(title)
    .setURL(resolvedUrl || inputUrl)
    .setThumbnail(cover)
    .setAuthor({
      name: author.nickname || author.unique_id || "TikTok",
      iconURL: author.avatar || null,
    })
    .addFields(
      { name: "❤️ Thích",      value: nf(likes),    inline: true },
      { name: "💬 Bình luận",  value: nf(comments), inline: true },
      { name: "🔁 Chia sẻ",    value: nf(shares),   inline: true },
      { name: "▶️ Lượt xem",   value: nf(plays),    inline: true },
      { name: "⏱️ Thời lượng", value: dur(duration),inline: true },
      { name: "🌍 Khu vực",    value: region || "—",inline: true },
    )
    .setFooter({ text: "Nguồn: TikTok" })
    .setTimestamp(v.create_time ? new Date(v.create_time * 1000) : new Date());

  // Ảnh
  const imageUrls = Array.isArray(v.images)
    ? v.images
        .map(x => (typeof x === "string" ? x : (x?.url || x?.img_url || x?.src)))
        .filter(Boolean)
    : [];

  // Video (nếu không phải bài ảnh)
  let videoUrl = null;
  if (imageUrls.length === 0) {
    const cands = [
      v.video?.no_watermark,
      v.video?.no_watermark_hd,
      v.video?.nowatermark,
      v.nowatermark,
      v.hdplay,
      v.play,
      v.wmplay,
    ].filter(Boolean);
    videoUrl = cands.find(u => /^https?:\/\//i.test(u)) || null;
  }

  return { embed, imageUrls, videoUrl };
}

// ========================= SLASH /tiktok =========================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "tiktok") return;

  try {
    await interaction.deferReply();

    const urlFromOption = interaction.options.getString("url", true);
    const { embed, imageUrls, videoUrl } = await fetchTikTokPayload(urlFromOption);

    // Gửi EMBED trước
    await interaction.editReply({ embeds: [embed] });

    // Bài ảnh
    if (imageUrls.length) {
      await interaction.followUp({
        files: imageUrls.slice(0, 10).map((u, i) => ({ attachment: u, name: `tiktok_${i + 1}.jpg` })),
      });
      return;
    }

    // Video
    if (videoUrl) {
      const isMp4 = /\.mp4(\?|$)/i.test(videoUrl) || /mime_type=video_mp4/i.test(videoUrl);
      if (isMp4) {
        try {
          await interaction.followUp({
            files: [{ attachment: videoUrl, name: `tiktok_${Date.now()}.mp4` }],
          });
          return;
        } catch {
          // fallback sang nút link
        }
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("▶️ Mở/Tải video").setStyle(ButtonStyle.Link).setURL(videoUrl),
      );

      await interaction.followUp({
        content: "⚠️ Không gửi được file video. Nhấn nút để mở/tải.",
        components: [row],
      });
      return;
    }

    await interaction.followUp("❌ Không tìm thấy video/ảnh để tải.");
  } catch (err) {
    console.error("Slash /tiktok error:", err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "❌ Có lỗi xảy ra. Hãy thử lại sau.", ephemeral: true });
    } else {
      await interaction.reply({ content: "❌ Có lỗi xảy ra. Hãy thử lại sau.", ephemeral: true });
    }
  }
});

// ========================= SLASH /tiktokauto =========================
// Bạn nhớ đã đăng ký slash này: name "tiktokauto" + string option "mode" (off|server|channel)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "tiktokauto") return;

  const mode = interaction.options.getString("mode", true); // 'off' | 'server' | 'channel'
  const gid = interaction.guildId;
  if (!gid) {
    return interaction.reply({ content: "Lệnh này chỉ dùng trong server.", ephemeral: true });
  }

  const g = tiktokSettings.guilds[gid] || (tiktokSettings.guilds[gid] = { mode: "off" });

  if (mode === "off") {
    g.mode = "off";
    delete g.channelId;
  } else if (mode === "server") {
    g.mode = "server";
    delete g.channelId;
  } else if (mode === "channel") {
    g.mode = "channel";
    g.channelId = interaction.channelId;
  } else {
    return interaction.reply({ content: "❌ Mode không hợp lệ.", ephemeral: true });
  }

  await saveTikTokSettings();

  return interaction.reply({
    content:
      g.mode === "off"
        ? "🔕 Đã tắt auto TikTok."
        : g.mode === "server"
        ? "✅ Đã bật auto TikTok cho **toàn server**."
        : `✅ Đã bật auto TikTok cho **kênh này** (<#${g.channelId}>)`,
    ephemeral: true,
  });
});

// ========================= AUTO tải khi có link (theo cấu hình) =========================
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!isTikTokAutoEnabledForMessage(message)) return;

    const { embed, imageUrls, videoUrl } = await fetchTikTokPayload(message.content);

    // EMBED trước
    await message.channel.send({ embeds: [embed] });

    // Bài ảnh
    if (imageUrls.length) {
      await message.channel.send({
        files: imageUrls.slice(0, 10).map((u, i) => ({ attachment: u, name: `tiktok_${i + 1}.jpg` })),
      });
      return;
    }

    // Video
    if (videoUrl) {
      const isMp4 = /\.mp4(\?|$)/i.test(videoUrl) || /mime_type=video_mp4/i.test(videoUrl);
      if (isMp4) {
        try {
          await message.channel.send({
            files: [{ attachment: videoUrl, name: `tiktok_${Date.now()}.mp4` }],
          });
          return;
        } catch {
          // fallback sang link
        }
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("▶️ Mở/Tải video").setStyle(ButtonStyle.Link).setURL(videoUrl),
      );
      await message.channel.send({
        content: "⚠️ Không gửi được file video. Nhấn nút để mở/tải.",
        components: [row],
      });
      return;
    }

    await message.channel.send("❌ Không tìm thấy video/ảnh để tải.");
  } catch (err) {
    if (err?.message !== "NO_URL") {
      console.error("Auto TikTok error:", err?.message || err);
    }
  }
});

// ------------ utils: Google News ------------
function decodeHtml(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Thời gian tương đối “x phút/giờ/ngày trước”
function timeAgo(date) {
  try {
    const d = (date instanceof Date) ? date : new Date(date);
    const sec = Math.max(1, Math.floor((Date.now() - d.getTime()) / 1000));
    if (sec < 60) return `${sec}s trước`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} phút trước`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} giờ trước`;
    const day = Math.floor(hr / 24);
    return `${day} ngày trước`;
  } catch {
    return '';
  }
}

// Lấy tin từ Google News RSS (VN/vi). Query rỗng => top headlines
async function fetchGoogleNews(query = '', limit = 5) {
  const base = query
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=vi&gl=VN&ceid=VN:vi`
    : `https://news.google.com/rss?hl=vi&gl=VN&ceid=VN:vi`;

  const xml = await fetch(base, { headers: { 'User-Agent': 'discord-bot' } }).then(r => r.text());

  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < limit) {
    const block = m[1];

    const pick = (tag) => {
      const mm = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
      return mm ? decodeHtml(mm[1].trim()) : '';
    };

    const title = pick('title');
    let link = pick('link');
    const pub = pick('pubDate');
    const source = pick('source');

    // dọn link
    link = link.replace(/&amp;/g, '&');

    items.push({
      title,
      link,
      source,
      date: pub ? new Date(pub) : new Date(),
    });
  }

  return items;
      }
// === utils: TikTok user info qua TikWM (robust) ===
async function fetchTikTokUserInfo(username) {
  const url = `https://www.tikwm.com/api/user/info?unique_id=${encodeURIComponent(username)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (DiscordBot)' } }).catch(() => null);
  if (!res) return null;

  const data = await res.json().catch(() => null);
  if (!data || data.code !== 0 || !data.data) return null;

  // TikWM có nhiều layout: đôi khi { user, stats }, đôi khi dồn vào user
  const root  = data.data;
  const user  = root.user || root;
  const stats = root.stats || user.stats || {};

  // Ép số an toàn
  const N = v => {
    const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  return {
    uniqueId:   user.unique_id || user.uniqueId || username,
    nickname:   user.nickname || '',
    avatar:     user.avatar_large || user.avatar_thumb || user.avatar || null,
    signature:  user.signature || '',
    verified:   !!(user.verified ?? user.is_verified),

    // Hỗn hợp các khả năng tên field
    followerCount: N(stats.followerCount ?? user.follower_count ?? stats.follower_count),
    followingCount:N(stats.followingCount ?? user.following_count ?? stats.following_count),
    heartCount:    N(stats.heartCount ?? stats.heart ?? user.total_favorited ?? user.heart_count),
    videoCount:    N(stats.videoCount ?? stats.video ?? user.aweme_count ?? user.video_count),

    region:     user.region || user.country || root.region || root.country || '—',
  };
}
// Fallback: cố lấy khu vực (region/country) từ profile TikTok
async function resolveTikTokRegion(u) {
  try {
    // 1) API đã có -> dùng luôn
    const have = (u?.region || u?.country || '').toString().trim();
    if (have) return prettyCountry(have);

    const uname = (u?.uniqueId || u?.username || '').trim();
    if (!uname) return '';

    // 2) Lấy HTML qua proxy
    const url = `https://r.jina.ai/http://www.tiktok.com/@${encodeURIComponent(uname)}`;
    const html = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (DiscordBot)',
        'Accept-Language': 'vi,en;q=0.8'
      }
    }).then(r => r.text()).catch(() => null);
    if (!html) return '';

    // 3) Thử thật nhiều key thường gặp
    let m =
      /"region"\s*:\s*"([A-Za-z]{2})"/i.exec(html) ||
      /"country"\s*:\s*"([A-Za-z]{2})"/i.exec(html) ||
      /"countryCode"\s*:\s*"([A-Za-z]{2})"/i.exec(html) ||
      /"country_code"\s*:\s*"([A-Za-z]{2})"/i.exec(html) ||
      /"regionCode"\s*:\s*"([A-Za-z]{2})"/i.exec(html) ||
      /property=["']og:locale["'][^>]+content=["'][a-z]{2}[-_]?([A-Za-z]{2})["']/i.exec(html);

    if (m && m[1]) return prettyCountry(m[1].toUpperCase());

    // 4) Fallback: chuỗi location dạng chữ
    const mLoc =
      /"location"\s*:\s*"([^"]+)"/i.exec(html) ||
      /"country_name"\s*:\s*"([^"]+)"/i.exec(html);
    if (mLoc && mLoc[1]) {
      const loc = mLoc[1].trim();
      // nếu là mã 2 chữ -> chuẩn hoá, nếu là tên -> trả tên
      return /^[A-Za-z]{2}$/.test(loc) ? prettyCountry(loc) : loc;
    }

    return '';
  } catch {
    return '';
  }
}

// Hiển thị tên quốc gia tiếng Việt nếu có thể
function prettyCountry(codeOrName) {
  try {
    if (!codeOrName) return '';
    const v = codeOrName.toString().trim();

    // Nếu là mã 2 chữ (VN, US, …) thì đổi sang tên tiếng Việt
    if (/^[A-Za-z]{2}$/.test(v)) {
      const dn = new Intl.DisplayNames(['vi'], { type: 'region' });
      const name = dn.of(v.toUpperCase());
      return name ? `${name} (${v.toUpperCase()})` : v.toUpperCase();
    }

    // Nếu đã là tên (Vietnam, United States, …) thì trả luôn
    return v;
  } catch {
    return codeOrName || '';
  }
}
// Fallback: lấy avatar qua các nguồn công khai (ưu tiên ổn định)
async function resolveTikTokAvatar(u) {
  try {
    // 1) Nếu API đã có ảnh hợp lệ thì dùng luôn
    if (u?.avatar && /^https?:\/\//.test(u.avatar)) return u.avatar;

    const uname = (u?.uniqueId || u?.username || '').trim();
    if (!uname) return null;

    // 2) unavatar.io — ổn định, không cần token
    const unavatar = `https://unavatar.io/tiktok/${encodeURIComponent(uname)}`;
    try {
      const head = await fetch(unavatar, { method: 'HEAD' });
      const ok   = head.ok && String(head.headers.get('content-type') || '').startsWith('image/');
      if (ok) return unavatar;
    } catch {}

    // 3) Fallback cuối: quét meta TikTok
    const url  = `https://r.jina.ai/http://www.tiktok.com/@${encodeURIComponent(uname)}`;
    const html = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (DiscordBot)' } })
                  .then(r => r.text()).catch(() => null);
    if (!html) return null;

    let m = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(html)
         || /"avatarThumb"\s*:\s*"([^"]+)"/i.exec(html);
    if (m && m[1]) {
      return m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    }
  } catch {}
  return null;
}

// utils: format số với dấu phân cách ngàn
function fmtNum(n) {
  try {
    return Number(n ?? 0).toLocaleString('vi-VN');
  } catch {
    return String(n ?? 0);
  }
    }
// ===================== Utils cho Downr =====================

/**
 * Gọi endpoint downr để lấy danh sách media + meta
 * Trả về { medias: [{type, url, ext, quality}], meta: {thumbnail, caption, title, author} }
 */
async function fetchFacebookViaDownr(rawUrl) {
  let url = (rawUrl || '').trim();
  try { url = decodeURIComponent(url); } catch {}
  if (!/^https?:\/\//i.test(url)) return { medias: [], meta: {} };

  // chuẩn hóa 1 số host
  url = url.replace(/^m\.facebook\.com/i, 'www.facebook.com');

  const res = await axios.post(
    'https://downr.org/.netlify/functions/download',
    { url },
    {
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://downr.org',
        'Referer': 'https://downr.org/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
        'Accept': 'application/json, text/html, */*'
      },
      timeout: 20000,
      validateStatus: () => true
    }
  );

  let data = res?.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }

  const medias = [];
  const meta = {
    thumbnail: data?.thumbnail || data?.thumb || data?.image || data?.preview || '',
    caption:   data?.caption || data?.title || data?.description || '',
    title:     data?.title || '',
    author:    data?.author || data?.uploader || data?.owner || ''
  };

  // gom các mảng media có thể có
  const buckets = [
    data?.medias,
    data?.data?.medias,
    data?.data?.links,
    data?.links
  ].filter(Array.isArray);

  for (const arr of buckets) {
    for (const m of arr) {
      const u = m?.url || m?.download || m?.href || m?.src || m?.link || '';
      if (!/^https?:\/\//i.test(u)) continue;

      const type =
        (m?.type || '').toLowerCase().includes('image') ? 'image' :
        (m?.type || '').toLowerCase().includes('video') ? 'video' :
        /\.mp4(\?|$)/i.test(u) ? 'video' :
        /\.(jpg|jpeg|png|webp)(\?|$)/i.test(u) ? 'image' : 'file';

      const ext =
        m?.ext ||
        (type === 'image'
          ? (/\.(jpe?g|png|webp)/i.exec(u)?.[1] || 'jpg')
          : (/\.(mp4|mov|m4v)/i.exec(u)?.[1] || 'mp4'));

      const quality =
        m?.quality || m?.label || m?.resolution ||
        (/(\d{3,4})p/i.exec(u)?.[1] + 'p') || '';

      medias.push({ type, url: u, ext, quality });
    }
  }

  // fallback nếu chỉ có một url đơn lẻ
  if (!medias.length && typeof data?.url === 'string') {
    const u = data.url;
    const type = /\.mp4(\?|$)/i.test(u) ? 'video'
                : /\.(jpg|jpeg|png|webp)(\?|$)/i.test(u) ? 'image'
                : 'file';
    const ext = /\.(mp4|mov|m4v|jpg|jpeg|png|webp)/i.exec(u)?.[1] || (type === 'image' ? 'jpg' : 'mp4');
    medias.push({ type, url: u, ext, quality: '' });
  }

  return { medias, meta };
}

/** Chọn media tốt nhất: ưu tiên video 1080 > 720 > 480; nếu không có => lấy ảnh đầu */
function pickBestMedia(medias = []) {
  if (!medias.length) return null;

  const score = (m) => {
    const isVideo = m.type === 'video' || /\.mp4(\?|$)/i.test(m.url);
    const q = /(\d{3,4})p/.exec(m.quality || m.url)?.[1] || '';
    const qScore = q === '1080' ? 300 : q === '720' ? 200 : q === '480' ? 100 : 50;
    return (isVideo ? 1000 : 0) + qScore;
  };

  return [...medias].sort((a, b) => score(b) - score(a))[0];
}

/** Cắt text cho field embed */
function trimField(s = '', max = 1024) {
  const t = String(s).trim();
  return t.length > max ? t.slice(0, max - 3) + '…' : t || '—';
}

/** Tên file an toàn */
function safeFilename(name = 'file') {
  return name.replace(/[^\w.\-]+/g, '_');
}

// ===== Upload limit (MB) cho video FB auto =====
const FB_UPLOAD_LIMIT_MB = Number(process.env.FB_UPLOAD_LIMIT_MB || 8);
const FB_UPLOAD_LIMIT_BYTES = FB_UPLOAD_LIMIT_MB * 1024 * 1024;

// Đo size từ Content-Length (HEAD), có fallback GET-stream nếu server chặn HEAD
async function getRemoteSize(url) {
  try {
    const r = await axios.head(url, {
      maxRedirects: 5,
      timeout: 10000,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
      },
    });
    let len = Number(r?.headers?.['content-length'] || 0);

    // nếu bị redirect mà chưa có size
    if (!len && r?.status >= 300 && r?.status < 400 && r?.headers?.location) {
      const next = new URL(r.headers.location, url).href;
      return await getRemoteSize(next);
    }

    // fallback GET stream nếu HEAD không trả size
    if (!len) {
      const r2 = await axios.get(url, {
        responseType: 'stream',
        timeout: 10000,
        validateStatus: () => true,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
      });
      len = Number(r2?.headers?.['content-length'] || 0);
      if (r2?.data?.destroy) r2.data.destroy();
    }
    return Number.isFinite(len) ? len : 0;
  } catch {
    return 0; // không xác định được size thì trả 0
  }
}
// Rút gọn URL để nhét vào Button (Discord giới hạn 512 ký tự)
async function shortenUrl(longUrl = '') {
  try {
    const r = await axios.get('https://is.gd/create.php', {
      params: { format: 'simple', url: longUrl },
      timeout: 8000,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const s = String(r?.data || '').trim();
    if (/^https?:\/\//i.test(s)) return s; // is.gd trả link ngắn dạng https://is.gd/xxxx
  } catch {}
  return longUrl; // fallback: trả lại link gốc nếu rút gọn fail
}
// ============= Auto Facebook settings =============
const FB_SETTINGS_FILE = path.join(process.cwd(), 'fb-settings.json');
let fbSettings = { guilds: {} };

async function loadFacebookSettings() {
  try {
    const s = await fs.readFile(FB_SETTINGS_FILE, 'utf8');
    fbSettings = JSON.parse(s || '{"guilds":{}}');
  } catch {
    fbSettings = { guilds: {} };
  }
}

async function saveFacebookSettings() {
  try {
    await fs.writeFile(FB_SETTINGS_FILE, JSON.stringify(fbSettings, null, 2));
  } catch (e) {
    console.warn('saveFacebookSettings error:', e?.message || e);
  }
}

// Nhận diện link FB
function isFacebookUrl(s = '') {
  return /https?:\/\/(?:(?:www|m)\.)?(?:facebook\.com|fb\.watch)\//i.test(s);
}

// Dùng lại extractFirstUrl(text) nếu bạn đã có cho instaauto.
// Nếu CHƯA có thì mở comment dưới:
// function extractFirstUrl(text = '') { const m = text.match(/https?:\/\/\S+/); return m ? m[0] : ''; }
// ============ Auto FB trong tin nhắn (gửi file) ============
client.on('messageCreate', async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;
    if (!isFacebookUrl(msg.content || '')) return;

    await loadFacebookSettings();
    const g = fbSettings.guilds[msg.guild.id] || { mode: 'off' };
    if (g.mode === 'off') return;
    if (g.mode === 'channel' && g.channelId && g.channelId !== msg.channel.id) return;

    const url = extractFirstUrl(msg.content);
    if (!url) return;

    console.log('[fbauto] hit', { gid: msg.guild.id, cid: msg.channel.id, url });
    await msg.channel.sendTyping();

    // lấy media + meta qua utils Downr
    const { medias, meta } = await fetchFacebookViaDownr(url);
    if (!Array.isArray(medias) || medias.length === 0) return;

    // ----- EMBED giống lệnh /fb -----
    const embed = new EmbedBuilder()
      .setColor(0x1877f2)
      .setTitle('📘 Facebook Downloader')
      .setDescription('✅ Tải thành công! 🎉')
      .setFooter({ text: 'Nguồn: Facebook Public Post' })
      .setTimestamp(new Date());

    if (meta?.thumbnail) embed.setImage(meta.thumbnail);
    if (meta?.caption || meta?.title) {
      embed.addFields({ name: '📖 Caption', value: trimField(meta.caption || meta.title, 1024) });
    }
    if (meta?.author) {
      embed.addFields({ name: '✍️ Tác giả', value: trimField(meta.author, 256), inline: true });
    }

    await msg.reply({ embeds: [embed] });

    // ----- GỬI ẢNH: batch tối đa 10 file / tin -----
    const images = medias.filter(m =>
      (m.type || '').toLowerCase() === 'image' ||
      /\.(?:jpg|jpeg|png|webp)(?:\?|$)/i.test(m.url || '')
    );

    if (images.length) {
      const atts = images.map((m, i) => ({
        attachment: m.url,
        name: safeFilename(`facebook_img_${String(i + 1).padStart(2, '0')}.${m.ext || 'jpg'}`)
      }));

      for (let i = 0; i < atts.length; i += 10) {
        const batch = atts.slice(i, i + 10);
        try {
          await msg.channel.send({ files: batch });
        } catch (e) {
          console.error('fbauto image send error:', e);
        }
      }
    }

   // ----- GỬI VIDEO: chọn video “tốt nhất” rồi kiểm tra size -----
const videos = medias.filter(m =>
  (m.type || '').toLowerCase() === 'video' || /\.mp4(?:\?|$)/i.test(m.url || '')
);

if (videos.length) {
  const bestVideo = pickBestMedia(videos);
  if (bestVideo?.url) {
    try {
      const size = await getRemoteSize(bestVideo.url);

      if (size > 0 && size <= FB_UPLOAD_LIMIT_BYTES) {
        // ✅ Nhẹ => upload trực tiếp
        await msg.channel.send({
          files: [{
            attachment: bestVideo.url,
            name: safeFilename(`facebook.${bestVideo.ext || 'mp4'}`)
          }]
        });
      } else {
  // ❌ Nặng hoặc không đo được size -> gửi nút mở link (rút gọn nếu cần)
  const label =
    `🎬 Mở video` +
    (bestVideo.quality ? ` • ${bestVideo.quality}` : '') +
    (size ? ` • ${Math.round(size / 1024 / 1024)}MB` : '');

  let openUrl = bestVideo.url || '';

  // Nếu URL dài > 512 thì rút gọn trước
  if (openUrl.length > 500) {
    openUrl = await shortenUrl(openUrl);
  }

  // Bảo hiểm: Discord giới hạn 512 ký tự cho Button URL
  if (openUrl.length > 512) {
    // Nếu vẫn dài (dịp hiếm) -> gửi tin nhắn thường
    await msg.channel.send({ content: `${label}\n${openUrl}` });
  } else {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(label)
        .setURL(openUrl)
    );
    await msg.channel.send({ components: [row] });
  }
}
    } catch (e2) {
      console.error('fbauto video send error:', e2);
    }
  }
}
} catch (e) {
    console.error('fb auto error:', e);
  }
});
// ================= Utils cho Downr (Instagram) =================

/**
 * Gọi endpoint downr để lấy danh sách media + meta từ Instagram
 * Trả về { medias: [{type, url, ext, quality}], meta: {thumbnail, caption, title, author} }
 */
async function fetchInstagramViaDownr(rawUrl) {
  let url = (rawUrl || '').trim();
  try { url = decodeURIComponent(url); } catch {}
  if (!/^https?:\/\//i.test(url)) return { medias: [], meta: {} };

  const res = await axios.post(
    'https://downr.org/.netlify/functions/download',
    { url },
    {
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://downr.org',
        'Referer': 'https://downr.org/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
      },
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  let data = res?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch {}
  }

  const medias = [];
  const meta = {
    thumbnail: data?.thumbnail || data?.thumb || data?.image || '',
    caption: data?.caption || data?.title || data?.description || '',
    title: data?.title || '',
    author: data?.author || data?.uploader || data?.owner || ''
  };

  // gom các mảng media có thể có
  const buckets = [
    data?.medias,
    data?.data,
    data?.links,
  ].filter(Array.isArray);

  for (const arr of buckets) {
    for (const m of arr) {
      const u = m?.url || m?.download || m?.href || m?.src || m?.link || '';
      if (!/^https?:\/\//i.test(u)) continue;

      const type =
        (m?.type || '').toLowerCase().includes('image') ? 'image'
        : (m?.type || '').toLowerCase().includes('video') ? 'video'
        : /\.mp4$/i.test(u) ? 'video'
        : /\.(jpg|jpeg|png|webp|gif)$/i.test(u) ? 'image'
        : 'file';

      const ext =
        m?.ext ||
        (type === 'image'
          ? (/\.(jpe?g|png|webp|gif)$/i.exec(u)?.[1] || 'jpg')
          : /\.mp4$/i.test(u) ? 'mp4' : '');

      const quality = m?.quality || m?.label || m?.resolution || '';

      medias.push({ type, url: u, ext, quality });
    }
  }

  // fallback nếu chỉ có 1 url đơn lẻ
  if (!medias.length && typeof data?.url === 'string') {
    const u = data.url;
    const type = /\.mp4$/i.test(u) ? 'video'
      : /\.(jpg|jpeg|png|webp|gif)$/i.test(u) ? 'image'
      : 'file';
    const ext = /\.mp4$/i.test(u) ? 'mp4'
      : /\.(jpg|jpeg|png|webp|gif)$/i.test(u) ? (/\.(\w+)$/i.exec(u)?.[1] || 'jpg')
      : '';
    medias.push({ type, url: u, ext, quality: '' });
  }

  return { medias, meta };
}
// ============= Auto Instagram settings =============
const INSTA_SETTINGS_FILE = path.join(process.cwd(), 'insta-settings.json');
let instaSettings = { guilds: {} };

async function loadInstaSettings() {
  try {
    const s = await fs.readFile(INSTA_SETTINGS_FILE, 'utf8');
    instaSettings = JSON.parse(s || '{"guilds":{}}');
  } catch { instaSettings = { guilds: {} }; }
}

async function saveInstaSettings() {
  try {
    await fs.writeFile(INSTA_SETTINGS_FILE, JSON.stringify(instaSettings, null, 2));
  } catch (e) { console.warn('saveInstaSettings error:', e?.message || e); }
}

// Nhận diện IG URL & rút URL đầu tiên
function isInstagramUrl(s = '') {
  return /https?:\/\/(?:www\.)?instagram\.com\/[^\s]+/i.test(s);
}
function extractFirstUrl(text = '') {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : '';
}
// ============= Auto IG trong tin nhắn =============
client.on('messageCreate', async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;
    if (!isInstagramUrl(msg.content || '')) return;

    await loadInstaSettings();
    const g = instaSettings.guilds[msg.guild.id] || { mode: 'off' };
    if (g.mode === 'off') return;
    if (g.mode === 'channel' && g.channelId && g.channelId !== msg.channel.id) return;

    const url = extractFirstUrl(msg.content);
    if (!url) return;

    console.log('[instaauto] hit', { gid: msg.guild.id, cid: msg.channel.id, url });
    await msg.channel.sendTyping();

    // lấy dữ liệu qua utils Downr (bạn đã thêm fetchInstagramViaDownr trước đó)
    const { medias, meta } = await fetchInstagramViaDownr(url);
    if (!Array.isArray(medias) || medias.length === 0) return;

    // --- Build embed ---
    const cap = meta?.caption || '';
    const embed = new EmbedBuilder()
      .setColor(0xff3399)
      .setTitle('📷 Instagram Downloader')
      .setDescription(cap.length > 800 ? cap.slice(0, 800) + '…' : cap)
      .setFooter({ text: `Nguồn: Instagram • Tác giả: ${meta?.author || ''}` })
      .setTimestamp(new Date());

    if (meta?.thumbnail && /^https?:\/\/\S+/i.test(meta.thumbnail)) {
      embed.setImage(meta.thumbnail);
    }

    // --- Tạo tối đa 20 nút "Mở media" ---
    const top = medias.slice(0, 20);
    const btns = top.map((m, i) =>
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(`${/video/i.test(m.type || '') ? '🎬' : '🖼️'} Mở media ${i + 1}${m.quality ? ` • ${m.quality}` : ''}`)
        .setURL(m.url)
    );

    const rows = [];
    for (let i = 0; i < btns.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(...btns.slice(i, i + 5)));
    }

    await msg.reply({ embeds: [embed], components: rows });
  } catch (e) {
    console.error('insta auto error:', e);
  }
});
// ========== Utils Capcut ==========
/**
 * Lấy media + meta cho link CapCut qua Downr
 * Trả về: { medias:[{type:'video'|'image'|'file', url, ext, quality}], meta:{...} }
 */
async function fetchCapcutViaDownr(rawUrl) {
  let url = (rawUrl || '').trim();
  try { url = decodeURIComponent(url); } catch {}
  if (!/^https?:\/\//i.test(url)) return { medias: [], meta: {} };

  // 1) gọi Downr API
  const res = await axios.post(
    'https://downr.org/.netlify/functions/download',
    { url },
    {
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://downr.org',
        'Referer': 'https://downr.org/',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 20000,
      validateStatus: () => true
    }
  );

  let data = res?.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }

  const medias = [];
  const meta = {
    thumbnail:   data?.thumbnail || data?.thumb || data?.image || '',
    caption:     data?.caption   || data?.description || data?.meta?.description || '',
    title:       data?.title     || data?.meta?.title || 'CapCut Template',
    author:      data?.author    || data?.uploader    || data?.meta?.author || '',
    originalUrl: url,
    downrPage:   `https://downr.org/?u=${encodeURIComponent(url)}`
  };

  // gom các mảng media có thể có
  const buckets = [data?.medias, data?.media, data?.links, data?.data].filter(Array.isArray);
  for (const arr of buckets) {
    for (const m of arr) {
      const u = m?.url || m?.download || m?.href || m?.src || m?.link || '';
      if (!/^https?:\/\//i.test(u)) continue;

      const lower = String(m?.type || '').toLowerCase();
      const isVid = lower.includes('video') || /\.mp4|\.mov|\.m4v/i.test(u) || /mime_type=video/i.test(u);
      const isImg = lower.includes('image') || /\.(jpe?g|png|webp|gif)$/i.test(u);

      medias.push({
        type: isVid ? 'video' : isImg ? 'image' : 'file',
        url: u,
        ext:  m?.ext || (isVid ? 'mp4' : (/\.(jpe?g|png|webp|gif)$/i.exec(u)?.[1] || 'jpg')),
        quality: m?.quality || m?.label || m?.resolution || ''
      });
    }
  }

  // 2) nếu chưa có file thực → scrape trang Downr, lọc candidate, HEAD phân loại
  const onlyCapcutLinks = medias.length && medias.every(m => /capcut\.com/i.test(m.url));
  if (!medias.length || onlyCapcutLinks) {
    try {
      const html = (await axios.get(meta.downrPage, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml,*/*' },
        timeout: 20000, validateStatus: () => true
      })).data || '';

      // bắt mọi URL trong trang
      const urlSet = new Set();
      const rxAnyUrl = /(https?:\/\/[^\s"'<>)]+)(?=[\s"'<>)]|$)/gi;
      let m;
      while ((m = rxAnyUrl.exec(html)) !== null) {
        const u = (m[1] || '').trim();
        if (/^https?:\/\//i.test(u)) urlSet.add(u);
      }
      const urls = Array.from(urlSet);

      // ưu tiên capcutvod, mime_type=video, CDN phổ biến, đuôi media
      const candidates = urls
        .filter(u =>
          /capcutvod\.com/i.test(u) ||
          /(?:\?|&)mime_type=video/i.test(u) ||
          /(downr|netlify|cdn|amazonaws|cloudfront|googlevideo|akamai)/i.test(u) ||
          /\.(mp4|m3u8|jpg|jpeg|png|webp|gif)(?:\?|$)/i.test(u)
        )
        .slice(0, 80);

      for (const u of candidates) {
        let ctype = '';
        const hintVideo = /capcutvod\.com/i.test(u) || /(?:\?|&)mime_type=video/i.test(u);

        try {
          const head = await axios.head(u, { timeout: 8000, maxRedirects: 5, validateStatus: () => true });
          ctype = String(head.headers['content-type'] || '').toLowerCase();
        } catch {}

        if (!ctype && hintVideo) {
          medias.push({ type: 'video', url: u, ext: 'mp4', quality: '' });
          if (medias.filter(x => x.type === 'video').length >= 2) break;
          continue;
        }

        if (ctype.startsWith('video/')) {
          medias.push({ type: 'video', url: u, ext: 'mp4', quality: '' });
          if (medias.filter(x => x.type === 'video').length >= 2) break;
        } else if (ctype.startsWith('image/')) {
          const ext = (/\.(webp|png|jpe?g|gif)\b/i.exec(u)?.[1] || 'jpg');
          medias.push({ type: 'image', url: u, ext, quality: '' });
        }
      }
    } catch {}
  }

  // 3) fallback cuối: nếu Downr trả về 1 URL đơn
  if (!medias.length && data?.url && /^https?:\/\//i.test(data.url)) {
    const u = data.url;
    const isVideo = /\.mp4|\.mov|\.m4v/i.test(u) || /(?:\?|&)mime_type=video/i.test(u);
    medias.push({
      type: isVideo ? 'video' : 'image',
      url: u,
      ext:  isVideo ? 'mp4' : (/\.(jpe?g|png|webp|gif)$/i.exec(u)?.[1] || 'jpg'),
      quality: ''
    });
  }

  return { medias, meta };
}
// ============= Auto CapCut settings =============
const CAPCUT_SETTINGS_FILE = path.join(process.cwd(), 'capcut-settings.json');
let capcutSettings = { guilds: {} };

async function loadCapcutSettings() {
  try {
    const s = await fs.readFile(CAPCUT_SETTINGS_FILE, 'utf8');
    capcutSettings = JSON.parse(s || '{"guilds":{}}');
  } catch { capcutSettings = { guilds: {} }; }
}
async function saveCapcutSettings() {
  try {
    await fs.writeFile(CAPCUT_SETTINGS_FILE, JSON.stringify(capcutSettings, null, 2));
  } catch (e) { console.warn('saveCapcutSettings error:', e?.message || e); }
}

// nhận diện & rút URL đầu tiên
function isCapcutUrl(s = '') {
  return /https?:\/\/(?:www\.)?(?:capcut\.com|capcut\.net)\/[^\s]+/i.test(s);
}
function ccExtractFirstUrl(text = '') {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : '';
}
// ============= Auto CapCut trong tin nhắn =============
const CAPCUT_LIMIT = 25 * 1024 * 1024; // 25MB

// KHÔNG dùng lại tên isCapcutUrl / extractFirstUrl nếu đã có ở trên

function ccIsCapcutUrl(s = '') {
  return /https?:\/\/(?:www\.)?capcut\.com\/\S+/i.test(s);
}

client.on('messageCreate', async (msg) => {
  try {
    if (!msg.guild || msg.author.bot) return;
   if (!ccIsCapcutUrl(msg.content || '')) return;
    
    await loadCapcutSettings();
    const g = capcutSettings.guilds[msg.guild.id] || { mode: 'off' };
    if (g.mode === 'off') return;
    if (g.mode === 'channel' && g.channelId && g.channelId !== msg.channel.id) return;

    const url = ccExtractFirstUrl(msg.content);
    if (!url) return;

    await msg.channel.sendTyping();

    // Lấy data Downr
    const { medias, meta } = await fetchCapcutViaDownr(url);
    if (!Array.isArray(medias) || medias.length === 0) return;

    // Chọn URL video "chắc ăn" nhất
    const pick =
      medias.find(m => /capcutvod\.com/i.test(m.url)) ||
      medias.find(m => /mime_type=video/i.test(m.url)) ||
      medias.find(m => /video/i.test(m.type)) ||
      medias[0];

    // Thử gửi video trực tiếp trước
    let sentVideo = false;
    if (pick && /^https?:\/\//i.test(pick.url)) {
      try {
        const resp = await axios.get(pick.url, {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://www.capcut.com/'
          }
        });
        const buf = Buffer.from(resp.data);
        if (buf.length <= CAPCUT_LIMIT) {
          const safe = (s='') => String(s || '')
            .normalize('NFKD').replace(/[^\w\s\-]/g, '')
            .replace(/\s+/g, '_').slice(0, 40);
          const ext = pick.ext?.replace(/^\./,'') || 'mp4';
          const fileName = `capcut_${safe(meta.title || 'video')}.${ext}`;

          await msg.reply({ files: [{ attachment: buf, name: fileName }] });
          sentVideo = true;
        }
      } catch (e) {
        console.warn('[capcutauto] download video failed:', e?.message || e);
      }
    }

    // Luôn gửi embed gọn + nút template (fallback khi không gửi được video)
    const embed = new EmbedBuilder()
      .setColor(0x00d084)
      .setTitle(`✂️ CapCut: ${meta.title || 'Template'}`)
      .setURL(meta.originalUrl || url)
      .setDescription(meta.author ? `👤 Tác giả: **${meta.author}**` : '')
      .setFooter({ text: 'Nguồn: CapCut • Downr.org' })
      .setTimestamp(new Date());
    if (meta.thumbnail && /^https?:\/\//i.test(meta.thumbnail)) {
      embed.setImage(meta.thumbnail);
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('✂️ Dùng template')
        .setURL(meta.originalUrl || url)
    );

    // Nếu đã gửi video, gửi embed + nút như thông tin bổ sung.
    // Nếu chưa gửi video (do lớn/lỗi) thì embed này chính là fallback.
    await msg.channel.send({ embeds: [embed], components: [row] });

  } catch (e) {
    console.error('capcutauto error:', e);
  }
});
// ------------------ utils ------------------
function fmtTime(sec) {
  if (isNaN(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

process.on('unhandledRejection', (r) => console.error('UNHANDLED', r));
process.on('uncaughtException', (e) => console.error('UNCAUGHT', e));
