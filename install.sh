#!/usr/bin/env bash

# PiSecureCloud - Automatisches Installationsskript für Raspberry Pi 4
# Dieses Skript muss mit root-Rechten ausgeführt werden (sudo).

set -e

# Farben für schöne Konsolenausgabe
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================================${NC}"
echo -e "${BLUE}        PiSecureCloud - Installations-Assistent          ${NC}"
echo -e "${BLUE}========================================================${NC}"

# 1. Root-Rechte überprüfen
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Fehler: Bitte führe dieses Skript als root aus! (sudo ./install.sh)${NC}"
  exit 1
fi

# 2. System-Updates & Abhängigkeiten
echo -e "\n${YELLOW}[1/7] Installiere System-Updates und grundlegende Tools...${NC}"
apt-get update -y
apt-get install -y curl wget git util-linux coreutils

# 3. Node.js installieren
echo -e "\n${YELLOW}[2/7] Überprüfe Node.js Installation...${NC}"
if ! command -v node &> /dev/null || [ $(node -v | cut -d'v' -f2 | cut -d'.' -f1) -lt 18 ]; then
  echo -e "${BLUE}Installiere Node.js v18 (LTS)...${NC}"
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
  echo -e "${GREEN}Node.js $(node -v) erfolgreich installiert!${NC}"
else
  echo -e "${GREEN}Node.js ist bereits vorhanden: $(node -v)${NC}"
fi

# 4. Externe Festplatte erkennen und einrichten
echo -e "\n${YELLOW}[3/7] Suche nach angeschlossenen USB-Festplatten...${NC}"
STORAGE_DIR="/mnt/pisecurecloud"
FALLBACK_DIR="/var/lib/pisecurecloud"
MOUNTED_DEVICE=""
USE_FALLBACK=false

# Finde alle sda/sdb/sdc Partitionen
PARTITIONS=$(lsblk -pnro NAME,TYPE | grep -E 'part$' | cut -d' ' -f1 || true)
LARGEST_PART=""
LARGEST_SIZE=0

if [ -n "$PARTITIONS" ]; then
  for PART in $PARTITIONS; do
    # Prüfe, ob es eine USB-Festplatte ist (nicht MMC oder loop)
    if [[ "$PART" == /dev/sd* ]]; then
      SIZE=$(blockdev --getsize64 "$PART" || echo 0)
      if [ "$SIZE" -gt "$LARGEST_SIZE" ]; then
        LARGEST_SIZE=$SIZE
        LARGEST_PART=$PART
      fi
    fi
  done
fi

if [ -n "$LARGEST_PART" ]; then
  HUMAN_SIZE=$(numfmt --to=iec --suffix=B "$LARGEST_SIZE")
  echo -e "${GREEN}Externe USB-Partition erkannt: $LARGEST_PART ($HUMAN_SIZE)${NC}"
  
  # Prüfe, ob Partition bereits gemountet ist
  MOUNT_POINT=$(lsblk -no MOUNTPOINT "$LARGEST_PART" | head -n1 || true)
  
  if [ -n "$MOUNT_POINT" ]; then
    echo -e "${GREEN}Partition ist bereits gemountet unter: $MOUNT_POINT${NC}"
    STORAGE_DIR="$MOUNT_POINT"
  else
    echo -e "${BLUE}Richte Mount für $LARGEST_PART ein...${NC}"
    mkdir -p "$STORAGE_DIR"
    
    # Prüfen, ob Dateisystem existiert, ansonsten erstellen (ext4)
    FSTYPE=$(lsblk -no FSTYPE "$LARGEST_PART" | head -n1 || true)
    if [ -z "$FSTYPE" ]; then
      echo -e "${YELLOW}Kein Dateisystem auf $LARGEST_PART gefunden. Formatiere als ext4 (Daten auf dieser Partition werden gelöscht!)...${NC}"
      mkfs.ext4 -F "$LARGEST_PART"
      FSTYPE="ext4"
    else
      echo -e "${GREEN}Dateisystem erkannt: $FSTYPE (Daten bleiben erhalten!)${NC}"
    fi

    # Mount durchführen
    mount "$LARGEST_PART" "$STORAGE_DIR"
    
    # In /etc/fstab eintragen für automatischen Mount nach Neustart (nofail verhindert Boot-Hänger bei abgezogener Disk)
    UUID=$(blkid -o value -s UUID "$LARGEST_PART" || true)
    if [ -n "$UUID" ]; then
      if ! grep -q "$UUID" /etc/fstab; then
        echo -e "${BLUE}Trage Mount in /etc/fstab ein...${NC}"
        echo "UUID=$UUID $STORAGE_DIR $FSTYPE defaults,nofail 0 2" >> /etc/fstab
      fi
    else
      if ! grep -q "$LARGEST_PART" /etc/fstab; then
        echo -e "${BLUE}Trage Mount in /etc/fstab ein...${NC}"
        echo "$LARGEST_PART $STORAGE_DIR $FSTYPE defaults,nofail 0 2" >> /etc/fstab
      fi
    fi
    echo -e "${GREEN}$LARGEST_PART erfolgreich gemountet nach $STORAGE_DIR!${NC}"
  fi
  MOUNTED_DEVICE="$LARGEST_PART"
