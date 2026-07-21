#!/bin/bash

# Pastikan folder transcode ada
mkdir -p logs

echo "=== CCTV H.265 to H.264 Transcoder ==="
echo "Gunakan script ini untuk kamera yang videonya blank/hitam di browser."
echo ""

# Read config
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG_FILE="$SCRIPT_DIR/config.json"

# Helper function to parse JSON value
get_config_value() {
    local key="$1"
    local default="$2"
    if [ -f "$CONFIG_FILE" ]; then
        # Try matching string value first
        local value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CONFIG_FILE" | cut -d'"' -f4)
        
        # If empty, try matching number/boolean
        if [ -z "$value" ]; then
            value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*[^,}]*" "$CONFIG_FILE" | cut -d':' -f2 | tr -d ' "')
        fi
        
        if [ -n "$value" ]; then
            echo "$value"
        else
            echo "$default"
        fi
    else
        echo "$default"
    fi
}

RTSP_PORT=$(get_config_value "rtsp_port" "8555")

read -p "Masukkan ID Kamera (lihat di Admin, misal 1): " CAMERA_ID
read -p "Masukkan URL RTSP Asli: " RTSP_URL

echo ""
echo "Memulai Transcoding untuk Kamera $CAMERA_ID (Port: $RTSP_PORT)..."
echo "Video akan tersedia di Dashboard."
echo "Tekan Ctrl+C untuk berhenti."

# Jalankan FFmpeg untuk convert H.265 -> H.264 dan kirim ke MediaMTX
ffmpeg -i "$RTSP_URL" \
  -c:v libx264 -preset ultrafast -tune zerolatency \
  -b:v 600k -s 854x480 \
  -an \
  -f rtsp rtsp://127.0.0.1:$RTSP_PORT/cam_${CAMERA_ID}
