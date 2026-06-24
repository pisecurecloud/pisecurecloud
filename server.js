const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Config paths
const CONFIG_DIR = '/var/lib/pisecurecloud';
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SHARES_FILE = path.join(CONFIG_DIR, 'shares.json');

// Memory cache for metadata per user
let metadataCache = {};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup Session
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true if HTTPS, but for local/quick-tunnel, false is fine
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  }
}));

// Serves Static Frontend Files
app.use(express.static(path.join(__dirname, 'public')));

// Multer for Temp Uploads
const tempUploadDir = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(tempUploadDir)) {
  fs.mkdirSync(tempUploadDir, { recursive: true });
}

// Helper: Get Config or null
function getConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error("Fehler beim Lesen der Konfiguration:", e);
    }
  }
  
  // Dev Fallback configuration if running locally on development system
  const devConfigFile = path.join(__dirname, 'config.dev.json');
  if (fs.existsSync(devConfigFile)) {
    try {
      return JSON.parse(fs.readFileSync(devConfigFile, 'utf8'));
    } catch (e) {}
  }
  return null;
}

// Helper: Save Config
function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// Helper: Get Shares or null
function getShares() {
  const filePath = (process.platform === 'win32' || process.env.NODE_ENV === 'development')
    ? path.join(__dirname, 'shares.dev.json')
    : SHARES_FILE;
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.error("Fehler beim Lesen der Freigaben:", e);
    }
  }
  return [];
}

// Helper: Save Shares
function saveShares(shares) {
  const filePath = (process.platform === 'win32' || process.env.NODE_ENV === 'development')
    ? path.join(__dirname, 'shares.dev.json')
    : SHARES_FILE;
  fs.writeFileSync(filePath, JSON.stringify(shares, null, 2), 'utf8');
}

// Cleaner: Löscht abgelaufene Freigaben (Absturzsicherung / Speicherfreigabe)
function cleanExpiredShares() {
  const config = getConfig();
  if (!config || !config.storageDir) return;

  const shares = getShares();
  const now = new Date();
  const activeShares = [];
  const sharesDir = path.join(config.storageDir, 'shares');

  for (const share of shares) {
    if (share.expiresAt && new Date(share.expiresAt) < now) {
      const sharePath = path.join(sharesDir, share.diskPath);
      if (fs.existsSync(sharePath)) {
        try {
          fs.unlinkSync(sharePath);
        } catch (e) {
          console.error('Fehler beim Löschen der abgelaufenen Freigabe-Datei:', e);
        }
      }
      console.log(`Abgelaufene Freigabe automatisch bereinigt: ${share.fileName} (ID: ${share.id})`);
    } else {
      activeShares.push(share);
    }
  }

  if (activeShares.length !== shares.length) {
    saveShares(activeShares);
  }
}

// Clean up temp uploads folder, interrupted re-encryptions and expired shares on start
try {
  // Clean temp uploads
  const tempFiles = fs.readdirSync(tempUploadDir);
  for (const file of tempFiles) {
    fs.unlinkSync(path.join(tempUploadDir, file));
  }
  
  // Clean leftover .new files
  const config = getConfig();
  if (config && config.storageDir && fs.existsSync(config.storageDir)) {
    const items = fs.readdirSync(config.storageDir);
    for (const item of items) {
      const itemPath = path.join(config.storageDir, item);
      if (fs.existsSync(itemPath) && fs.statSync(itemPath).isDirectory() && item.startsWith('user_')) {
        const userFiles = fs.readdirSync(itemPath);
        for (const uf of userFiles) {
          if (uf.endsWith('.new')) {
            fs.unlinkSync(path.join(itemPath, uf));
          }
        }
      }
    }
    // Clean expired shares on startup
    cleanExpiredShares();
  }
  console.log('Temporäre Verzeichnisse und Fragmente erfolgreich aufgeräumt.');
} catch (e) {
  console.error('Fehler beim Start-Aufräumen:', e);
}

// Set up cleaner interval (every 10 minutes)
setInterval(cleanExpiredShares, 10 * 60 * 1000);

const upload = multer({ dest: tempUploadDir });

// Offline Mode detection
function isSystemOffline() {
  const flagPath = (process.platform === 'win32' || process.env.NODE_ENV === 'development')
    ? path.join(__dirname, 'offline.flag')
    : path.join(CONFIG_DIR, 'offline.flag');
  return fs.existsSync(flagPath);
}

// Middleware: Offline check
app.use((req, res, next) => {
  const allowedOfflinePaths = ['/api/status', '/api/shutdown', '/api/login'];
  if (isSystemOffline() && req.path.startsWith('/api') && !allowedOfflinePaths.includes(req.path)) {
    return res.status(503).json({ error: 'SYSTEM_OFFLINE', message: 'Die Cloud ist vorübergehend offline.' });
  }
  next();
});

