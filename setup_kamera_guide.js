// Panduan setup ulang kamera via app Tuya/Smart Life
const fs = require('fs');

console.log('📱 PANDUAN SETUP ULANG KAMERA BARDI/TUYA VIA APP');
console.log('=' .repeat(50));

const guide = `
🎯 LANGKAH-LANGKAH SETUP ULANG KAMERA:

1️⃣  DOWNLOAD & INSTALL APP:
   • Tuya Smart (recommended)
   • Smart Life (alternative)
   • Pilih salah satu dari Play Store/App Store

2️⃣  HAPUS KAMERA LAMA (jika ada):
   • Buka app Tuya Smart
   • Cari kamera yang mau di-setup ulang
   • Klik titik 3 di pojok kanan
   • Pilih "Remove Device"

3️⃣  RESET KAMERA (jika perlu):
   • Tekan tombol reset 10-15 detik
   • Tunggu kamera berbunyi "reset successful"
   • Atau lampu LED akan berkedip cepat

4️⃣  ADD NEW DEVICE:
   • Klik "+" atau "Add Device"
   • Pilih "Security & Sensors"
   • Pilih "Smart Camera"
   • Pilih "QR Code" atau "Smart Camera"

5️⃣  PAIRING DEVICE:
   • Pastikan kamera dalam mode pairing (LED berkedip cepat)
   • Scan QR code di kamera
   • Atau masukkan WiFi credentials
   • Tunggu sampai "Device Added Successfully"

6️⃣  DAPATKAN RTSP URL:
   • Setelah kamera terhubung
   • Klik device → Settings → Network Settings
   • Cari "RTSP" atau "Stream Settings"
   • Copy RTSP URL yang muncul

7️⃣  FORMAT RTSP YANG BIASA MUNCUL:
   rtsp://admin:password@192.168.x.x:554/XXXXXXXX

8️⃣  UPDATE DI CCTV SYSTEM:
   • Login ke admin panel
   • Edit kamera yang error
   • Paste RTSP URL baru
   • Save dan test koneksi

💡 TIPS:
• Pastikan kamera dan HP di jaringan WiFi yang sama saat setup
• Gunakan WiFi 2.4GHz (bukan 5GHz)
• Catat password baru yang dibuat di app
• Simpan RTSP URL dengan benar

⚠️  JIKA TIDAK WORK:
• Factory reset kamera
• Coba app Smart Life (alternative)
• Hubungi support Bardi/Tuya
• Atau ganti dengan kamera yang support ONVIF
`;

console.log(guide);

// Simpan panduan ke file
fs.writeFileSync('setup_kamera_guide.txt', guide);
console.log('\n✅ Panduan disimpan ke: setup_kamera_guide.txt');
console.log('\n🔧 SILAKAN IKUTI LANGKAH DI ATAS UNTUK SETUP ULANG KAMERA!');
console.log('\n💬 Setelah dapat RTSP URL baru, beritahu saya untuk update database!');