else
  echo -e "${YELLOW}WARNUNG: Keine externe USB-Festplatte erkannt!${NC}"
  echo -e "${YELLOW}Als Fallback wird der interne SD-Karten-Speicher ($FALLBACK_DIR) verwendet.${NC}"
  echo -e "${YELLOW}Dies ist für erste Tests okay, belegt aber den Speicherplatz deines Raspberry Pi Betriebssystems.${NC}"
  mkdir -p "$FALLBACK_DIR"
  STORAGE_DIR="$FALLBACK_DIR"
  USE_FALLBACK=true
fi

# 5. App-Dateien kopieren und npm dependencies installieren
echo -e "\n${YELLOW}[4/7] Bereite App-Verzeichnis vor...${NC}"
APP_DIR="/opt/pisecurecloud"
mkdir -p "$APP_DIR"

# Kopiere aktuelle Quelldateien ins Zielverzeichnis
echo -e "${BLUE}Kopiere App-Dateien nach $APP_DIR...${NC}"
cp -r ./package.json "$APP_DIR/"
cp -r ./server.js "$APP_DIR/"
cp -r ./public "$APP_DIR/"

# In App-Verzeichnis wechseln und npm install ausführen
cd "$APP_DIR"
echo -e "${BLUE}Installiere Node.js-Abhängigkeiten (npm install)...${NC}"
npm install --omit=dev

# 6. Cloudflared (Cloudflare Tunnel CLI) installieren
echo -e "\n${YELLOW}[5/7] Installiere Cloudflare Tunnel...${NC}"
ARCH=$(uname -m)
CLOUDFLARED_URL=""

if [ "$ARCH" = "x86_64" ]; then
  CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
  CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
elif [[ "$ARCH" == armv7* ]] || [ "$ARCH" = "armv6l" ]; then
  CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm"
else
  # Fallback auf amd64
  CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
fi

if [ -f "/usr/local/bin/cloudflared" ]; then
  echo -e "${GREEN}cloudflared ist bereits installiert. Überspringe Download.${NC}"
else
  systemctl stop cloudflared-tunnel.service 2>/dev/null || true
  echo -e "${BLUE}Lade cloudflared für Architektur $ARCH herunter...${NC}"
  wget -q -O /usr/local/bin/cloudflared "$CLOUDFLARED_URL"
  chmod +x /usr/local/bin/cloudflared
  echo -e "${GREEN}cloudflared erfolgreich installiert! Version: $(cloudflared --version | cut -d' ' -f3)${NC}"
fi

# 7. Systemd-Dienste einrichten und starten
echo -e "\n${YELLOW}[6/7] Erstelle System-Dienste (systemd)...${NC}"

# 7a. PiSecureCloud Node Server Dienst
cat <<EOF > /etc/systemd/system/pisecurecloud.service
[Unit]
Description=PiSecureCloud Node Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
EOF

# 7b. Cloudflare Tunnel Dienst
rm -f /var/log/cloudflared-tunnel.log
touch /var/log/cloudflared-tunnel.log

cat <<EOF > /etc/systemd/system/cloudflared-tunnel.service
[Unit]
Description=PiSecureCloud Cloudflare Quick Tunnel
After=network.target pisecurecloud.service

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:3000
Restart=always
RestartSec=5
StandardOutput=append:/var/log/cloudflared-tunnel.log
StandardError=append:/var/log/cloudflared-tunnel.log