// Crypto Constants
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

// Helper: Deriviere Key aus Passwort (SHA-256)
function deriveKey(password) {
  return crypto.createHash('sha256').update(password).digest();
}

// Helper: Passwort Hashing für Setup/Verifikation
function hashPassword(password, salt) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return hash.toString('hex');
}

// User-spezifischer Speicherpfad (Unterordner auf der externen Festplatte)
function getUserStorageDir(storageDir, username) {
  const safeUsername = username.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const userDir = path.join(storageDir, `user_${safeUsername}`);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

// Metadaten Dateipfad (auf der externen Festplatte) per Benutzer
function getMetadataFilePath(storageDir, username) {
  const safeUsername = username.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return path.join(storageDir, `metadata_${safeUsername}.enc`);
}

// Metadata Encryption/Decryption
function encryptMetadata(data, key) {
  const plaintext = JSON.stringify(data);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptMetadata(buffer, key) {
  try {
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const encrypted = buffer.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (e) {
    throw new Error('Ungültiger Entschlüsselungsschlüssel');
  }
}

// Metadata load/save (mit Absturzsicherung / atomaren Schreibvorgängen)
function loadMetadata(storageDir, username, key) {
  const metaPath = getMetadataFilePath(storageDir, username);
  if (!fs.existsSync(metaPath)) {
    return [];
  }
  const encryptedData = fs.readFileSync(metaPath);
  return decryptMetadata(encryptedData, key);
}

function saveMetadata(username, data, storageDir, key) {
  const metaPath = getMetadataFilePath(storageDir, username);
  const tempPath = metaPath + '.tmp';
  
  const encryptedData = encryptMetadata(data, key);
  
  // 1. In temporäre Datei schreiben
  fs.writeFileSync(tempPath, encryptedData);
  
  // 2. Physisch auf Festplatte schreiben (fsync)
  const fd = fs.openSync(tempPath, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  
  // 3. Atomar umbenennen
  fs.renameSync(tempPath, metaPath);
  
  metadataCache[username.toLowerCase()] = data;
}

// Chunked File Encryption
async function encryptFileChunked(srcPath, destPath, key) {
  const readStream = fs.createReadStream(srcPath);
  const writeStream = fs.createWriteStream(destPath);

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    readStream.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= CHUNK_SIZE) {
        const part = buffer.subarray(0, CHUNK_SIZE);
        buffer = buffer.subarray(CHUNK_SIZE);
        writeChunk(part);
      }
    });

    readStream.on('end', () => {
      if (buffer.length > 0) {
        writeChunk(buffer);
      }
      writeStream.end();
    });

    readStream.on('error', (err) => {
      writeStream.destroy();
      reject(err);
    });

    writeStream.on('finish', resolve);
    writeStream.on('error', (err) => {
      readStream.destroy();
      reject(err);
    });

    function writeChunk(chunk) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(chunk), cipher.final()]);
      const tag = cipher.getAuthTag();

      // Chunk Layout: [4 Bytes Header][12 Bytes IV][16 Bytes Tag][Ciphertext]
      const header = Buffer.alloc(4);
      header.writeUInt32BE(ciphertext.length, 0);

      writeStream.write(header);
      writeStream.write(newIv => {}); // Dummy call to avoid syntax issues if needed, ignored
      writeStream.write(iv);
      writeStream.write(tag);
      writeStream.write(ciphertext);
    }
  });
}

// Re-Encrypt a file chunk-by-chunk (für Passwortänderung & Teilen)
async function reEncryptFile(srcPath, destPath, oldKey, newKey) {
  const fdIn = fs.openSync(srcPath, 'r');
  const writeStream = fs.createWriteStream(destPath);
  const stat = fs.statSync(srcPath);
  const totalSizeOnDisk = stat.size;

  return new Promise((resolve, reject) => {
    let offset = 0;

    writeStream.on('finish', () => {
      fs.closeSync(fdIn);
      resolve();
    });

    writeStream.on('error', (err) => {
      fs.closeSync(fdIn);
      reject(err);
    });

    try {
      while (offset < totalSizeOnDisk) {
        // Read 4-byte header length first
        const headerLenBuf = Buffer.alloc(4);
        fs.readSync(fdIn, headerLenBuf, 0, 4, offset);
        const ciphertextLen = headerLenBuf.readUInt32BE(0);
        
        // Read entire chunk (4 bytes header + 12 bytes IV + 16 bytes Tag + ciphertextLen)
        const chunkDiskSize = 32 + ciphertextLen;
        const chunkBuffer = Buffer.alloc(chunkDiskSize);
        fs.readSync(fdIn, chunkBuffer, 0, chunkDiskSize, offset);

        // Decrypt with oldKey
        const iv = chunkBuffer.subarray(4, 16);
        const tag = chunkBuffer.subarray(16, 32);
        const ciphertext = chunkBuffer.subarray(32);

        const decipher = crypto.createDecipheriv('aes-256-gcm', oldKey, iv);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

        // Encrypt with newKey
        const newIv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', newKey, newIv);
        const newCiphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const newTag = cipher.getAuthTag();

        // Write with newKey
        const newHeader = Buffer.alloc(4);
        newHeader.writeUInt32BE(newCiphertext.length, 0);

        writeStream.write(newHeader);
        writeStream.write(newIv);
        writeStream.write(newTag);
        writeStream.write(newCiphertext);

        offset += chunkDiskSize;
      }
      writeStream.end();
    } catch (err) {
      writeStream.destroy();
      fs.closeSync(fdIn);
      reject(err);
    }
  });
}

