const { Telegraf, Markup } = require('telegraf');
const { ethers } = require('ethers');
const axios = require('axios');
const mysql = require('mysql2/promise');
require('dotenv').config();

// Inisialisasi Bot & RPC Blockchain
const bot = new Telegraf(process.env.BOT_TOKEN);
const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.binance.org/');

// Konfigurasi Environment
const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID);
const ADMIN_WALLET = process.env.ADMIN_WALLET_ADDRESS;
const CHANNEL_ID = process.env.CHANNEL_ID; 
const FEE_IDR = 3000;

// Objek untuk mencatat State langkah input user secara temporary
const userStates = {};

// Koneksi Database Terpusat
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==========================================
// 💡 FUNGSI PEMBANTU (HELPERS)
// ==========================================

// 1. Ambil Harga Realtime USDT ke IDR dari Binance
async function getUsdtRate() {
    try {
        const res = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=USDTIDR');
        return Math.round(parseFloat(res.data.price));
    } catch {
        return 16250; // Angka cadangan jika API Binance rate-limit
    }
}

// 2. Cek Otomatis TxHash Valid atau Tidak di Jaringan BSC
async function verifyBscTxHash(txHash) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || !receipt.status) return null;

        const USDT_BSC_CONTRACT = "0x55d398326f99059ff775485246999027b3197955";
        const iface = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
        
        let amount = 0;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() === USDT_BSC_CONTRACT.toLowerCase()) {
                const parsed = iface.parseLog(log);
                if (parsed && parsed.args.to.toLowerCase() === ADMIN_WALLET.toLowerCase()) {
                    amount += parseFloat(ethers.formatUnits(parsed.args.value, 18));
                }
            }
        }
        return amount > 0 ? amount : null;
    } catch (error) {
        return null;
    }
}

// 3. Render Dashboard 1 Menu Utama Dinamis & Estetik
async function renderDashboard(ctx, loadingState = false) {
    const userId = ctx.from.id;
    const rate = await getUsdtRate();
    
    const [rows] = await db.execute("SELECT * FROM users WHERE telegram_id = ?", [userId]);
    const user = rows[0];

    let statusIndicator = "🔴 *BELUM SIAP (REKENING KOSONG)*";
    let rekText = "⚠️ _Silakan atur rekening tujuan Anda melalui tombol di bawah_";
    
    if (user && user.payment_account) {
        statusIndicator = "🟢 *AKUN SIAP BERTRANSAKSI*";
        rekText = `💳 *${user.payment_method}* ── \`${user.payment_account}\`\n👤 a.n _${user.account_name}_`;
    }

    const text = `⚡ *PANSA DIGITAL VAULT SYSTEM* ⚡\n` +
                 `==================================\n\n` +
                 `📈 *KURS REALTIME USDT*\n` +
                 `└ *Rp ${rate.toLocaleString('id-ID')}* / USDT 🟢\n\n` +
                 `💸 *BIAYA ADM / FEE POTONGAN*\n` +
                 `└ Rp ${FEE_IDR.toLocaleString('id-ID')} (Flat)\n\n` +
                 `📥 *ALAMAT DOMPET DEPOSIT (BSC/BEP-20)*\n` +
                 `└ \`${ADMIN_WALLET}\` 📋 *(Sentuh untuk salin)*\n\n` +
                 `🛡️ *STATUS REGISTRASI:* ${statusIndicator}\n` +
                 `${rekText}\n\n` +
                 `==================================\n` +
                 `💡 _Kirim USDT Anda ke alamat di atas, lalu tekan tombol konfirmasi TxHash dibawah._`;

    const buttons = Markup.inlineKeyboard([
        [Markup.button.callback(loadingState ? '⏳ MEMUAT DATA HARGA...' : '🔄 REFRESH HARGA REALTIME', 'refresh')],
        [Markup.button.callback(user && user.payment_account ? '⚙️ UBAH REKENING / E-WALLET' : '➕ ATUR REKENING / E-WALLET', 'set_rek')],
        [Markup.button.callback('🚀 KONFIRMASI & KIRIM TXHASH 🚀', 'send_tx')]
    ]);

    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buttons });
        } else {
            await ctx.reply(text, { parse_mode: 'Markdown', ...buttons });
        }
    } catch (e) {
        // Mencegah crash jika teks yang diupdate persis sama
    }
}

// 4. Proteksi Check Join Channel Wajib
async function checkUserJoin(ctx) {
    try {
        const member = await ctx.telegram.getChatMember(CHANNEL_ID, ctx.from.id);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch {
        return false;
    }
}

// ==========================================
// 🤖 ALUR LOGIKA TELEGRAM BOT
// ==========================================

// Perintah /start
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    userStates[userId] = null; // Reset state

    await db.execute("INSERT IGNORE INTO users (telegram_id, username) VALUES (?, ?)", [userId, ctx.from.username]);
    
    const isJoined = await checkUserJoin(ctx);
    if (isJoined) {
        return renderDashboard(ctx);
    }

    return ctx.reply(
        `❌ *AKSES DITOLAK!*\n\nAnda wajib bergabung ke channel komunitas kami terlebih dahulu sebelum menggunakan fitur sistem penampungan bot ini.`, 
        Markup.inlineKeyboard([
            [Markup.button.url('📢 JOIN CHANNEL PANSA', `https://t.me/${CHANNEL_ID.replace('@','')}`)],
            [Markup.button.callback('✅ SAYA SUDAH JOIN', 'check_join')]
        ])
    );
});