[Install]
WantedBy=multi-user.target
EOF

# Lade Systemd neu
systemctl daemon-reload

# Aktiviere und starte die Dienste
echo -e "${BLUE}Starte PiSecureCloud Server-Dienst...${NC}"
systemctl enable pisecurecloud.service
systemctl restart pisecurecloud.service

echo -e "${BLUE}Starte Cloudflare Tunnel-Dienst...${NC}"
systemctl enable cloudflared-tunnel.service
systemctl restart cloudflared-tunnel.service

# 8. Globale CLI Steuerbefehle erstellen
echo -e "\n${YELLOW}[7/7] Erstelle globale Steuerungsbefehle (CLI)...${NC}"

# Befehl 1: Cloud Offline schalten (Wartungsmodus)
cat <<'EOF' > /usr/local/bin/pisecurecloud-offline
#!/usr/bin/env bash
mkdir -p /var/lib/pisecurecloud
touch /var/lib/pisecurecloud/offline.flag
echo "PiSecureCloud ist jetzt OFFLINE. Wartungsmodus aktiv."
EOF
chmod +x /usr/local/bin/pisecurecloud-offline

# Befehl 2: Cloud Online schalten
cat <<'EOF' > /usr/local/bin/pisecurecloud-online
#!/usr/bin/env bash
rm -f /var/lib/pisecurecloud/offline.flag
echo "PiSecureCloud ist jetzt wieder ONLINE."
EOF
chmod +x /usr/local/bin/pisecurecloud-online

# Befehl 3: Cloud komplett stoppen (Dienste stoppen)
cat <<'EOF' > /usr/local/bin/pisecurecloud-stop
#!/usr/bin/env bash
systemctl stop cloudflared-tunnel.service
systemctl stop pisecurecloud.service
echo "PiSecureCloud-Dienste wurden gestoppt."
EOF
chmod +x /usr/local/bin/pisecurecloud-stop

# Befehl 4: Cloud komplett starten (Dienste starten)
cat <<'EOF' > /usr/local/bin/pisecurecloud-start
#!/usr/bin/env bash
systemctl start pisecurecloud.service
systemctl start cloudflared-tunnel.service
echo "PiSecureCloud-Dienste wurden gestartet."
/opt/pisecurecloud/show-url.sh
EOF
chmod +x /usr/local/bin/pisecurecloud-start

# Befehl 5: Cloud aktualisieren (Kopieren der neuen Dateien und npm install)
cat <<'EOF' > /usr/local/bin/pisecurecloud-update
#!/usr/bin/env bash
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SRC_DIR="/home/picloud/quick-meitner"
APP_DIR="/opt/pisecurecloud"

echo -e "${YELLOW}Starte PiSecureCloud Update-Prozess...${NC}"

# Überprüfe, ob Quellverzeichnis existiert
if [ ! -d "$SRC_DIR" ]; then
  # Versuche im Home-Verzeichnis des ausführenden Users zu suchen
  REAL_USER=${SUDO_USER:-$(whoami)}
  SRC_DIR="/home/$REAL_USER/quick-meitner"
  if [ ! -d "$SRC_DIR" ]; then
    echo -e "${RED}Fehler: Quellordner mit neuen Dateien nicht gefunden.${NC}"
    echo -e "Bitte lade deine Dateien per WinSCP nach ${YELLOW}/home/picloud/quick-meitner${NC} hoch."
    exit 1
  fi
fi

echo -e "Quellordner gefunden: ${GREEN}$SRC_DIR${NC}"

# 1. Falls es ein Git-Repository mit Remote ist, hole Updates automatisch
if [ -d "$SRC_DIR/.git" ]; then
  cd "$SRC_DIR" || exit 1
  if git remote | grep -q '.'; then
    echo "Hole aktuelle Änderungen von Git (git fetch & reset)..."
    git fetch --all
    BRANCH=$(git symbolic-ref --short -q HEAD || echo "main")
    git reset --hard "origin/$BRANCH"
  fi
fi