// Middleware: Authenticated & Key available
function requireAuth(req, res, next) {
  if (!req.session.userId || !req.session.encryptionKey) {
    return res.status(401).json({ error: 'Nicht angemeldet oder Entschlüsselungsschlüssel fehlt' });
  }
  next();
}

// Middleware: Admin role check
function requireAdmin(req, res, next) {
  const config = getConfig();
  const username = req.session.userId;
  if (!config || !config.users || !config.users[username] || config.users[username].role !== 'admin') {
    return res.status(403).json({ error: 'Diese Aktion erfordert Administratorrechte' });
  }
  next();
}

// --- API ROUTES ---

// 1. App Status
app.get('/api/status', (req, res) => {
  const config = getConfig();
  const offline = isSystemOffline();
  
  if (!config) {
    return res.json({ setupRequired: true, offline, hasAdmin: false });
  }
  
  const users = config.users || {};
  const hasAdmin = Object.keys(users).length > 0;
  
  // Calculate disk space
  const storageDir = config.storageDir;
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  exec(`df -h "${storageDir}"`, (err, stdout) => {
    let size = 'Unbekannt';
    let used = 'Unbekannt';
    let available = 'Unbekannt';
    let percent = '0%';
    
    if (!err) {
      const lines = stdout.trim().split('\n');
      if (lines.length > 1) {
        const parts = lines[1].replace(/\s+/g, ' ').split(' ');
        if (parts.length >= 5) {
          size = parts[1];
          used = parts[2];
          available = parts[3];
          percent = parts[4];
        }
      }
    }
    
    let role = 'user';
    if (req.session && req.session.userId && config.users[req.session.userId]) {
      role = config.users[req.session.userId].role;
    }
    
    res.json({
      setupRequired: !hasAdmin,
      offline,
      hasAdmin,
      storageDir,
      role,
      diskSpace: { size, used, available, percent }
    });
  });
});

// 2. Setup (Erstmalige Einrichtung / Admin erstellen)
app.post('/api/setup', (req, res) => {
  let config = getConfig();
  if (config && config.users && Object.keys(config.users).length > 0) {
    return res.status(400).json({ error: 'System ist bereits eingerichtet' });
  }

  const { username, password, storageDir } = req.body;
  if (!username || !password || !storageDir) {
    return res.status(400).json({ error: 'Benutzername, Passwort und Speicherpfad sind erforderlich' });
  }

  try {
    const cleanUsername = username.toLowerCase().trim();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    
    config = {
      users: {
        [cleanUsername]: {
          passwordHash: hash,
          passwordSalt: salt,
          role: 'admin'
        }
      },
      storageDir: storageDir
    };

    // Ensure storage path exists
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    // Initialize clean metadata database and encrypt it for admin
    const key = deriveKey(password);
    saveMetadata(cleanUsername, [], storageDir, key);

    // Save configurations
    saveConfig(config);

    res.json({ success: true, message: 'Setup erfolgreich abgeschlossen' });
  } catch (e) {
    console.error("Setup Fehler:", e);
    res.status(500).json({ error: 'Setup failed: ' + e.message });
  }
});

// 3. Register (Erstellen eines neuen Accounts)
app.post('/api/register', (req, res) => {
  const config = getConfig();
  if (!config) {
    return res.status(400).json({ error: 'System ist nicht eingerichtet' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort sind erforderlich' });
  }

  const cleanUsername = username.toLowerCase().trim();
  if (config.users && config.users[cleanUsername]) {
    return res.status(400).json({ error: 'Benutzername bereits vergeben' });
  }

  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);

    if (!config.users) config.users = {};
    config.users[cleanUsername] = {
      passwordHash: hash,
      passwordSalt: salt,
      role: 'user'
    };

    // Initialize metadata for the new user
    const key = deriveKey(password);
    saveMetadata(cleanUsername, [], config.storageDir, key);

    // Save updated configuration
    saveConfig(config);

    res.json({ success: true, message: 'Registrierung erfolgreich' });
  } catch (e) {
    console.error("Registrierungs-Fehler:", e);
    res.status(500).json({ error: 'Registrierung fehlgeschlagen: ' + e.message });
  }
});

