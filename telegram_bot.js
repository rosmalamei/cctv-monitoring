const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');

let bot = null;
let botConfig = {};
let appConfig = {};
let db = null;
let pollingErrorState = { lastLogAt: 0, lastMessage: '' };
let services = {
    getCameraStatus: () => ({}),
    getDiskUsage: () => ({}),
    restartSystem: () => { },
    cleanupRecordings: () => { },
    getRtspTemplates: () => ({}),
    generateRtspUrl: () => null,
    updateAdminCredentials: () => ({ success: false })
};

// Store user states for multi-step interactions
const userStates = {};
const USER_STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function setUserState(chatId, state) {
    if (userStates[chatId] && userStates[chatId]._timer) {
        clearTimeout(userStates[chatId]._timer);
    }
    const timer = setTimeout(() => { delete userStates[chatId]; }, USER_STATE_TTL_MS);
    userStates[chatId] = { ...state, _timer: timer };
}

function clearUserState(chatId) {
    if (userStates[chatId] && userStates[chatId]._timer) {
        clearTimeout(userStates[chatId]._timer);
    }
    delete userStates[chatId];
}

/**
 * Initialize the Telegram Bot
 * @param {Object} config - The application configuration object
 * @param {Object} database - The SQLite database instance
 * @param {Object} serviceProvider - Object containing service functions
 */
function init(config, database, serviceProvider) {
    if (!config.telegram || !config.telegram.enabled || !config.telegram.bot_token) {
        console.log('[Telegram] Bot disabled or token missing.');
        return;
    }

    botConfig = config.telegram;
    appConfig = config;
    db = database;

    if (serviceProvider) {
        // Handle legacy function argument or new object
        if (typeof serviceProvider === 'function') {
            services.getCameraStatus = serviceProvider;
        } else {
            services = { ...services, ...serviceProvider };
        }
    }

    // Initialize bot with polling (no webhook needed, works behind firewall)
    try {
        bot = new TelegramBot(botConfig.bot_token, { polling: true });
        console.log('[Telegram] Bot started in polling mode.');

        bot.on('polling_error', (err) => {
            const body = err?.response?.body;
            const message = typeof body === 'string' ? body : (err?.message || (body ? JSON.stringify(body) : String(err)));
            const now = Date.now();
            if (pollingErrorState.lastMessage !== message || (now - pollingErrorState.lastLogAt) > 15000) {
                console.error('[Telegram] polling_error:', message);
                pollingErrorState.lastLogAt = now;
                pollingErrorState.lastMessage = message;
            }
            if (message.includes('409') || message.includes('Conflict')) {
                try { bot.stopPolling(); } catch (e) { }
                bot = null;
            }
        });

        // Set commands
        bot.setMyCommands([
            { command: '/start', description: 'Menu Utama' },
            { command: '/password', description: 'Ganti Password Admin' },
            { command: '/help', description: 'Bantuan' }
        ]);

        setupListeners();
    } catch (error) {
        console.error('[Telegram] Failed to start bot:', error.message);
    }
}

function stop() {
    if (bot) {
        try {
            bot.stopPolling();
        } catch (e) {
            console.error('[Telegram] stopPolling error:', e.message);
        }
        bot = null;
    }
}

function restart(config, database, serviceProvider) {
    stop();
    init(config, database, serviceProvider);
}
/**
 * Send a message to the configured chat_id
 * @param {string} text - The message text (HTML supported)
 */
function sendMessage(text) {
    if (!bot || !botConfig.chat_id) return;

    // Split long messages if needed (Telegram limit is 4096 chars)
    const MAX_LENGTH = 4000;
    if (text.length > MAX_LENGTH) {
        const chunks = text.match(new RegExp(`.{1,${MAX_LENGTH}}`, 'g'));
        chunks.forEach(chunk => {
            bot.sendMessage(botConfig.chat_id, chunk, { parse_mode: 'HTML' })
                .catch(err => console.error('[Telegram] Send error:', err.message));
        });
    } else {
        bot.sendMessage(botConfig.chat_id, text, { parse_mode: 'HTML' })
            .catch(err => console.error('[Telegram] Send error:', err.message));
    }
}