# 2. Dateien kopieren
echo "Kopiere Anwendungsdateien nach $APP_DIR..."
cp "$SRC_DIR/server.js" "$APP_DIR/"
mkdir -p "$APP_DIR/public"
cp -r "$SRC_DIR/public/"* "$APP_DIR/public/"

# Falls neue Dependencies hinzugekommen sind, auch package.json kopieren
if [ -f "$SRC_DIR/package.json" ]; then
  cp "$SRC_DIR/package.json" "$APP_DIR/"
  if [ -f "$SRC_DIR/package-lock.json" ]; then
    cp "$SRC_DIR/package-lock.json" "$APP_DIR/"
  fi
  
  echo "Überprüfe und installiere eventuelle npm-Abhängigkeiten..."
  cd "$APP_DIR" || exit 1
  npm install --omit=dev
fi

# 3. Service neu starten
echo "Starte PiSecureCloud-Dienst neu..."
systemctl restart pisecurecloud.service

echo -e "${GREEN}Update erfolgreich abgeschlossen! PiSecureCloud wurde aktualisiert und neu gestartet.${NC}"
EOF
chmod +x /usr/local/bin/pisecurecloud-update

# Hilfsskript show-url.sh im App-Verzeichnis erstellen
cat <<'EOF' > "$APP_DIR/show-url.sh"
#!/usr/bin/env bash
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

LOGFILE="/var/log/cloudflared-tunnel.log"

if [ ! -f "$LOGFILE" ]; then
  echo -e "${RED}Fehler: Tunnel-Logdatei existiert nicht.${NC}"
  exit 1
fi

URL=$(grep -o 'https://[a-zA-Z0-9-]\+\.trycloudflare\.com' "$LOGFILE" | tail -n 1)

if [ -n "$URL" ]; then
  echo -e "${YELLOW}================================================================${NC}"
  echo -e " ${GREEN}PI-SECURE-CLOUD IST JETZT BEREIT UND WELTWEIT ERREICHBAR!${NC}"
  echo -e " Öffne diesen Link in deinem Browser:"
  echo -e " ${GREEN}$URL${NC}"
  echo -e "${YELLOW}================================================================${NC}"
  echo -e "Steuerung der Cloud über das Terminal:"
  echo -e "  - Offline schalten (Wartung):   ${YELLOW}sudo pisecurecloud-offline${NC}"
  echo -e "  - Online schalten:              ${YELLOW}sudo pisecurecloud-online${NC}"
  echo -e "  - Dienste stoppen:              ${YELLOW}sudo pisecurecloud-stop${NC}"
  echo -e "  - Dienste starten:              ${YELLOW}sudo pisecurecloud-start${NC}"
  echo -e "  - Programm aktualisieren:       ${YELLOW}sudo pisecurecloud-update${NC}"
  echo -e "  - URL abfragen:                 ${YELLOW}sudo /opt/pisecurecloud/show-url.sh${NC}"
  exit 0
else
  echo -e "${RED}Tunnel-URL wird noch generiert... Bitte warte kurz oder führe${NC}"
  echo -e "${RED}den Befehl 'sudo /opt/pisecurecloud/show-url.sh' gleich nochmal aus.${NC}"
  exit 1
fi
EOF
chmod +x "$APP_DIR/show-url.sh"

# Führe show-url.sh nach einer kurzen Wartezeit aus
sleep 5
"$APP_DIR/show-url.sh" || true

# Abschlussmeldung
echo -e "\n${GREEN}Installation erfolgreich abgeschlossen!${NC}"
if [ "$USE_FALLBACK" = true ]; then
  echo -e "${YELLOW}Hinweis: Es wird der interne Speicher des Pi verwendet ($FALLBACK_DIR).${NC}"
  echo -e "${YELLOW}Wenn du eine USB-Festplatte anschließt und das Skript erneut ausführst,${NC}"
  echo -e "${YELLOW}wird diese automatisch erkannt und eingerichtet.${NC}"
else
  echo -e "${GREEN}Verwendetes Speichermedium: $MOUNTED_DEVICE (gemountet unter $STORAGE_DIR)${NC}"
fi
echo -e "Du kannst die App-Logs überwachen mit: ${BLUE}sudo journalctl -u pisecurecloud -f${NC}"
echo -e "Viel Spaß mit deiner sicheren PiSecureCloud!"
