// Tools untuk update RTSP URL di database setelah reset
const sqlite3 = require('sqlite3').verbose();

const path = require('path');
const dbPath = path.resolve(__dirname, 'cameras.db');

// Fungsi update RTSP URL
function updateRTSPUrl(cameraName, newRTSPUrl) {
    const db = new sqlite3.Database(dbPath);
    
    return new Promise((resolve, reject) => {
        db.run(
            "UPDATE cameras SET url_rtsp = ? WHERE nama = ?",
            [newRTSPUrl, cameraName],
            function(err) {
                if (err) {
                    console.error('❌ Error update database:', err.message);
                    reject(err);
                } else {
                    console.log(`✅ RTSP URL untuk ${cameraName} berhasil diupdate!`);
                    console.log(`   URL baru: ${newRTSPUrl}`);
                    console.log(`   Rows affected: ${this.changes}`);
                    resolve(this.changes);
                }
            }
        );
        
        db.close();
    });
}

// Fungsi untuk cek current URLs
function checkCurrentURLs() {
    const db = new sqlite3.Database('cameras.db');
    
    return new Promise((resolve, reject) => {
        db.all("SELECT id, nama, lokasi, url_rtsp FROM cameras WHERE nama LIKE '%anjungpura%'", (err, rows) => {
            if (err) {
                console.error('❌ Error query database:', err.message);
                reject(err);
            } else {
                console.log('\n📋 CURRENT RTSP URLs:');
                console.log('=' .repeat(60));
                
                if (rows.length === 0) {
                    console.log('❌ Tidak ada kamera Tanjungpura ditemukan');
                } else {
                    rows.forEach(row => {
                        console.log(`ID: ${row.id}`);
                        console.log(`Nama: ${row.nama}`);
                        console.log(`Lokasi: ${row.lokasi}`);
                        console.log(`RTSP URL: ${row.url_rtsp}`);
                        console.log('-'.repeat(40));
                    });
                }
                
                resolve(rows);
            }
            db.close();
        });
    });
}

// Fungsi untuk test RTSP connection
function testRTSPConnection(rtspUrl) {
    const net = require('net');
    const url = require('url');
    
    return new Promise((resolve) => {
        try {
            const parsedUrl = url.parse(rtspUrl);
            const ip = parsedUrl.hostname;
            const port = parsedUrl.port || 554;
            const path = parsedUrl.path;
            
            const socket = new net.Socket();
            socket.setTimeout(3000);
            
            socket.on('connect', () => {
                const rtspRequest = `DESCRIBE ${path} RTSP/1.0\r\n` +
                                   `CSeq: 1\r\n` +
                                   `User-Agent: CCTV-Test/1.0\r\n` +
                                   `Accept: application/sdp\r\n` +
                                   `\r\n`;
                
                socket.write(rtspRequest);
            });
            
            socket.on('data', (data) => {
                const response = data.toString();
                socket.destroy();
                
                if (response.includes('RTSP/1.0 200 OK')) {
                    resolve({ success: true, message: '✅ RTSP connection BERHASIL!' });
                } else if (response.includes('RTSP/1.0 401')) {
                    resolve({ success: false, message: '⚠️  Authentication required (credential salah)' });
                } else {
                    resolve({ success: false, message: `❌ RTSP error: ${response.split('\n')[0]}` });
                }
            });
            
            socket.on('error', () => {
                resolve({ success: false, message: '❌ Connection failed' });
            });
            
            socket.on('timeout', () => {
                socket.destroy();
                resolve({ success: false, message: '❌ Connection timeout' });
            });
            
            socket.connect(port, ip);
        } catch (err) {
            resolve({ success: false, message: `❌ URL parsing error: ${err.message}` });
        }
    });
}

// Main function
async function main() {
    console.log('🎯 UPDATE RTSP URL TOOLS');
    console.log('=' .repeat(50));
    
    // Cek current URLs
    const currentCameras = await checkCurrentURLs();
    
    if (currentCameras.length === 0) {
        console.log('\n❌ Tidak ada kamera Tanjungpura untuk diupdate');
        return;
    }
    
    // Contoh penggunaan (akan diganti dengan input user)
    console.log('\n💡 CONTOH UPDATE:');
    console.log('Untuk update RTSP URL, gunakan format:');
    console.log('node update_rtsp_url.js "Tanjungpura" "rtsp://admin:newpass@192.168.8.148:554/live/ch00_0"');
    
    // Test RTSP connection untuk current URLs
    console.log('\n🧪 Testing current RTSP connections...');
    for (const camera of currentCameras) {
        console.log(`\nTesting ${camera.nama}...`);
        const testResult = await testRTSPConnection(camera.url_rtsp);
        console.log(`Result: ${testResult.message}`);
    }
}

// Export functions untuk digunakan di file lain
module.exports = {
    updateRTSPUrl,
    checkCurrentURLs,
    testRTSPConnection
};

// Run if called directly
if (require.main === module) {
    main();
}