// 4. Login
app.post('/api/login', (req, res) => {
  const config = getConfig();
  if (!config) {
    return res.status(400).json({ error: 'System ist nicht eingerichtet' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }

  const cleanUsername = username.toLowerCase().trim();
  if (!config.users || !config.users[cleanUsername]) {
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
  }

  const user = config.users[cleanUsername];
  const hash = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) {
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
  }

  try {
    const key = deriveKey(password);
    
    // Verifiziere, ob Metadaten entschlüsselt werden können
    loadMetadata(config.storageDir, cleanUsername, key);

    // Store key in session
    req.session.userId = cleanUsername;
    req.session.encryptionKey = key.toString('hex');
    
    res.json({ success: true, message: 'Erfolgreich angemeldet' });
  } catch (e) {
    console.error("Login Fehler bei Metadaten Entschlüsselung:", e);
    res.status(401).json({ error: 'Entschlüsselung der Metadaten fehlgeschlagen' });
  }
});

// 5. Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Abmeldung fehlgeschlagen' });
    }
    res.json({ success: true, message: 'Erfolgreich abgemeldet' });
  });
});

// 6. Dateien auflisten
app.get('/api/files', requireAuth, (req, res) => {
  const config = getConfig();
  const username = req.session.userId;
  const key = Buffer.from(req.session.encryptionKey, 'hex');
  
  try {
    if (!metadataCache[username]) {
      metadataCache[username] = loadMetadata(config.storageDir, username, key);
    }
    res.json(metadataCache[username]);
  } catch (e) {
    res.status(500).json({ error: 'Fehler beim Laden der Dateiliste: ' + e.message });
  }
});

// 7. Ordner erstellen
app.post('/api/mkdir', requireAuth, (req, res) => {
  const { name, parentId } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Ordnername erforderlich' });
  }

  const config = getConfig();
  const username = req.session.userId;
  const key = Buffer.from(req.session.encryptionKey, 'hex');

  try {
    const metadata = loadMetadata(config.storageDir, username, key);
    
    const newDir = {
      id: crypto.randomUUID(),
      name,
      type: 'dir',
      parentId: parentId || 'root',
      created: new Date().toISOString()
    };

    metadata.push(newDir);
    saveMetadata(username, metadata, config.storageDir, key);
    res.json({ success: true, folder: newDir });
  } catch (e) {
    res.status(500).json({ error: 'Ordner konnte nicht erstellt werden: ' + e.message });
  }
});

// 8. Datei hochladen
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Keine Datei hochgeladen' });
  }

  const { parentId } = req.body;
  const config = getConfig();
  const username = req.session.userId;
  const key = Buffer.from(req.session.encryptionKey, 'hex');

  const fileId = crypto.randomUUID();
  const encryptedFileName = fileId + '.enc';
  
  const userStorageDir = getUserStorageDir(config.storageDir, username);
  const destPath = path.join(userStorageDir, encryptedFileName);

  try {
    await encryptFileChunked(req.file.path, destPath, key);
    fs.unlinkSync(req.file.path);

    const metadata = loadMetadata(config.storageDir, username, key);
    const newFile = {
      id: fileId,
      name: req.file.originalname,
      type: 'file',
      parentId: parentId || 'root',
      size: req.file.size,
      mimeType: req.file.mimetype || 'application/octet-stream',
      diskPath: encryptedFileName,
      created: new Date().toISOString()
    };

    metadata.push(newFile);
    saveMetadata(username, metadata, config.storageDir, key);

    res.json({ success: true, file: newFile });
  } catch (e) {
    console.error("Upload/Verschlüsselungs-Fehler:", e);
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Upload failed: ' + e.message });
  }
});