// Aksi Klik Tombol "Saya Sudah Join"
bot.action('check_join', async (ctx) => {
    const isJoined = await checkUserJoin(ctx);
    if (isJoined) {
        await ctx.answerCbQuery('🟢 Akses berhasil dibuka! Selamat datang.');
        return renderDashboard(ctx);
    }
    await ctx.answerCbQuery('❌ Anda terdeteksi belum masuk ke channel!', { show_alert: true });
});

// Aksi Klik Tombol "Refresh" Beranimasi Teks
bot.action('refresh', async (ctx) => {
    await ctx.answerCbQuery('⚡ Menghubungkan ke API Binance...');
    await renderDashboard(ctx, true);
    setTimeout(async () => {
        await renderDashboard(ctx, false);
    }, 700);
});

// Aksi Klik Tombol "Atur/Ubah Rekening"
bot.action('set_rek', async (ctx) => {
    const userId = ctx.from.id;
    userStates[userId] = { step: 'WAITING_REKENING' };
    await ctx.answerCbQuery();
    await ctx.reply(
        "📝 *PENGATURAN REKENING INDIVIDU*\n\n" +
        "Silakan ketik detail data pembayaran Anda dengan format tepat seperti di bawah:\n\n" +
        "`BANK/E-WALLET | NOMOR REKENING | NAMA PEMILIK`\n\n" +
        "💡 *Contoh:* `DANA | 08123456789 | Jhodi Firmansyah`\n" +
        "💡 *Contoh:* `BCA | 5220391234 | Jhodi Firmansyah`", 
        { parse_mode: 'Markdown' }
    );
});

// Aksi Klik Tombol "Kirim TxHash"
bot.action('send_tx', async (ctx) => {
    const userId = ctx.from.id;
    const [rows] = await db.execute("SELECT * FROM users WHERE telegram_id = ?", [userId]);
    
    if (!rows[0] || !rows[0].payment_account) {
        return ctx.answerCbQuery('❌ Maaf! Anda wajib mengisi pengaturan rekening Anda terlebih dahulu sebelum mengirim TxHash.', { show_alert: true });
    }

    userStates[userId] = { step: 'WAITING_TXHASH' };
    await ctx.answerCbQuery();
    await ctx.reply("📥 *KONFIRMASI DEPOSIT COIN*\n\nSilakan masukkan string *TxHash* atau lampirkan *Link Transaksi BscScan* Anda:");
});