function isAdmin(chatId) {
    if (!botConfig.chat_id) return false; // Security: deny all if chat_id not configured
    return String(chatId) === String(botConfig.chat_id);
}

function getBaseUrl() {
    const hlsUrl = (appConfig.mediamtx && appConfig.mediamtx.public_hls_url) ? String(appConfig.mediamtx.public_hls_url).trim() : '';
    if (hlsUrl) {
        try { const u = new URL(hlsUrl); return `${u.protocol}//${u.hostname}`; } catch (e) { }
    }
    const cfgBase = (appConfig.server && appConfig.server.public_base_url) ? String(appConfig.server.public_base_url).trim() : '';
    const envBase = process.env.PUBLIC_BASE_URL ? String(process.env.PUBLIC_BASE_URL).trim() : '';
    if (cfgBase) return cfgBase.replace(/\/+$/, '');
    if (envBase) return envBase.replace(/\/+$/, '');
    try {
        const os = require('os');
        const nets = os.networkInterfaces();
        let ip = '';
        Object.keys(nets).forEach(name => {
            nets[name].forEach(net => {
                if (!ip && net.family === 'IPv4' && !net.internal) ip = net.address;
            });
        });
        const port = (appConfig.server && appConfig.server.port) || 3003;
        const proto = (appConfig.server && appConfig.server.behind_https_proxy) ? 'https' : 'http';
        return `${proto}://${ip || 'localhost'}:${port}`;
    } catch (e) {
        return `http://localhost:${(appConfig.server && appConfig.server.port) || 3003}`;
    }
}

function getMainKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: '📷 Status Kamera', callback_data: 'status' },
                { text: '💾 Disk Usage', callback_data: 'disk' }
            ],
            [
                { text: '📼 Rekaman Terbaru', callback_data: 'recordings' },
                { text: '📅 Arsip Tanggal', callback_data: 'recordings_date' }
            ],
            [
                { text: '🔗 Link Stream', callback_data: 'stream_menu' },
                { text: '🔗 Generate RTSP', callback_data: 'rtsp_menu' }
            ],
            [
                { text: '🧹 Cleanup', callback_data: 'clean_menu' },
                { text: '🔄 Restart', callback_data: 'restart' }
            ]
        ]
    };
}