// 9. Datei herunterladen / streamen (mit HTTP Range Request Support)
app.get('/api/download/:id', requireAuth, (req, res) => {
  const fileId = req.params.id;
  const config = getConfig();
  const username = req.session.userId;
  const key = Buffer.from(req.session.encryptionKey, 'hex');

  try {
    const metadata = loadMetadata(config.storageDir, username, key);
    const fileMeta = metadata.find(f => f.id === fileId && f.type === 'file');

    if (!fileMeta) {
      return res.status(404).json({ error: 'Datei nicht gefunden' });
    }

    const userStorageDir = getUserStorageDir(config.storageDir, username);
    const encryptedFilePath = path.join(userStorageDir, fileMeta.diskPath);
    if (!fs.existsSync(encryptedFilePath)) {
      return res.status(404).json({ error: 'Physische Datei auf Speichermedium fehlt' });
    }

    const stat = fs.statSync(encryptedFilePath);
    const encFileSize = stat.size;
    const plainFileSize = fileMeta.size;
    const numChunks = Math.ceil(plainFileSize / CHUNK_SIZE);

    const range = req.headers.range;
    let startPlain = 0;
    let endPlain = plainFileSize - 1;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      startPlain = parseInt(parts[0], 10);
      endPlain = parts[1] ? parseInt(parts[1], 10) : plainFileSize - 1;
      
      if (startPlain >= plainFileSize || endPlain >= plainFileSize) {
        res.setHeader('Content-Range', `bytes */${plainFileSize}`);
        return res.status(416).end();
      }
    }

    const chunkLen = endPlain - startPlain + 1;

    res.setHeader('Content-Type', fileMeta.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${startPlain}-${endPlain}/${plainFileSize}`);
      res.setHeader('Content-Length', chunkLen);
    } else {
      res.status(200);
      res.setHeader('Content-Length', plainFileSize);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileMeta.name)}"`);
    }

    const startChunkIdx = Math.floor(startPlain / CHUNK_SIZE);
    const endChunkIdx = Math.floor(endPlain / CHUNK_SIZE);

    const fd = fs.openSync(encryptedFilePath, 'r');

    for (let c = startChunkIdx; c <= endChunkIdx; c++) {
      const chunkDiskOffset = c * (CHUNK_SIZE + 32);
      
      let chunkEncSize = CHUNK_SIZE + 32;
      if (c === numChunks - 1) {
        chunkEncSize = encFileSize - chunkDiskOffset;
      }

      const chunkBuffer = Buffer.alloc(chunkEncSize);
      fs.readSync(fd, chunkBuffer, 0, chunkEncSize, chunkDiskOffset);

      const iv = chunkBuffer.subarray(4, 16);
      const tag = chunkBuffer.subarray(16, 32);
      const ciphertext = chunkBuffer.subarray(32);

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      const chunkStartPlain = c * CHUNK_SIZE;

      const sliceStart = Math.max(0, startPlain - chunkStartPlain);
      const sliceEnd = Math.min(decrypted.length, endPlain - chunkStartPlain + 1);
      const dataToSend = decrypted.subarray(sliceStart, sliceEnd);

      res.write(dataToSend);
    }

    fs.closeSync(fd);
    res.end();
  } catch (e) {
    console.error("Download/Decryption Fehler:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Herunterladen oder Entschlüsseln fehlgeschlagen' });
    }
  }
});

// 10. Datei/Ordner löschen
app.delete('/api/files/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const config = getConfig();
  const username = req.session.userId;
  const key = Buffer.from(req.session.encryptionKey, 'hex');

  try {
    const metadata = loadMetadata(config.storageDir, username, key);
    const item = metadata.find(i => i.id === id);

    if (!item) {
      return res.status(404).json({ error: 'Element nicht gefunden' });
    }

    function getAllChildrenIds(parentId) {
      let ids = [];
      const children = metadata.filter(i => i.parentId === parentId);
      for (const child of children) {
        ids.push(child);
        if (child.type === 'dir') {
          ids = ids.concat(getAllChildrenIds(child.id));
        }
      }
      return ids;
    }

    let itemsToDelete = [item];
    if (item.type === 'dir') {
      itemsToDelete = itemsToDelete.concat(getAllChildrenIds(item.id));
    }

    const idsToDelete = itemsToDelete.map(i => i.id);
    const newMetadata = metadata.filter(i => !idsToDelete.includes(i.id));
    
    const userStorageDir = getUserStorageDir(config.storageDir, username);

    for (const itemToDelete of itemsToDelete) {
      if (itemToDelete.type === 'file') {
        const encryptedFilePath = path.join(userStorageDir, itemToDelete.diskPath);
        if (fs.existsSync(encryptedFilePath)) {
          fs.unlinkSync(encryptedFilePath);
        }
      }
    }

    saveMetadata(username, newMetadata, config.storageDir, key);
    res.json({ success: true, message: 'Elemente erfolgreich gelöscht' });
  } catch (e) {
    res.status(500).json({ error: 'Löschen fehlgeschlagen: ' + e.message });
  }
});

// 11. Shutdown API (Erlaubt Admin, das Pi herunterzufahren)
app.post('/api/shutdown', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }

  const config = getConfig();
  if (!config || !config.users) {
    return res.status(400).json({ error: 'System nicht eingerichtet' });
  }

  const cleanUsername = username.toLowerCase().trim();
  const user = config.users[cleanUsername];
  if (!user || user.role !== 'admin') {
    return res.status(401).json({ error: 'Nur Administratoren dürfen das System herunterfahren' });
  }

  const hash = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) {
    return res.status(401).json({ error: 'Ungültiges Passwort' });
  }

  res.json({ success: true, message: 'Raspberry Pi wird heruntergefahren...' });

  setTimeout(() => {
    if (process.platform === 'win32' || process.env.NODE_ENV === 'development') {
      console.log('[DEV] SIMULIERTER SHUTDOWN: shutdown -h now');
      process.exit(0);
    } else {
      console.log('System-Shutdown wird ausgeführt...');
      exec('sudo shutdown -h now', (err) => {
        if (err) console.error('Shutdown fehlgeschlagen:', err);
      });
    }
  }, 1500);
});