// Mendengar Semua Balasan Text Masuk (Untuk Alur Pengisian State)
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];

    if (!state) return;

    // ALUR 1: Memproses Input Set Rekening
    if (state.step === 'WAITING_REKENING') {
        const textData = ctx.message.text;
        if (!textData.includes('|')) {
            return ctx.reply("❌ Format penulisan salah. Harap gunakan pemisah garis vertikal ( | ) sesuai instruksi.");
        }

        const parts = textData.split('|').map(item => item.trim());
        if (parts.length !== 3 || parts.some(p => p === '')) {
            return ctx.reply("❌ Data tidak lengkap. Pastikan memasukkan Bank, Nomor, dan Nama Lengkap Anda.");
        }

        const [method, account, name] = parts;
        await db.execute(
            "UPDATE users SET payment_method = ?, payment_account = ?, account_name = ? WHERE telegram_id = ?", 
            [method, account, name, userId]
        );

        userStates[userId] = null; // Clear State
        await ctx.reply("✅ *DATA REKENING BERHASIL DISIMPAN!*");
        return renderDashboard(ctx);
    }

    // ALUR 2: Memproses Input Pengiriman TxHash
    if (state.step === 'WAITING_TXHASH') {
        let rawInput = ctx.message.text.trim();
        // Bersihkan data otomatis apabila input berupa tautan link url bscscan
        let txHash = rawInput.includes('/') ? rawInput.split('/').pop() : rawInput;

        // Validasi panjang karakter dasar TxHash Ethereum/BSC
        if (txHash.length !== 66 || !txHash.startsWith('0x')) {
            return ctx.reply("❌ String TxHash tidak valid. Pastikan diawali kode '0x' dengan jumlah 66 karakter.");
        }

        await ctx.reply("⏳ *MEMVERIFIKASI DATA BLOCKCHAIN...*\nSistem sedang melakukan pemeriksaan transaksi Anda pada node BSC (BEP-20). Mohon tunggu.");
        
        const amountUsdt = await verifyBscTxHash(txHash);
        if (!amountUsdt) {
            return ctx.reply("❌ *VERIFIKASI GAGAL!*\nTransaksi tidak ditemukan di blockchain, status gagal, atau dana dikirim ke alamat yang salah.");
        }

        const rate = await getUsdtRate();
        const totalIdr = (amountUsdt * rate) - FEE_IDR;

        try {
            // Catat transaksi ke DB dengan status default PENDING
            await db.execute(
                "INSERT INTO transactions (telegram_id, txhash, amount_usdt, rate_idr, total_idr) VALUES (?, ?, ?, ?, ?)", 
                [userId, txHash, amountUsdt, rate, totalIdr]
            );

            const [userRows] = await db.execute("SELECT * FROM users WHERE telegram_id = ?", [userId]);
            const user = userRows[0];

            // AUTOMATION: KIRIM LAPORAN PREMIUM KE CHAT PRIVATE ADMIN
            const adminText = `🚨 *NOTIFIKASI TRANSAKSI MASUK* 🚨\n` +
                              `==================================\n` +
                              `👤 *Pengirim:* @${ctx.from.username || 'Tanpa_Username'}\n` +
                              `🆔 *ID User:* \`${userId}\`\n\n` +
                              `💰 *USDT Diterima:* ${amountUsdt} USDT 🟢\n` +
                              `📉 *Kurs Transaksi:* Rp ${rate.toLocaleString('id-ID')}\n` +
                              `💸 *Total IDR Bersih (Potong Fee):* *Rp ${totalIdr.toLocaleString('id-ID')}*\n\n` +
                              `🏛️ *REKENING TUJUAN TRANSFER USER:*\n` +
                              `⚡ *${user.payment_method}* ── \`${user.payment_account}\`\n` +
                              `👤 a.n _${user.account_name}_\n\n` +
                              `🔗 *BUKTI VALIDASI BLOCKCHAIN:*\n` +
                              `└ [Klik untuk Cek Real BscScan](https://bscscan.com/tx/${txHash})\n` +
                              `==================================`;

            const adminButtons = Markup.inlineKeyboard([
                [
                    Markup.button.callback('🟢 SELESAI (SUDAH TRANSFER)', `approve_${txHash}`),
                    Markup.button.callback('🔴 TOLAK TRANSAKSI', `reject_${txHash}`)
                ]
            ]);

            await bot.telegram.sendMessage(ADMIN_ID, adminText, { parse_mode: 'Markdown', ...adminButtons });
            
            userStates[userId] = null; // Clear State
            return ctx.reply("🚀 *VALIDASI BERHASIL!*\n\nKoin USDT Anda sukses terverifikasi masuk ke dompet admin. Detail rekening Anda telah diteruskan otomatis ke admin untuk proses transfer uang.");
        } catch (dbError) {
            return ctx.reply("❌ *KLAIM GAGAL!* TxHash ini telah terdata dan pernah digunakan sebelumnya di dalam sistem kami.");
        }
    }
});

// ==========================================
// 🔑 AKSI PANEL DASHBOARD ADMIN
// ==========================================

// Admin Klik Tombol Setujui (Approve)
bot.action(/^approve_(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ Anda bukan admin!');
    
    const txHash = ctx.match[1];
    const [rows] = await db.execute("SELECT * FROM transactions WHERE txhash = ?", [txHash]);
    
    if (rows[0] && rows[0].status === 'PENDING') {
        await db.execute("UPDATE transactions SET status = 'SUCCESS' WHERE txhash = ?", [txHash]);
        
        await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n✅ *STATUS AKHIR: SUKSES & RUPIAH DITRANSFER OLEH ADMIN*`);
        await ctx.answerCbQuery('✅ Berhasil menyetujui transaksi.');
        
        // Kirim alert notifikasi ke user terkait
        return bot.telegram.sendMessage(rows[0].telegram_id, "🎉 *TRANSAKSI SELESAI!*\n\nAdmin telah memproses transfer dana Rupiah ke rekening/E-Wallet Anda. Silakan cek mutasi saldo Anda sekarang. Terima kasih!");
    }
    await ctx.answerCbQuery('❌ Transaksi sudah diproses sebelumnya.');
});

// Admin Klik Tombol Tolak (Reject)
bot.action(/^reject_(.+)$/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('❌ Anda bukan admin!');

    const txHash = ctx.match[1];
    const [rows] = await db.execute("SELECT * FROM transactions WHERE txhash = ?", [txHash]);
    
    if (rows[0] && rows[0].status === 'PENDING') {
        await db.execute("UPDATE transactions SET status = 'FAILED' WHERE txhash = ?", [txHash]);
        
        await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n❌ *STATUS AKHIR: TRANSAKSI DITOLAK OLEH ADMIN*`);
        await ctx.answerCbQuery('❌ Berhasil menolak transaksi.');
        
        // Kirim alert notifikasi ke user terkait
        return bot.telegram.sendMessage(rows[0].telegram_id, "❌ *TRANSAKSI DEPOSIT DITOLAK!*\n\nData klaim transfer Anda ditolak oleh pihak admin. Silakan periksa kembali TxHash Anda atau hubungi admin support jika merasa ada kekeliruan.");
    }
    await ctx.answerCbQuery('❌ Transaksi sudah diproses sebelumnya.');
});

// Run Application
bot.launch().then(() => {
    console.log("====================================");
    console.log("🚀 PANSA DIGITAL VAULT BOT RUNNING...");
    console.log("====================================");
});