function setupListeners() {
    // Handle Callback Queries (Button Clicks)
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const data = query.data;
        const msgId = query.message.message_id;

        if (!isAdmin(chatId)) {
            bot.answerCallbackQuery(query.id, { text: '⛔ Akses Ditolak', show_alert: true });
            return;
        }

        // --- Navigation Logic ---
        if (data === 'main_menu') {
            bot.editMessageText('🤖 <b>Menu Utama CCTV Monitor</b>\nSilakan pilih menu di bawah:', {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'HTML',
                reply_markup: getMainKeyboard()
            });
        }

        // --- Feature: Status ---
        else if (data === 'status') {
            const status = services.getCameraStatus();
            let report = '<b>📹 Status Kamera CCTV</b>\n\n';

            if (status && Object.keys(status).length > 0) {
                db.all("SELECT id, nama, lokasi FROM cameras", [], (err, rows) => {
                    if (err) {
                        bot.answerCallbackQuery(query.id, { text: 'Database Error' });
                        return;
                    }

                    let onlineCount = 0;
                    rows.forEach(cam => {
                        const camStatus = status[cam.id];
                        if (camStatus) {
                            const icon = camStatus.online ? '✅' : '🔴';
                            const mode = camStatus.hlsTranscoded ? 'Transcoded' : (camStatus.hlsReady ? 'Direct' : 'Unknown');
                            const checked = camStatus.hasBeenChecked ? 'Diverifikasi' : 'Belum diverifikasi';
                            const last = camStatus.lastUpdate ? new Date(camStatus.lastUpdate).toLocaleString('id-ID') : '-';
                            report += `${icon} <b>${cam.nama}</b>${cam.lokasi ? ' • ' + cam.lokasi : ''}\n`;
                            report += `Mode: ${mode} • ${checked} • ${last}\n\n`;
                            if (camStatus.online) onlineCount++;
                        }
                    });
                    report += `\nTotal: ${rows.length} | Online: ${onlineCount}`;

                    bot.editMessageText(report, {
                        chat_id: chatId,
                        message_id: msgId,
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'main_menu' }]]
                        }
                    });
                });
            } else {
                bot.editMessageText('⚠️ Data status belum tersedia.', {
                    chat_id: chatId,
                    message_id: msgId,
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'main_menu' }]] }
                });
            }
        }

        // --- Feature: Disk ---
        else if (data === 'disk') {
            const disk = services.getDiskUsage();
            let report = `<b>💾 Status Penyimpanan</b>\n\n`;
            if (disk && disk.total) {
                const mount = disk.mounted ? ` (${disk.mounted})` : '';
                report += `Kapasitas Disk${mount}\n`;
                report += `${disk.used} / ${disk.total} (${disk.percent}%)\n`;
                report += `Tersedia: ${disk.free}\n`;
                if (typeof disk.percent === 'number') {
                    let level = '🟩 Normal';
                    if (disk.percent > 90) level = '🟥 Kritis';
                    else if (disk.percent > 70) level = '🟧 Tinggi';
                    report += `Level: ${level}\n`;
                }
                if (Array.isArray(disk.disks) && disk.disks.length > 0) {
                    report += `\n<b>Per-Volume:</b>\n`;
                    disk.disks.forEach(d => {
                        report += `• ${d.mounted}: ${d.used}/${d.total} (${d.percent}%)\n`;
                    });
                }
                if (disk.memory) {
                    report += `\n<b>Memori:</b>\n`;
                    report += `Total: ${disk.memory.total}\n`;
                    report += `Terpakai: ${disk.memory.used} (${disk.memory.percent}%)\n`;
                    report += `Sisa: ${disk.memory.free}\n`;
                }
                if (disk.cpu && (disk.cpu.load1 !== null)) {
                    report += `\n<b>CPU Load:</b> ${disk.cpu.load1.toFixed(2)} / ${disk.cpu.load5.toFixed(2)} / ${disk.cpu.load15.toFixed(2)}\n`;
                }
                if (typeof disk.uptime_sec === 'number') {
                    const s = Math.floor(disk.uptime_sec);
                    const h = Math.floor(s / 3600);
                    const m = Math.floor((s % 3600) / 60);
                    const sec = s % 60;
                    report += `\n<b>Uptime:</b> ${h}h ${m}m ${sec}s\n`;
                }
                if (disk.recordings) {
                    report += `\n<b>Folder Rekaman:</b>\n`;
                    report += `Total: ${disk.recordings.total}\n`;
                    report += `Files: ${disk.recordings.files}\n`;
                    if (disk.recordings.lastUpdate) {
                        report += `Update: ${new Date(disk.recordings.lastUpdate).toLocaleString('id-ID')}\n`;
                    }
                }
                if (disk.sensors && typeof disk.sensors.cpu_temp_c === 'number') {
                    report += `\n<b>CPU Temp:</b> ${disk.sensors.cpu_temp_c}°C\n`;
                }
            } else {
                report += 'Data tidak tersedia.';
            }

            bot.editMessageText(report, {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'main_menu' }]] }
            });
        }

        // --- Feature: Recordings ---
        else if (data === 'recordings') {
            try {
                const recordingsDir = path.join(__dirname, 'recordings');
                let cameraFolders = [];
                try {
                    cameraFolders = fs.readdirSync(recordingsDir).filter(f => {
                        const fullPath = path.join(recordingsDir, f);
                        return fs.statSync(fullPath).isDirectory() && f.startsWith('cam_');
                    });
                } catch (e) {
                    cameraFolders = [];
                }

                // Build camera name map
                let camNameById = {};
                try {
                    const rows = await new Promise((resolve) => {
                        db.all("SELECT id, nama FROM cameras", [], (err, r) => {
                            resolve(err ? [] : (r || []));
                        });
                    });
                    rows.forEach(r => camNameById[String(r.id)] = r.nama);
                } catch (e) { }

                const items = [];
                cameraFolders.forEach(folder => {
                    const folderPath = path.join(recordingsDir, folder);
                    let files = [];
                    try {
                        files = fs.readdirSync(folderPath);
                    } catch (e) {
                        files = [];
                    }
                    const cameraId = Number(folder.replace('cam_', '')) || null;
                    files.forEach(file => {
                        const fullPath = path.join(folderPath, file);
                        let stats;
                        try {
                            stats = fs.statSync(fullPath);
                        } catch (e) {
                            return;
                        }
                        if (!stats.isFile()) return;

                        // Only include video files
                        const videoExts = ['.mp4', '.fmp4', '.ts', '.mkv'];
                        const ext = path.extname(file).toLowerCase();
                        if (!videoExts.includes(ext)) return;

                        // Use file mtime (server local time) — more reliable than parsing filename
                        const createdAt = stats.mtime;
                        const relativePath = path.relative(__dirname, fullPath).replace(/\\/g, '/');
                        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2) + ' MB';
                        items.push({
                            cameraId,
                            cameraName: camNameById[String(cameraId)] || folder,
                            filename: file,
                            relPath: relativePath,
                            sizeText: sizeMb,
                            createdAt
                        });
                    });
                });

                items.sort((a, b) => b.createdAt - a.createdAt);
                const latest = items.slice(0, 5);
                let response = '<b>📼 5 Rekaman Terakhir</b>\n\n';
                if (latest.length > 0) {
                    const base = getBaseUrl();
                    latest.forEach(it => {
                        const date = new Date(it.createdAt).toLocaleString('id-ID');
                        const url = `${base}/${it.relPath}`;
                        response += `📹 <b>${it.cameraName}</b>\n🕒 ${date}\n💾 ${it.sizeText}\n🔗 <a href="${url}">Download</a>\n\n`;
                    });
                } else {
                    response += 'Belum ada file di folder rekaman.';
                }

                bot.editMessageText(response, {
                    chat_id: chatId,
                    message_id: msgId,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'main_menu' }]] }
                });
            } catch (err) {
                bot.editMessageText('Terjadi kesalahan membaca folder rekaman.', {
                    chat_id: chatId,
                    message_id: msgId,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'main_menu' }]] }
                });
            }
        }
        else if (data === 'recordings_date') {
            setUserState(chatId, { step: 'ask_date_recordings' });
            bot.editMessageText('<b>📅 Arsip Tanggal</b>\nMasukkan tanggal (YYYY-MM-DD), contoh: 2026-02-22', {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'main_menu' }]] }
            });
        }
        else if (data === 'stream_menu') {
            db.all("SELECT id, nama FROM cameras ORDER BY id ASC", [], (err, rows) => {
                if (err || !rows || rows.length === 0) {
                    bot.editMessageText('Tidak ada kamera terdaftar.', {
                        chat_id: chatId,
                        message_id: msgId,
                        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'main_menu' }]] }
                    });
                    return;
                }
                const keyboard = [];
                let row = [];
                rows.forEach((cam, idx) => {
                    row.push({ text: `${cam.id} — ${cam.nama}`, callback_data: `stream_cam_${cam.id}` });
                    if (row.length === 2 || idx === rows.length - 1) {
                        keyboard.push(row);
                        row = [];
                    }
                });
                keyboard.push([{ text: '🔙 Kembali', callback_data: 'main_menu' }]);
                bot.editMessageText('<b>🔗 Link Stream</b>\nPilih kamera:', {
                    chat_id: chatId,
                    message_id: msgId,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: keyboard }
                });
            });
        }
        else if (data.startsWith('stream_cam_')) {
            const camId = parseInt(data.replace('stream_cam_', ''));
            if (isNaN(camId)) {
                bot.answerCallbackQuery(query.id, { text: 'ID kamera tidak valid' });
                return;
            }
            const hlsBase = (() => {
                const hlsUrl = (appConfig.mediamtx && appConfig.mediamtx.public_hls_url) ? String(appConfig.mediamtx.public_hls_url).trim() : '';
                if (hlsUrl) return hlsUrl.replace(/\/+$/, '');
                const port = (appConfig.mediamtx && appConfig.mediamtx.hls_port) || 8856;
                return `http://127.0.0.1:${port}`;
            })();
            const transcoded = `${hlsBase}/cam_${camId}/index.m3u8`;
            const direct = `${hlsBase}/cam_${camId}_input/index.m3u8`;
            bot.editMessageText(`<b>🔗 Link Stream Kamera ${camId}</b>\n\n• Transcoded: <a href="${transcoded}">${transcoded}</a>\n• Direct: <a href="${direct}">${direct}</a>`, {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'stream_menu' }]] }
            });
        }

        // --- Feature: Restart ---
        else if (data === 'restart') {
            bot.editMessageText('⚠️ <b>Konfirmasi Restart</b>\nApakah Anda yakin ingin me-restart sistem?', {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Ya, Restart', callback_data: 'do_restart' },
                            { text: '❌ Batal', callback_data: 'main_menu' }
                        ]
                    ]
                }
            });
        }
        else if (data === 'do_restart') {
            bot.answerCallbackQuery(query.id, { text: 'Memulai ulang sistem...' });
            bot.sendMessage(chatId, '🔄 Sistem sedang direstart...');
            setTimeout(() => services.restartSystem(), 1000);
        }

        // --- Feature: Clean Menu ---
        else if (data === 'clean_menu') {
            bot.editMessageText('<b>🧹 Menu Pembersihan</b>\nPilih opsi pembersihan:', {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🗑️ Hapus Orphans (File Hilang)', callback_data: 'clean_orphans' }],
                        [{ text: '📅 Hapus > 7 Hari', callback_data: 'clean_old_7' }],
                        [{ text: '📅 Hapus > 30 Hari', callback_data: 'clean_old_30' }],
                        [{ text: '🔙 Kembali', callback_data: 'main_menu' }]
                    ]
                }
            });
        }
        else if (data === 'clean_orphans') {
            bot.answerCallbackQuery(query.id, { text: 'Membersihkan orphans...' });
            services.cleanupRecordings('orphans', null, (result) => {
                bot.sendMessage(chatId, `✅ Pembersihan selesai. ${result.deleted} data dihapus.`);
            });
        }
        else if (data.startsWith('clean_old_')) {
            const days = parseInt(data.replace('clean_old_', ''));
            bot.answerCallbackQuery(query.id, { text: `Menghapus data > ${days} hari...` });
            services.cleanupRecordings('old', days, (result) => {
                bot.sendMessage(chatId, `✅ Selesai. ${result.deleted} rekaman dihapus (${result.freedSpace}).`);
            });
        }

        // --- Feature: RTSP Generator Menu ---
        else if (data === 'rtsp_menu') {
            const templates = services.getRtspTemplates();
            const brands = Object.keys(templates);

            // Create keyboard with brands (2 columns)
            const keyboard = [];
            let row = [];
            brands.forEach((brand, index) => {
                row.push({ text: templates[brand].name, callback_data: `rtsp_brand_${brand}` });
                if (row.length === 2 || index === brands.length - 1) {
                    keyboard.push(row);
                    row = [];
                }
            });
            keyboard.push([{ text: '🔙 Kembali', callback_data: 'main_menu' }]);

            bot.editMessageText('<b>🔗 Generator RTSP URL</b>\nPilih merek kamera:', {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        }

        // --- Feature: RTSP Steps ---
        else if (data.startsWith('rtsp_brand_')) {
            const brand = data.replace('rtsp_brand_', '');
            setUserState(chatId, { step: 'ask_ip', brand: brand });

            bot.sendMessage(chatId, `<b>Langkah 1/3:</b>\nMasukkan IP Address kamera (contoh: 192.168.1.100):`, {
                parse_mode: 'HTML',
                reply_markup: { force_reply: true }
            });
        }

        // Always answer callback to stop loading animation
        try {
            await bot.answerCallbackQuery(query.id);
        } catch (e) { }
    });

    // Handle Text Messages (for Inputs)
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const text = msg.text;

        if (!userStates[chatId]) return;

        const state = userStates[chatId];

        // --- RTSP Flow ---
        if (state.step === 'ask_ip') {
            state.ip = text.trim();
            state.step = 'ask_user';
            bot.sendMessage(chatId, `<b>Langkah 2/3:</b>\nMasukkan Username kamera (biasanya admin):`, {
                parse_mode: 'HTML',
                reply_markup: { force_reply: true }
            });
        }
        else if (state.step === 'ask_user') {
            state.username = text.trim();
            state.step = 'ask_pass';
            bot.sendMessage(chatId, `<b>Langkah 3/3:</b>\nMasukkan Password kamera:`, {
                parse_mode: 'HTML',
                reply_markup: { force_reply: true }
            });
        }
        else if (state.step === 'ask_pass') {
            state.password = text.trim();

            // Generate URL
            const url = services.generateRtspUrl(state.brand, {
                ip: state.ip,
                username: state.username,
                password: state.password
            });

            if (url) {
                bot.sendMessage(chatId, `✅ <b>RTSP URL Berhasil Dibuat:</b>\n\n<code>${url}</code>\n\nSalin URL di atas ke konfigurasi kamera.`, {
                    parse_mode: 'HTML',
                    reply_markup: getMainKeyboard()
                });
            } else {
                bot.sendMessage(chatId, '❌ Gagal membuat URL. Coba lagi.', { reply_markup: getMainKeyboard() });
            }

            clearUserState(chatId);
        }
        else if (state.step === 'ask_date_recordings') {
            const date = String(text || '').trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                bot.sendMessage(chatId, 'Format tanggal tidak valid. Gunakan YYYY-MM-DD, contoh: 2026-02-22');
                return;
            }
            try {
                const recordingsDir = path.join(__dirname, 'recordings');
                let cameraFolders = [];
                try {
                    cameraFolders = fs.readdirSync(recordingsDir).filter(f => {
                        const fullPath = path.join(recordingsDir, f);
                        return fs.statSync(fullPath).isDirectory() && f.startsWith('cam_');
                    });
                } catch (e) {
                    cameraFolders = [];
                }
                let camNameById = {};
                try {
                    const rows = db ? await new Promise((resolve) => {
                        db.all("SELECT id, nama FROM cameras", [], (err, r) => resolve(err ? [] : (r || [])));
                    }) : [];
                    rows.forEach(r => camNameById[String(r.id)] = r.nama);
                } catch (e) { }
                const items = [];
                cameraFolders.forEach(folder => {
                    const folderPath = path.join(recordingsDir, folder);
                    let files = [];
                    try { files = fs.readdirSync(folderPath); } catch (e) { files = []; }
                    const cameraId = Number(folder.replace('cam_', '')) || null;
                    files.forEach(file => {
                        const fullPath = path.join(folderPath, file);
                        let stats;
                        try { stats = fs.statSync(fullPath); } catch (e) { return; }
                        if (!stats.isFile()) return;

                        // Only include video files
                        const videoExts = ['.mp4', '.fmp4', '.ts', '.mkv'];
                        const ext = path.extname(file).toLowerCase();
                        if (!videoExts.includes(ext)) return;

                        // Use file mtime for date filtering (server local time)
                        const d = new Date(stats.mtime);
                        const yr = d.getFullYear();
                        const mo = String(d.getMonth() + 1).padStart(2, '0');
                        const da = String(d.getDate()).padStart(2, '0');
                        const createdAtStr = `${yr}-${mo}-${da}`;
                        if (createdAtStr !== date) return;
                        const relPath = path.relative(__dirname, fullPath).replace(/\\/g, '/');
                        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2) + ' MB';
                        items.push({
                            cameraId,
                            cameraName: camNameById[String(cameraId)] || folder,
                            filename: file,
                            relPath: relPath,
                            sizeText: sizeMb,
                            mtime: stats.mtime
                        });
                    });
                });
                items.sort((a, b) => b.mtime - a.mtime);
                const latest = items.slice(0, 10);
                const base = getBaseUrl();
                let response = `<b>📅 Arsip Tanggal ${date}</b>\n\n`;
                if (latest.length > 0) {
                    latest.forEach(it => {
                        const url = `${base}/${it.relPath}`;
                        response += `📹 <b>${it.cameraName}</b>\n💾 ${it.sizeText}\n🔗 <a href="${url}">Download</a>\n\n`;
                    });
                } else {
                    response += 'Tidak ada file rekaman untuk tanggal tersebut.';
                }
                bot.sendMessage(chatId, response, { parse_mode: 'HTML', reply_markup: getMainKeyboard() });
            } catch (e) {
                bot.sendMessage(chatId, 'Terjadi kesalahan memproses permintaan.');
            } finally {
                clearUserState(chatId);
            }
        }

        // --- Change Password Flow ---
        else if (state.step === 'ask_new_username') {
            state.username = text.trim();
            if (state.username.length < 3) {
                bot.sendMessage(chatId, '❌ Username minimal 3 karakter. Silakan input ulang:');
                return;
            }
            state.step = 'ask_new_password';
            bot.sendMessage(chatId, `<b>Langkah 2/2:</b>\nMasukkan Password baru untuk admin:`, {
                parse_mode: 'HTML',
                reply_markup: { force_reply: true }
            });
        }
        else if (state.step === 'ask_new_password') {
            state.password = text.trim();
            if (state.password.length < 4) {
                bot.sendMessage(chatId, '❌ Password minimal 4 karakter. Silakan input ulang:');
                return;
            }

            const result = services.updateAdminCredentials(state.username, state.password);

            if (result.success) {
                // Don't echo password in plaintext for security
                const maskedPass = state.password.charAt(0) + '***' + state.password.charAt(state.password.length - 1);
                bot.sendMessage(chatId, `✅ <b>Sukses!</b>\nCredential admin berhasil diperbarui.\n\n👤 Username: <code>${state.username}</code>\n🔑 Password: <code>${maskedPass}</code>`, {
                    parse_mode: 'HTML',
                    reply_markup: getMainKeyboard()
                });
            } else {
                bot.sendMessage(chatId, `❌ Gagal memperbarui credential: ${result.error}`, { reply_markup: getMainKeyboard() });
            }

            clearUserState(chatId);
        }
    });

    // /password - Change Admin Credentials
    bot.onText(/\/password/, (msg) => {
        const chatId = msg.chat.id;
        if (!isAdmin(chatId)) {
            bot.sendMessage(chatId, '⛔ Perintah ini hanya untuk Admin.');
            return;
        }

        setUserState(chatId, { step: 'ask_new_username' });
        bot.sendMessage(chatId, `⚠️ <b>Ganti Password Admin Web</b>\n\n<b>Langkah 1/2:</b>\nMasukkan Username baru:`, {
            parse_mode: 'HTML',
            reply_markup: { force_reply: true }
        });
    });

    // /start - Main Entry Point
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

        if (isAdmin(chatId)) {
            bot.sendMessage(chatId, `Halo <b>${username}</b>! 👋\nSelamat datang di Panel Kontrol CCTV.`, {
                parse_mode: 'HTML',
                reply_markup: getMainKeyboard()
            });
        } else {
            bot.sendMessage(chatId, `⚠️ <b>Akses Ditolak</b>\nID Chat Anda: <code>${chatId}</code>\nAnda belum terdaftar sebagai Admin.`, { parse_mode: 'HTML' });
        }
    });

    // Keep /help text command
    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        bot.sendMessage(chatId, 'ℹ️ <b>Bantuan</b>\nGunakan perintah /start untuk membuka menu utama interaktif.', { parse_mode: 'HTML' });
    });
}

module.exports = {
    init,
    sendMessage,
    stop,
    restart
};