// --- SETTINGS & ADMIN MANAGEMENT ROUTES ---

// 12. Passwort ändern (Passwort-ändern-Funktion mit vollständiger Re-Verschlüsselung)
app.post('/api/settings/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Altes und neues Passwort erforderlich' });
  }

  const config = getConfig();
  const username = req.session.userId;
  const user = config.users[username];

  const oldHash = hashPassword(oldPassword, user.passwordSalt);
  if (oldHash !== user.passwordHash) {
    return res.status(400).json({ error: 'Das alte Passwort ist nicht korrekt.' });
  }

  const oldKey = deriveKey(oldPassword);
  const newKey = deriveKey(newPassword);

  try {
    const metadata = loadMetadata(config.storageDir, username, oldKey);
    const files = metadata.filter(item => item.type === 'file');
    const userStorageDir = getUserStorageDir(config.storageDir, username);

    const processedFiles = [];
    for (const file of files) {
      const srcPath = path.join(userStorageDir, file.diskPath);
      const destPath = srcPath + '.new';

      if (fs.existsSync(srcPath)) {
        await reEncryptFile(srcPath, destPath, oldKey, newKey);
        processedFiles.push({ srcPath, destPath });
      }
    }

    saveMetadata(username, metadata, config.storageDir, newKey);

    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = hashPassword(newPassword, newSalt);

    config.users[username].passwordHash = newHash;
    config.users[username].passwordSalt = newSalt;
    saveConfig(config);

    for (const pf of processedFiles) {
      fs.renameSync(pf.destPath, pf.srcPath);
    }

    req.session.encryptionKey = newKey.toString('hex');

    res.json({ success: true, message: 'Passwort erfolgreich geändert und alle Dateien neu verschlüsselt.' });
  } catch (e) {
    console.error("Passwortänderung / Re-Verschlüsselungs-Fehler:", e);
    
    try {
      const userStorageDir = getUserStorageDir(config.storageDir, username);
      const files = fs.readdirSync(userStorageDir);
      for (const f of files) {
        if (f.endsWith('.new')) {
          fs.unlinkSync(path.join(userStorageDir, f));
        }
      }
    } catch (e2) {}

    res.status(500).json({ error: 'Re-Verschlüsselung der Dateien fehlgeschlagen: ' + e.message });
  }
});

// 13. Alle Benutzer auflisten (nur für Admins)
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const config = getConfig();
  if (!config || !config.users) {
    return res.json([]);
  }

  const usersList = Object.keys(config.users).map(username => {
    return {
      username: username,
      role: config.users[username].role
    };
  });

  res.json(usersList);
});

// 14. Benutzerrolle ändern (nur für Admins)
app.post('/api/admin/users/role', requireAuth, requireAdmin, (req, res) => {
  const { username, role } = req.body;
  if (!username || !role) {
    return res.status(400).json({ error: 'Benutzername und Rolle sind erforderlich' });
  }

  if (role !== 'admin' && role !== 'user') {
    return res.status(400).json({ error: 'Ungültige Rolle' });
  }

  const targetUser = username.toLowerCase().trim();
  const currentAdmin = req.session.userId;

  if (targetUser === currentAdmin) {
    return res.status(400).json({ error: 'Du kannst deine eigene Administratorrolle nicht entziehen.' });
  }

  const config = getConfig();
  if (!config || !config.users || !config.users[targetUser]) {
    return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  }

  config.users[targetUser].role = role;
  saveConfig(config);

  res.json({ success: true, message: `Rolle von ${username} erfolgreich auf ${role} geändert.` });
});

// 15. Benutzer löschen samt aller seiner Dateien (nur für Admins)
app.delete('/api/admin/users/:username', requireAuth, requireAdmin, (req, res) => {
  const targetUser = req.params.username.toLowerCase().trim();
  const currentAdmin = req.session.userId;

  if (targetUser === currentAdmin) {
    return res.status(400).json({ error: 'Du kannst deinen eigenen Account nicht löschen.' });
  }

  const config = getConfig();
  if (!config || !config.users || !config.users[targetUser]) {
    return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  }

  try {
    const userDir = getUserStorageDir(config.storageDir, targetUser);
    if (fs.existsSync(userDir)) {
      fs.rmSync(userDir, { recursive: true, force: true });
    }

    const metaPath = getMetadataFilePath(config.storageDir, targetUser);
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }

    delete config.users[targetUser];
    saveConfig(config);

    delete metadataCache[targetUser];

    // Lösche auch alle Freigaben dieses Nutzers
    const shares = getShares();
    const activeShares = [];
    const sharesDir = path.join(config.storageDir, 'shares');
    if (!fs.existsSync(sharesDir)) {
      fs.mkdirSync(sharesDir, { recursive: true });
    }

    for (const share of shares) {
      if (share.owner === targetUser) {
        const sharePath = path.join(sharesDir, share.diskPath);
        if (fs.existsSync(sharePath)) {
          fs.unlinkSync(sharePath);
        }
      } else {
        activeShares.push(share);
      }
    }
    saveShares(activeShares);

    res.json({ success: true, message: `Benutzer ${targetUser} und alle seine Dateien wurden gelöscht.` });
  } catch (e) {
    console.error("Benutzer-Lösch-Fehler:", e);
    res.status(500).json({ error: 'Löschen fehlgeschlagen: ' + e.message });
  }
});

// --- SHARING FUNCTIONALITY API ROUTES ---

// 16. Datei freigeben / teilen
app.post('/api/shares', requireAuth, async (req, res) => {
  const { fileId, duration } = req.body;
  if (!fileId || !duration) {
    return res.status(400).json({ error: 'Datei-ID und Gültigkeitsdauer erforderlich' });
  }

  const config = getConfig();
  const username = req.session.userId;
  const sessionKey = Buffer.from(req.session.encryptionKey, 'hex');

  try {
    const metadata = loadMetadata(config.storageDir, username, sessionKey);
    const fileMeta = metadata.find(f => f.id === fileId && f.type === 'file');

    if (!fileMeta) {
      return res.status(404).json({ error: 'Datei nicht gefunden' });
    }

    // 1. Berechne Ablaufdatum
    let expiresAt = null;
    if (duration === '1d') {
      expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    } else if (duration === '7d') {
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    } // 'permanent' -> null

    // 2. Shares-Ordner erstellen
    const sharesDir = path.join(config.storageDir, 'shares');
    if (!fs.existsSync(sharesDir)) {
      fs.mkdirSync(sharesDir, { recursive: true });
    }

    const shareId = crypto.randomUUID();
    const shareKey = crypto.randomBytes(32); // Zufälliger 256-bit Key für diese Freigabe
    const encryptedShareFileName = `${shareId}.enc`;
    
    const userStorageDir = getUserStorageDir(config.storageDir, username);
    const srcPath = path.join(userStorageDir, fileMeta.diskPath);
    const destPath = path.join(sharesDir, encryptedShareFileName);

    // 3. Re-verschlüssele die Datei von dem User-Session-Key auf den Share-Key
    await reEncryptFile(srcPath, destPath, sessionKey, shareKey);

    // 4. Speicher in shares.json
    const shares = getShares();
    const newShare = {
      id: shareId,
      fileName: fileMeta.name,
      mimeType: fileMeta.mimeType,
      size: fileMeta.size,
      expiresAt: expiresAt,
      owner: username,
      diskPath: encryptedShareFileName,
      created: new Date().toISOString()
    };
    shares.push(newShare);
    saveShares(shares);

    res.json({
      success: true,
      shareId: shareId,
      shareKey: shareKey.toString('hex')
    });
  } catch (e) {
    console.error("Fehler beim Erstellen der Freigabe:", e);
    res.status(500).json({ error: 'Freigabe konnte nicht erstellt werden: ' + e.message });
  }
});

// 17. Eigene Freigaben auflisten
app.get('/api/shares', requireAuth, (req, res) => {
  const username = req.session.userId;
  const shares = getShares();
  const userShares = shares.filter(s => s.owner === username);
  res.json(userShares);
});

// 18. Freigabe löschen / deaktivieren (vorzeitig)
app.delete('/api/shares/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const username = req.session.userId;
  const config = getConfig();

  const shares = getShares();
  const share = shares.find(s => s.id === id);

  if (!share) {
    return res.status(404).json({ error: 'Freigabe nicht gefunden' });
  }

  // Nur Besitzer oder Admins dürfen löschen
  const isAdmin = config.users[username] && config.users[username].role === 'admin';
  if (share.owner !== username && !isAdmin) {
    return res.status(403).json({ error: 'Keine Berechtigung zum Löschen dieser Freigabe' });
  }

  try {
    // 1. Physische Freigabedatei löschen
    const sharesDir = path.join(config.storageDir, 'shares');
    const sharePath = path.join(sharesDir, share.diskPath);
    if (fs.existsSync(sharePath)) {
      fs.unlinkSync(sharePath);
    }

    // 2. Aus shares.json austragen
    const updatedShares = shares.filter(s => s.id !== id);
    saveShares(updatedShares);

    res.json({ success: true, message: 'Freigabe erfolgreich gelöscht.' });
  } catch (e) {
    console.error("Fehler beim Löschen der Freigabe:", e);
    res.status(500).json({ error: 'Freigabe konnte nicht gelöscht werden: ' + e.message });
  }
});

// 19. Öffentliche Metadaten einer Freigabe abfragen (OHNE Login)
app.get('/api/public/shares/:id', (req, res) => {
  const id = req.params.id;
  const shares = getShares();
  const share = shares.find(s => s.id === id);

  if (!share) {
    return res.status(404).json({ error: 'Freigabe existiert nicht oder wurde gelöscht.' });
  }

  // Prüfe, ob abgelaufen
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return res.status(410).json({ error: 'Dieser Freigabelink ist abgelaufen.' });
  }

  // Gib nur öffentliche Metadaten zurück (kein diskPath, kein Besitzername)
  res.json({
    id: share.id,
    fileName: share.fileName,
    mimeType: share.mimeType,
    size: share.size,
    expiresAt: share.expiresAt
  });
});

// 20. Öffentlicher verschlüsselter Download einer Freigabe (OHNE Login)
app.get('/api/public/download/:id', (req, res) => {
  const id = req.params.id;
  const keyHex = req.query.key;

  if (!keyHex || keyHex.length !== 64) {
    return res.status(400).json({ error: 'Ungültiger oder fehlender Entschlüsselungsschlüssel.' });
  }

  const config = getConfig();
  const shares = getShares();
  const share = shares.find(s => s.id === id);

  if (!share) {
    return res.status(404).json({ error: 'Freigabe existiert nicht.' });
  }

  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return res.status(410).json({ error: 'Freigabe ist abgelaufen.' });
  }

  const sharesDir = path.join(config.storageDir, 'shares');
  const encryptedFilePath = path.join(sharesDir, share.diskPath);

  if (!fs.existsSync(encryptedFilePath)) {
    return res.status(404).json({ error: 'Freigabedatei auf dem Speichermedium fehlt.' });
  }

  try {
    const key = Buffer.from(keyHex, 'hex');
    const stat = fs.statSync(encryptedFilePath);
    const encFileSize = stat.size;
    const plainFileSize = share.size;
    const numChunks = Math.ceil(plainFileSize / CHUNK_SIZE);

    // Range support
    const range = req.headers.range;
    let startPlain = 0;
    let endPlain = plainFileSize - 1;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      startPlain = parseInt(parts[0], 10);
      endPlain = parts[1] ? parseInt(parts[1], 10) : plainFileSize - 1;
      
      if (startPlain >= plainFileSize || endPlain >= plainFileSize) {
        res.setHeader('Content-Range', `bytes */${plainFileSize}`);
        return res.status(416).end();
      }
    }

    const chunkLen = endPlain - startPlain + 1;

    res.setHeader('Content-Type', share.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${startPlain}-${endPlain}/${plainFileSize}`);
      res.setHeader('Content-Length', chunkLen);
    } else {
      res.status(200);
      res.setHeader('Content-Length', plainFileSize);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(share.fileName)}"`);
    }

    const startChunkIdx = Math.floor(startPlain / CHUNK_SIZE);
    const endChunkIdx = Math.floor(endPlain / CHUNK_SIZE);

    const fd = fs.openSync(encryptedFilePath, 'r');

    for (let c = startChunkIdx; c <= endChunkIdx; c++) {
      const chunkDiskOffset = c * (CHUNK_SIZE + 32);
      
      let chunkEncSize = CHUNK_SIZE + 32;
      if (c === numChunks - 1) {
        chunkEncSize = encFileSize - chunkDiskOffset;
      }

      const chunkBuffer = Buffer.alloc(chunkEncSize);
      fs.readSync(fd, chunkBuffer, 0, chunkEncSize, chunkDiskOffset);

      const iv = chunkBuffer.subarray(4, 16);
      const tag = chunkBuffer.subarray(16, 32);
      const ciphertext = chunkBuffer.subarray(32);

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      const chunkStartPlain = c * CHUNK_SIZE;

      const sliceStart = Math.max(0, startPlain - chunkStartPlain);
      const sliceEnd = Math.min(decrypted.length, endPlain - chunkStartPlain + 1);
      const dataToSend = decrypted.subarray(sliceStart, sliceEnd);

      res.write(dataToSend);
    }

    fs.closeSync(fd);
    res.end();
  } catch (e) {
    console.error("Public Download/Decryption Fehler:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Herunterladen oder Entschlüsseln der Freigabe fehlgeschlagen.' });
    }
  }
});

// 21. Route für öffentliche Freigabenseite (HTML)
app.get('/share/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
