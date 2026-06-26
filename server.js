const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { exec } = require('child_process');
const archiver = require('archiver');
const { Readable } = require('stream');
const os = require('os');

const AdmZip = require('adm-zip');
const fsPromises = fs.promises;


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

function getActivityLogPath() {
  return (process.platform === 'win32' || process.env.NODE_ENV === 'development')
    ? path.join(__dirname, 'activity.dev.json')
    : path.join(CONFIG_DIR, 'activity.json');
}

function logActivity(username, action, details = '') {
  try {
    const logPath = getActivityLogPath();
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    let logs = [];
    if (fs.existsSync(logPath)) {
      try {
        logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      } catch (err) {
        console.error("Fehler beim Parsen des Aktivitätsprotokolls:", err);
      }
    }
    
    const newEntry = {
      timestamp: new Date().toISOString(),
      username: username || 'System',
      action: action,
      details: details
    };
    
    logs.unshift(newEntry);
    if (logs.length > 1000) {
      logs = logs.slice(0, 1000);
    }
    
    const tempPath = logPath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(logs, null, 2), 'utf8');
    
    const fd = fs.openSync(tempPath, 'r+');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    
    fs.renameSync(tempPath, logPath);
  } catch (e) {
    console.error("Fehler beim Schreiben des Aktivitätsprotokolls:", e);
  }
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
  const allowedOfflinePaths = ['/api/status', '/api/shutdown', '/api/login', '/api/admin/maintenance'];
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

// Helper: Erstelle einen entschlüsselten Lesestream (on-the-fly) für ZIP-Streaming
function createDecryptedStream(encryptedFilePath, plainFileSize, key) {
  if (plainFileSize === 0) {
    return new Readable({
      read() {
        this.push(null);
      }
    });
  }

  let currentChunkIdx = 0;
  const numChunks = Math.ceil(plainFileSize / CHUNK_SIZE);
  let fd;
  try {
    fd = fs.openSync(encryptedFilePath, 'r');
  } catch (err) {
    return new Readable({
      read() {
        this.destroy(err);
      }
    });
  }

  const stat = fs.statSync(encryptedFilePath);
  const encFileSize = stat.size;

  return new Readable({
    read(size) {
      if (currentChunkIdx >= numChunks) {
        try { fs.closeSync(fd); } catch (e) {}
        this.push(null);
        return;
      }

      try {
        const chunkDiskOffset = currentChunkIdx * (CHUNK_SIZE + 32);
        let chunkEncSize = CHUNK_SIZE + 32;
        if (currentChunkIdx === numChunks - 1) {
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

        this.push(decrypted);
        currentChunkIdx++;
      } catch (err) {
        try { fs.closeSync(fd); } catch (e) {}
        this.destroy(err);
      }
    },
    destroy(err, callback) {
      try { fs.closeSync(fd); } catch (e) {}
      if (callback) callback(err);
    }
  });
}

// Helper: Rekursive Auflistung von Dateien in Ordnern für ZIP-Erstellung
function getFolderFilesRecursive(metadata, folderId, currentRelativePath = '') {
  let files = [];
  const items = metadata.filter(item => item.parentId === folderId);

  for (const item of items) {
    const itemPath = currentRelativePath ? `${currentRelativePath}/${item.name}` : item.name;
    if (item.type === 'dir') {
      files = files.concat(getFolderFilesRecursive(metadata, item.id, itemPath));
    } else {
      files.push({
        metadata: item,
        zipPath: itemPath
      });
    }
  }

  return files;
}

// Helper: Kompiliere Dateiliste für ZIP-Download
function compileZipFileList(metadata, itemIds) {
  let fileList = [];
  
  for (const id of itemIds) {
    const item = metadata.find(i => i.id === id);
    if (!item) continue;
    
    if (item.type === 'dir') {
      const folderFiles = getFolderFilesRecursive(metadata, item.id, item.name);
      fileList = fileList.concat(folderFiles);
    } else {
      fileList.push({
        metadata: item,
        zipPath: item.name
      });
    }
  }
  
  return fileList;
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

function getNotesFilePath(storageDir, username) {
  const safeUsername = username.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return path.join(storageDir, `notes_${safeUsername}.enc`);
}

function saveNotes(username, data, storageDir, key) {
  const notesPath = getNotesFilePath(storageDir, username);
  const tempPath = notesPath + '.tmp';
  
  const encryptedData = encryptMetadata(data, key);
  
  fs.writeFileSync(tempPath, encryptedData);
  
  const fd = fs.openSync(tempPath, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  
  fs.renameSync(tempPath, notesPath);
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

// --- BACKUP HELPER FUNCTIONS ---
function deriveBackupKey(password) {
  return crypto.pbkdf2Sync(password, 'pisecurecloud-backup-salt', 100000, 32, 'sha256').toString('hex');
}

async function encryptFileChunked(srcPath, destPath, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const CHUNK_SIZE = 1024 * 1024; // 1 MB
  let readFd, writeFd;
  try {
    readFd = await fsPromises.open(srcPath, 'r');
    writeFd = await fsPromises.open(destPath, 'w');
    
    const buffer = Buffer.alloc(CHUNK_SIZE);
    let offset = 0;
    while (true) {
      const { bytesRead } = await readFd.read(buffer, 0, CHUNK_SIZE, offset);
      if (bytesRead === 0) break;
      
      const chunk = buffer.subarray(0, bytesRead);
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(chunk), cipher.final()]);
      const tag = cipher.getAuthTag();
      
      const header = Buffer.alloc(4 + 12 + 16);
      header.writeUInt32BE(encrypted.length, 0);
      iv.copy(header, 4);
      tag.copy(header, 4 + 12);
      
      await writeFd.write(header);
      await writeFd.write(encrypted);
      
      offset += bytesRead;
    }
  } finally {
    if (readFd) await readFd.close();
    if (writeFd) await writeFd.close();
  }
}

async function decryptFileChunked(srcPath, destPath, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  let readFd, writeFd;
  try {
    readFd = await fsPromises.open(srcPath, 'r');
    writeFd = await fsPromises.open(destPath, 'w');
    
    let offset = 0;
    const headerBuffer = Buffer.alloc(4 + 12 + 16);
    
    while (true) {
      const { bytesRead: headerBytes } = await readFd.read(headerBuffer, 0, headerBuffer.length, offset);
      if (headerBytes === 0) break; // EOF
      if (headerBytes < headerBuffer.length) {
        throw new Error("Ungültiges Backup-Format: Header unvollständig.");
      }
      
      const encryptedLength = headerBuffer.readUInt32BE(0);
      const iv = headerBuffer.subarray(4, 16);
      const tag = headerBuffer.subarray(16, 32);
      
      offset += headerBuffer.length;
      
      const encryptedBuffer = Buffer.alloc(encryptedLength);
      const { bytesRead: dataBytes } = await readFd.read(encryptedBuffer, 0, encryptedLength, offset);
      if (dataBytes < encryptedLength) {
        throw new Error("Ungültiges Backup-Format: Datenblock unvollständig.");
      }
      
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
      
      await writeFd.write(decrypted);
      offset += encryptedLength;
    }
  } finally {
    if (readFd) await readFd.close();
    if (writeFd) await writeFd.close();
  }
}

function copyFolderRecursiveSync(src, dest) {
  if (!fs.existsSync(src)) return;
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyFolderRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

async function createBackupFile(destFolder, keyHex) {
  const config = getConfig();
  if (!config) throw new Error("Konfiguration konnte nicht geladen werden.");
  const storageDir = config.storageDir;
  if (!storageDir) throw new Error("Speicherverzeichnis (storageDir) ist nicht konfiguriert.");

  // Create temporary zip path
  const tempZipName = `backup_${Date.now()}_temp.zip`;
  const tempZipPath = path.join(tempUploadDir, tempZipName);
  
  // Make sure destFolder exists
  if (!fs.existsSync(destFolder)) {
    fs.mkdirSync(destFolder, { recursive: true });
  }

  // Define backup output filename
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupEncName = `backup_${timestamp}.enc`;
  const backupEncPath = path.join(destFolder, backupEncName);

  const output = fs.createWriteStream(tempZipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    output.on('close', async () => {
      try {
        await encryptFileChunked(tempZipPath, backupEncPath, keyHex);
        fs.unlinkSync(tempZipPath);
        resolve(backupEncName);
      } catch (err) {
        if (fs.existsSync(tempZipPath)) {
          try { fs.unlinkSync(tempZipPath); } catch (_) {}
        }
        reject(err);
      }
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);

    // 1. Add files directly under CONFIG_DIR to "config/" in ZIP
    if (fs.existsSync(CONFIG_DIR)) {
      const files = fs.readdirSync(CONFIG_DIR);
      for (const file of files) {
        const fullPath = path.join(CONFIG_DIR, file);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          if (file.endsWith('.json') || file === 'offline.flag') {
            archive.file(fullPath, { name: `config/${file}` });
          }
        }
      }
    }

    // Include dev configs if running locally
    const devConfigFile = path.join(__dirname, 'config.dev.json');
    if (fs.existsSync(devConfigFile)) {
      archive.file(devConfigFile, { name: 'config/config.dev.json' });
    }
    const devSharesFile = path.join(__dirname, 'shares.dev.json');
    if (fs.existsSync(devSharesFile)) {
      archive.file(devSharesFile, { name: 'config/shares.dev.json' });
    }

    // 2. Add storageDir recursively to "storage/" in ZIP, excluding the destFolder
    const resolvedDestFolder = path.resolve(destFolder);
    
    function addDirectory(currentDir, zipSubDir) {
      if (!fs.existsSync(currentDir)) return;
      const items = fs.readdirSync(currentDir);
      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const resolvedPath = path.resolve(fullPath);
        
        if (resolvedPath === resolvedDestFolder) {
          continue;
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          addDirectory(fullPath, path.join(zipSubDir, item));
        } else if (stat.isFile()) {
          archive.file(fullPath, { name: path.join(zipSubDir, item) });
        }
      }
    }

    addDirectory(storageDir, 'storage');
    archive.finalize();
  });
}

function rotateBackups(destFolder, retentionDays) {
  if (!fs.existsSync(destFolder)) return [];
  const files = fs.readdirSync(destFolder);
  const now = Date.now();
  const deletedFiles = [];
  
  for (const file of files) {
    if (file.startsWith('backup_') && file.endsWith('.enc')) {
      const filePath = path.join(destFolder, file);
      const stat = fs.statSync(filePath);
      const ageMs = now - stat.mtimeMs;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      
      if (ageDays > retentionDays) {
        fs.unlinkSync(filePath);
        deletedFiles.push(file);
      }
    }
  }
  return deletedFiles;
}

async function restoreBackupFile(encFilePath, keyHex) {
  const tempZipPath = path.join(tempUploadDir, `restore_${Date.now()}_temp.zip`);
  const tempExtractDir = path.join(tempUploadDir, `restore_${Date.now()}_extracted`);

  try {
    await decryptFileChunked(encFilePath, tempZipPath, keyHex);
    
    if (!fs.existsSync(tempExtractDir)) {
      fs.mkdirSync(tempExtractDir, { recursive: true });
    }
    
    const zip = new AdmZip(tempZipPath);
    zip.extractAllTo(tempExtractDir, true);

    const extractedConfigDir = path.join(tempExtractDir, 'config');
    const extractedStorageDir = path.join(tempExtractDir, 'storage');
    
    const hasConfig = fs.existsSync(path.join(extractedConfigDir, 'config.json')) ||
                      fs.existsSync(path.join(extractedConfigDir, 'config.dev.json'));
                      
    if (!hasConfig) {
      throw new Error("Ungültiges Backup-Format: Keine Konfigurationsdatei gefunden.");
    }

    if (fs.existsSync(extractedConfigDir)) {
      const configFiles = fs.readdirSync(extractedConfigDir);
      for (const file of configFiles) {
        const srcFile = path.join(extractedConfigDir, file);
        let destFile = file.endsWith('.dev.json') ? path.join(__dirname, file) : path.join(CONFIG_DIR, file);
        
        const parentDir = path.dirname(destFile);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        
        fs.copyFileSync(srcFile, destFile);
      }
    }

    const restoredConfig = getConfig();
    if (!restoredConfig || !restoredConfig.storageDir) {
      throw new Error("Wiederhergestellte Konfiguration ist ungültig.");
    }
    
    const targetStorageDir = restoredConfig.storageDir;
    if (fs.existsSync(extractedStorageDir)) {
      copyFolderRecursiveSync(extractedStorageDir, targetStorageDir);
    }

    try {
      fs.unlinkSync(tempZipPath);
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    } catch (_) {}

    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
      if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true, force: true });
    } catch (_) {}
    throw err;
  }
}

let schedulerInterval = null;
function startBackupScheduler() {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = setInterval(checkAndRunScheduledBackup, 10 * 60 * 1000);
  setTimeout(checkAndRunScheduledBackup, 5000);
}

async function checkAndRunScheduledBackup() {
  try {
    const config = getConfig();
    if (!config || !config.backupSettings || !config.backupSettings.enabled) {
      return;
    }
    
    const settings = config.backupSettings;
    const now = new Date();
    const currentHour = now.getHours();
    
    if (currentHour === (settings.executionHour !== undefined ? parseInt(settings.executionHour) : 2)) {
      const todayStr = now.toISOString().split('T')[0];
      if (settings.lastBackupDate !== todayStr) {
        console.log(`[Backup-Scheduler] Starte automatischen Backup für ${todayStr}...`);
        
        if (!settings.keyHex) {
          console.error("[Backup-Scheduler] Fehler: Kein Backup-Schlüssel in Konfiguration gefunden.");
          return;
        }
        
        const backupFile = await createBackupFile(settings.destFolder || '/var/lib/pisecurecloud/backups', settings.keyHex);
        console.log(`[Backup-Scheduler] Backup erfolgreich erstellt: ${backupFile}`);
        
        const deleted = rotateBackups(settings.destFolder || '/var/lib/pisecurecloud/backups', settings.retentionDays || 7);
        if (deleted.length > 0) {
          console.log(`[Backup-Scheduler] Veraltete Backups gelöscht: ${deleted.join(', ')}`);
        }
        
        const updatedConfig = getConfig();
        if (updatedConfig && updatedConfig.backupSettings) {
          updatedConfig.backupSettings.lastBackupDate = todayStr;
          saveConfig(updatedConfig);
        }
      }
    }
  } catch (err) {
    console.error("[Backup-Scheduler] Fehler im automatischen Backup:", err);
  }
}

// --- BACKUP API ROUTES ---

// 1. Get Backup Settings
app.get('/api/admin/backup/settings', requireAuth, requireAdmin, (req, res) => {
  const config = getConfig();
  const settings = (config && config.backupSettings) || {};
  res.json({
    enabled: settings.enabled || false,
    destFolder: settings.destFolder || '/var/lib/pisecurecloud/backups',
    retentionDays: settings.retentionDays || 7,
    executionHour: settings.executionHour !== undefined ? settings.executionHour : 2,
    hasPassword: !!settings.keyHex
  });
});

// 2. Save Backup Settings
app.post('/api/admin/backup/settings', requireAuth, requireAdmin, (req, res) => {
  const { enabled, destFolder, retentionDays, executionHour, masterPassword } = req.body;
  
  if (enabled && !destFolder) {
    return res.status(400).json({ error: 'Zielordner ist erforderlich, wenn Backups aktiviert sind.' });
  }

  const config = getConfig();
  if (!config) {
    return res.status(500).json({ error: 'Konfiguration konnte nicht geladen werden.' });
  }

  if (!config.backupSettings) {
    config.backupSettings = {};
  }

  config.backupSettings.enabled = !!enabled;
  config.backupSettings.destFolder = destFolder || '/var/lib/pisecurecloud/backups';
  config.backupSettings.retentionDays = parseInt(retentionDays) || 7;
  config.backupSettings.executionHour = parseInt(executionHour) !== undefined ? parseInt(executionHour) : 2;

  if (masterPassword) {
    config.backupSettings.keyHex = deriveBackupKey(masterPassword);
  } else if (enabled && !config.backupSettings.keyHex) {
    return res.status(400).json({ error: 'Backup-Master-Passwort ist erforderlich, um Backups zu aktivieren.' });
  }

  saveConfig(config);
  logActivity(req.session.userId, 'Backup', 'Backup-Einstellungen aktualisiert');
  
  // Restart scheduler to pick up new config
  startBackupScheduler();

  res.json({ success: true, message: 'Backup-Einstellungen erfolgreich gespeichert.' });
});

// 3. Trigger manual backup
app.post('/api/admin/backup/run', requireAuth, requireAdmin, async (req, res) => {
  const config = getConfig();
  const settings = config && config.backupSettings;
  if (!settings || !settings.keyHex) {
    return res.status(400).json({ error: 'Backup ist nicht konfiguriert oder Passwort fehlt.' });
  }

  try {
    logActivity(req.session.userId, 'Backup', 'Manuelles Backup gestartet');
    const backupFile = await createBackupFile(settings.destFolder, settings.keyHex);
    
    // Rotate old backups
    const deleted = rotateBackups(settings.destFolder, settings.retentionDays);
    
    logActivity(req.session.userId, 'Backup', `Manuelles Backup erfolgreich erstellt: ${backupFile}`);
    res.json({
      success: true,
      message: 'Backup erfolgreich erstellt.',
      filename: backupFile,
      rotated: deleted
    });
  } catch (err) {
    console.error("Fehler beim manuellen Backup:", err);
    res.status(500).json({ error: 'Backup-Erstellung fehlgeschlagen: ' + err.message });
  }
});

// 4. List backup files
app.get('/api/admin/backup/list', requireAuth, requireAdmin, (req, res) => {
  const config = getConfig();
  const settings = config && config.backupSettings;
  const destFolder = (settings && settings.destFolder) || '/var/lib/pisecurecloud/backups';

  if (!fs.existsSync(destFolder)) {
    return res.json([]);
  }

  try {
    const files = fs.readdirSync(destFolder);
    const backups = [];
    for (const file of files) {
      if (file.startsWith('backup_') && file.endsWith('.enc')) {
        const filePath = path.join(destFolder, file);
        const stat = fs.statSync(filePath);
        backups.push({
          filename: file,
          size: stat.size,
          createdAt: stat.mtime
        });
      }
    }
    // Sort descending by date
    backups.sort((a, b) => b.createdAt - a.createdAt);
    res.json(backups);
  } catch (err) {
    console.error("Fehler beim Auflisten der Backups:", err);
    res.status(500).json({ error: 'Fehler beim Auflisten der Backups: ' + err.message });
  }
});

// 5. Delete backup file
app.post('/api/admin/backup/delete', requireAuth, requireAdmin, (req, res) => {
  const { filename } = req.body;
  if (!filename || typeof filename !== 'string' || !filename.startsWith('backup_') || !filename.endsWith('.enc') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Ungültiger Backup-Dateiname.' });
  }

  const config = getConfig();
  const settings = config && config.backupSettings;
  const destFolder = (settings && settings.destFolder) || '/var/lib/pisecurecloud/backups';
  const filePath = path.join(destFolder, filename);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logActivity(req.session.userId, 'Backup', `Backup-Datei gelöscht: ${filename}`);
      res.json({ success: true, message: 'Backup-Datei erfolgreich gelöscht.' });
    } else {
      res.status(404).json({ error: 'Backup-Datei nicht gefunden.' });
    }
  } catch (err) {
    console.error("Fehler beim Löschen des Backups:", err);
    res.status(500).json({ error: 'Fehler beim Löschen des Backups: ' + err.message });
  }
});

// 6. Restore backup
app.post('/api/admin/backup/restore', requireAuth, requireAdmin, async (req, res) => {
  const { filename, password } = req.body;
  if (!filename || !password) {
    return res.status(400).json({ error: 'Dateiname und Passwort erforderlich.' });
  }
  if (typeof filename !== 'string' || !filename.startsWith('backup_') || !filename.endsWith('.enc') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Ungültiger Backup-Dateiname.' });
  }

  const config = getConfig();
  const settings = config && config.backupSettings;
  const destFolder = (settings && settings.destFolder) || '/var/lib/pisecurecloud/backups';
  const filePath = path.join(destFolder, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Backup-Datei nicht gefunden.' });
  }

  try {
    logActivity(req.session.userId, 'Backup', `Backup-Wiederherstellung gestartet für ${filename}`);
    const keyHex = deriveBackupKey(password);
    
    // Attempt restore
    await restoreBackupFile(filePath, keyHex);
    
    logActivity(req.session.userId, 'Backup', `Backup-Wiederherstellung erfolgreich abgeschlossen: ${filename}`);
    
    // Respond to user that restore succeeded and system will restart
    res.json({ success: true, message: 'System erfolgreich wiederhergestellt. Der Server startet jetzt neu...' });

    // Schedule restart
    setTimeout(() => {
      if (process.platform === 'win32') {
        console.log("[Backup-System] Simuliere Service-Neustart auf Windows (Beende Prozess)...");
        process.exit(0);
      } else {
        console.log("[Backup-System] Führe systemd-run aus, um Dienst neu zu starten...");
        exec('systemd-run --on-active=1s systemctl restart pisecurecloud.service', (err) => {
          if (err) {
            console.error("[Backup-System] Fehler bei systemd-run restart, versuche direkten restart:", err);
            exec('systemctl restart pisecurecloud.service');
          }
        });
      }
    }, 1000);

  } catch (err) {
    console.error("Fehler bei Backup-Wiederherstellung:", err);
    res.status(400).json({ error: 'Wiederherstellung fehlgeschlagen. Falsches Passwort oder beschädigtes Backup.' });
  }
});

// Download customized WebDAV Local Proxy Script
app.get('/api/download-webdav-proxy', (req, res) => {
  const config = getConfig();
  if (!config || !config.bucketId) {
    return res.status(400).send('System ist noch nicht eingerichtet oder Bucket-ID fehlt.');
  }

  const scriptContent = `// PiSecureCloud WebDAV Local Proxy
const http = require('http');
const https = require('https');

const BUCKET_ID = "${config.bucketId}";
const PORT = 8080;

let currentTargetUrl = "";

function fetchCurrentUrl() {
  return new Promise((resolve, reject) => {
    https.get(\`https://keyvalue.immanuel.co/api/KeyVal/GetValue/\${BUCKET_ID}/url\`, (res) => {
      let data = "";
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json) {
            const url = Buffer.from(json, 'hex').toString('utf8');
            resolve(url);
          } else {
            reject(new Error("Empty value"));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function getTargetUrl(forceRefresh = false) {
  if (!currentTargetUrl || forceRefresh) {
    console.log("[PROXY] Rufe aktuelle Tunnel-URL ab...");
    try {
      currentTargetUrl = await fetchCurrentUrl();
      console.log(\`[PROXY] Aktuelle Tunnel-URL: \${currentTargetUrl}\`);
    } catch (e) {
      console.error("[PROXY] Fehler beim Abrufen der URL:", e.message);
    }
  }
  return currentTargetUrl;
}

const server = http.createServer(async (req, res) => {
  console.log(\`[PROXY] \${req.method} \${req.url}\`);
  
  let targetUrlStr = await getTargetUrl();
  if (!targetUrlStr) {
    res.statusCode = 502;
    res.end("Bad Gateway: Cloud Tunnel-URL konnte nicht ermittelt werden.");
    return;
  }

  function doRequest(retryCount = 0) {
    try {
      const targetUrl = new URL(targetUrlStr);
      const options = {
        hostname: targetUrl.hostname,
        port: 443,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: targetUrl.hostname
        }
      };

      const proxyReq = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });

      proxyReq.on('error', async (err) => {
        console.error(\`[PROXY] Verbindungsfehler (Versuch \${retryCount + 1}):\`, err.message);
        if (retryCount < 2) {
          targetUrlStr = await getTargetUrl(true);
          if (targetUrlStr) {
            doRequest(retryCount + 1);
            return;
          }
        }
        res.statusCode = 502;
        res.end("Bad Gateway: Verbindung zum Cloud-Server fehlgeschlagen.");
      });

      req.pipe(proxyReq);
    } catch (err) {
      console.error("[PROXY] Request Fehler:", err.message);
      res.statusCode = 500;
      res.end("Internal Server Error in Proxy");
    }
  }

  doRequest();
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(\`====================================================\`);
  console.log(\`   PiSecureCloud - Lokaler WebDAV Proxy gestartet\`);
  console.log(\`====================================================\`);
  console.log(\`   Lokaler Port: http://127.0.0.1:\${PORT}\`);
  console.log(\`   Binde dein Netzlaufwerk in Windows Explorer an:\`);
  console.log(\`   http://127.0.0.1:\${PORT}/\`);
  console.log(\`====================================================\`);
  await getTargetUrl();
});
`;

  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Content-Disposition', 'attachment; filename="pisecurecloud-proxy.js"');
  res.send(scriptContent);
});

// --- HARDWARE MONITOR ENGINE & API ---

function getCpuTemp() {
  if (process.platform === 'win32' || process.env.NODE_ENV === 'development') {
    return 42 + Math.random() * 8; // dev mock
  }
  try {
    const tempFile = '/sys/class/thermal/thermal_zone0/temp';
    if (fs.existsSync(tempFile)) {
      const raw = fs.readFileSync(tempFile, 'utf8');
      return parseFloat(raw) / 1000.0;
    }
  } catch (e) {
    console.error("Fehler beim Lesen der CPU-Temperatur:", e);
  }
  return 0;
}

function getAverageCpuTimes() {
  const cpus = os.cpus();
  let totalIdle = 0, totalTick = 0;
  
  if (!cpus || cpus.length === 0) return { idle: 0, total: 0 };
  
  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });
  return { idle: totalIdle / cpus.length, total: totalTick / cpus.length };
}

let lastCpuTimes = getAverageCpuTimes();
let latestCpuLoad = 0;

function updateCpuLoad() {
  const startTimes = lastCpuTimes;
  const endTimes = getAverageCpuTimes();
  
  const idleDifference = endTimes.idle - startTimes.idle;
  const totalDifference = endTimes.total - startTimes.total;
  
  if (totalDifference > 0) {
    const percentage = 100 - (100 * idleDifference / totalDifference);
    latestCpuLoad = Math.max(0, Math.min(100, Math.round(percentage)));
  }
  
  lastCpuTimes = endTimes;
}

// Update CPU load stats every 3 seconds
setInterval(updateCpuLoad, 3000);

function getRamStats() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const percent = Math.round((used / total) * 100);
  return { total, free, used, percent };
}

app.get('/api/admin/hardware/stats', requireAuth, requireAdmin, (req, res) => {
  const cpuTemp = getCpuTemp();
  const ram = getRamStats();
  const config = getConfig();
  const storageDir = config ? config.storageDir : '/var/lib/pisecurecloud/storage';
  
  if (process.platform === 'win32' || process.env.NODE_ENV === 'development') {
    return res.json({
      cpuTemp: parseFloat(cpuTemp.toFixed(1)),
      cpuLoad: latestCpuLoad,
      ram: ram,
      disk: { total: '120G', used: '45G', available: '75G', percent: '38%' },
      uptime: Math.round(os.uptime())
    });
  }

  exec(`df -h "${storageDir}"`, (err, stdout) => {
    let disk = { total: 'Unbekannt', used: 'Unbekannt', available: 'Unbekannt', percent: '0%' };
    if (!err) {
      const lines = stdout.trim().split('\n');
      if (lines.length > 1) {
        const parts = lines[1].replace(/\s+/g, ' ').split(' ');
        if (parts.length >= 5) {
          disk = {
            total: parts[1],
            used: parts[2],
            available: parts[3],
            percent: parts[4]
          };
        }
      }
    }
    
    res.json({
      cpuTemp: parseFloat(cpuTemp.toFixed(1)),
      cpuLoad: latestCpuLoad,
      ram: ram,
      disk: disk,
      uptime: Math.round(os.uptime())
    });
  });
});

// --- WEBDAV BACKEND ROUTER ---

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimes = {
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.zip': 'application/zip',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.xml': 'application/xml'
  };
  return mimes[ext] || 'application/octet-stream';
}

function getAllChildItemsRecursive(metadata, parentId) {
  let items = [];
  const children = metadata.filter(item => item.parentId === parentId);
  for (const child of children) {
    items.push(child);
    if (child.type === 'dir') {
      items = items.concat(getAllChildItemsRecursive(metadata, child.id));
    }
  }
  return items;
}

// Basic Auth Middleware for WebDAV
function requireWebdavAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="PiSecureCloud WebDAV"');
    return res.status(401).send('Authentication required');
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'basic') {
    return res.status(400).send('Invalid Authorization header format');
  }

  const credentials = Buffer.from(parts[1], 'base64').toString('utf-8').split(':');
  if (credentials.length !== 2) {
    return res.status(400).send('Invalid credentials format');
  }

  const [username, password] = credentials;
  const cleanUsername = username.toLowerCase().trim();
  const config = getConfig();

  if (!config || !config.users || !config.users[cleanUsername]) {
    res.setHeader('WWW-Authenticate', 'Basic realm="PiSecureCloud WebDAV"');
    return res.status(401).send('Access denied');
  }

  const user = config.users[cleanUsername];
  const hash = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) {
    res.setHeader('WWW-Authenticate', 'Basic realm="PiSecureCloud WebDAV"');
    return res.status(401).send('Access denied');
  }

  try {
    const key = deriveKey(password);
    loadMetadata(config.storageDir, cleanUsername, key);
    
    req.webdav = {
      username: cleanUsername,
      key: key,
      config: config
    };
    next();
  } catch (e) {
    res.setHeader('WWW-Authenticate', 'Basic realm="PiSecureCloud WebDAV"');
    return res.status(401).send('Access denied');
  }
}

// Helper: Resolve virtual path to item
function resolveWebdavPath(metadata, decodedPath) {
  const parts = decodedPath.split('/').filter(p => p.length > 0);
  if (parts.length === 0) {
    return { id: 'root', name: 'root', type: 'dir', parentId: null, exists: true };
  }
  
  let currentId = 'root';
  let currentItem = null;
  
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const found = metadata.find(item => item.parentId === currentId && item.name === part);
    if (!found) {
      if (i === parts.length - 1) {
        return { parentId: currentId, name: part, exists: false };
      }
      return null; // Parent folder does not exist
    }
    currentId = found.id;
    currentItem = found;
  }
  
  if (currentItem) {
    currentItem.exists = true;
  }
  return currentItem;
}

// Helper: Build absolute WebDAV URL path
function buildWebdavHref(prefix, item, metadata) {
  if (item.id === 'root') return prefix + '/';
  
  const segments = [item.name];
  let current = item;
  while (current.parentId && current.parentId !== 'root') {
    const parent = metadata.find(i => i.id === current.parentId);
    if (!parent) break;
    segments.unshift(parent.name);
    current = parent;
  }
  let href = prefix + '/' + segments.map(s => encodeURIComponent(s)).join('/');
  if (item.type === 'dir' && !href.endsWith('/')) {
    href += '/';
  }
  return href;
}

// Helper: Generate Multi-Status XML for PROPFIND
function generatePropfindXml(prefix, targetItem, children, metadata) {
  let xml = `<?xml version="1.0" encoding="utf-8" ?>\n`;
  xml += `<d:multistatus xmlns:d="DAV:">\n`;
  
  const itemsToRender = [];
  if (targetItem) itemsToRender.push(targetItem);
  if (children) itemsToRender.push(...children);
  
  for (const item of itemsToRender) {
    const isDir = item.type === 'dir' || item.id === 'root';
    const href = buildWebdavHref(prefix, item, metadata);
    const displayName = item.id === 'root' ? 'webdav' : item.name;
    const size = isDir ? 0 : (item.size || 0);
    const dateStr = item.created ? new Date(item.created).toUTCString() : new Date().toUTCString();
    const isoDateStr = item.created ? new Date(item.created).toISOString() : new Date().toISOString();
    const mimeType = isDir ? 'httpd/unix-directory' : getMimeType(item.name);
    
    xml += `  <d:response>\n`;
    xml += `    <d:href>${href}</d:href>\n`;
    xml += `    <d:propstat>\n`;
    xml += `      <d:prop>\n`;
    xml += `        <d:displayname>${escapeXml(displayName)}</d:displayname>\n`;
    if (isDir) {
      xml += `        <d:resourcetype><d:collection/></d:resourcetype>\n`;
    } else {
      xml += `        <d:resourcetype/>\n`;
    }
    xml += `        <d:getcontentlength>${size}</d:getcontentlength>\n`;
    xml += `        <d:getlastmodified>${dateStr}</d:getlastmodified>\n`;
    xml += `        <d:creationdate>${isoDateStr}</d:creationdate>\n`;
    xml += `        <d:getcontenttype>${mimeType}</d:getcontenttype>\n`;
    xml += `      </d:prop>\n`;
    xml += `      <d:status>HTTP/1.1 200 OK</d:status>\n`;
    xml += `    </d:propstat>\n`;
    xml += `  </d:response>\n`;
  }
  
  xml += `</d:multistatus>`;
  return xml;
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

// WebDAV Router Setup
const webdavRouter = express.Router();
webdavRouter.use(requireWebdavAuth);

// OPTIONS method
webdavRouter.options('*', (req, res) => {
  res.setHeader('DAV', '1, 2');
  res.setHeader('MS-Author-Via', 'DAV');
  res.setHeader('Allow', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
  res.status(200).end();
});

// PROPFIND method
webdavRouter.all('*', async (req, res, next) => {
  if (req.method !== 'PROPFIND') return next();
  
  const prefix = req.baseUrl;
  const decodedPath = decodeURIComponent(req.path);
  const { username, key, config } = req.webdav;
  
  try {
    const metadata = loadMetadata(config.storageDir, username, key);
    const targetItem = resolveWebdavPath(metadata, decodedPath);
    
    if (!targetItem) {
      return res.status(404).send('Not Found');
    }
    
    let children = [];
    const depth = req.headers.depth !== undefined ? req.headers.depth : '1';
    
    if (depth === '1' && (targetItem.type === 'dir' || targetItem.id === 'root')) {
      children = metadata.filter(item => item.parentId === targetItem.id);
    }
    
    const xml = generatePropfindXml(prefix, targetItem, children, metadata);
    res.setHeader('Content-Type', 'text/xml; charset="utf-8"');
    res.status(207).send(xml);
  } catch (err) {
    console.error("WebDAV PROPFIND Error:", err);
    res.status(500).send('Internal Server Error');
  }
});

// LOCK method
webdavRouter.all('*', (req, res, next) => {
  if (req.method !== 'LOCK') return next();
  
  const token = 'opaquelocktoken:' + crypto.randomUUID();
  res.setHeader('Lock-Token', `<${token}>`);
  res.setHeader('Content-Type', 'text/xml; charset="utf-8"');
  res.status(200).send(`<?xml version="1.0" encoding="utf-8" ?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>0</D:depth>
      <D:owner>Owner</D:owner>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken>
        <D:href>${token}</D:href>
      </D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`);
});

// UNLOCK method
webdavRouter.all('*', (req, res, next) => {
  if (req.method !== 'UNLOCK') return next();
  res.status(204).end();
});

// PROPPATCH method
webdavRouter.all('*', (req, res, next) => {
  if (req.method !== 'PROPPATCH') return next();
  
  res.setHeader('Content-Type', 'text/xml; charset="utf-8"');
  res.status(207).send(`<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${req.originalUrl}</d:href>
    <d:propstat>
      <d:prop><d:lockdiscovery/></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`);
});

// MKCOL method
webdavRouter.all('*', async (req, res, next) => {
  if (req.method !== 'MKCOL') return next();
  
  const decodedPath = decodeURIComponent(req.path);
  const { username, key, config } = req.webdav;
  
  try {
    const metadata = loadMetadata(config.storageDir, username, key);
    const targetItem = resolveWebdavPath(metadata, decodedPath);
    
    if (targetItem && targetItem.exists) {
      return res.status(405).send('Folder already exists');
    }
    
    if (!targetItem) {
      return res.status(409).send('Conflict: Parent folder not found');
    }
    
    const newDir = {
      id: crypto.randomUUID(),
      name: targetItem.name,
      type: 'dir',
      parentId: targetItem.parentId,
      created: new Date().toISOString()
    };
    
    metadata.push(newDir);
    saveMetadata(username, metadata, config.storageDir, key);
    logActivity(username, 'WebDAV-Ordner-Erstellung', `Ordner '${targetItem.name}' erstellt über WebDAV`);
    res.status(201).end();
  } catch (err) {
    console.error("WebDAV MKCOL Error:", err);
    res.status(500).send('Internal Server Error');
  }
});

// DELETE method
webdavRouter.delete('*', async (req, res) => {
  const decodedPath = decodeURIComponent(req.path);
  const { username, key, config } = req.webdav;
  
  try {
    const metadata = loadMetadata(config.storageDir, username, key);
    const targetItem = resolveWebdavPath(metadata, decodedPath);
    
    if (!targetItem || !targetItem.exists) {
      return res.status(404).send('Not Found');
    }
    
    const userStorageDir = getUserStorageDir(config.storageDir, username);
    
    if (targetItem.type === 'dir') {
      const childItems = getAllChildItemsRecursive(metadata, targetItem.id);
      
      // Delete physical files
      for (const item of childItems) {
        if (item.type === 'file') {
          const filePath = path.join(userStorageDir, item.diskPath);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      }
      
      // Delete metadata entries
      const childIds = childItems.map(c => c.id);
      childIds.push(targetItem.id);
      
      const newMetadata = metadata.filter(item => !childIds.includes(item.id));
      saveMetadata(username, newMetadata, config.storageDir, key);
      
      logActivity(username, 'WebDAV-Löschen', `Verzeichnis '${targetItem.name}' rekursiv gelöscht über WebDAV`);
    } else {
      // Single file delete
      const filePath = path.join(userStorageDir, targetItem.diskPath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      const newMetadata = metadata.filter(item => item.id !== targetItem.id);
      saveMetadata(username, newMetadata, config.storageDir, key);
      
      logActivity(username, 'WebDAV-Löschen', `Datei '${targetItem.name}' gelöscht über WebDAV`);
    }
    
    res.status(204).end();
  } catch (err) {
    console.error("WebDAV DELETE Error:", err);
    res.status(500).send('Internal Server Error');
  }
});

// GET method
webdavRouter.get('*', async (req, res) => {
  const decodedPath = decodeURIComponent(req.path);
  const { username, key, config } = req.webdav;
  
  try {
    const metadata = loadMetadata(config.storageDir, username, key);
    const targetItem = resolveWebdavPath(metadata, decodedPath);
    
    if (!targetItem || !targetItem.exists) {
      return res.status(404).send('Not Found');
    }
    
    if (targetItem.type === 'dir') {
      return res.status(403).send('Directory listing forbidden on WebDAV GET');
    }
    
    const userStorageDir = getUserStorageDir(config.storageDir, username);
    const encryptedFilePath = path.join(userStorageDir, targetItem.diskPath);
    if (!fs.existsSync(encryptedFilePath)) {
      return res.status(404).send('Physical file missing');
    }
    
    // Decrypt and stream file directly
    res.setHeader('Content-Type', targetItem.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', targetItem.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(targetItem.name)}"`);
    
    const plainStream = createDecryptedStream(encryptedFilePath, targetItem.size, key);
    plainStream.pipe(res);
  } catch (err) {
    console.error("WebDAV GET Error:", err);
    res.status(500).send('Internal Server Error');
  }
});

// PUT method (File Upload/Overwrite)
webdavRouter.put('*', async (req, res) => {
  const decodedPath = decodeURIComponent(req.path);
  const { username, key, config } = req.webdav;
  
  // Save stream to a temporary file
  const tempPath = path.join(tempUploadDir, `webdav_put_${crypto.randomUUID()}.tmp`);
  
  try {
    const writeStream = fs.createWriteStream(tempPath);
    await new Promise((resolve, reject) => {
      req.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    const size = fs.statSync(tempPath).size;
    
    const metadata = loadMetadata(config.storageDir, username, key);
    const targetItem = resolveWebdavPath(metadata, decodedPath);
    
    if (!targetItem) {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      return res.status(409).send('Conflict: Parent folder not found');
    }
    
    const userStorageDir = getUserStorageDir(config.storageDir, username);
    let diskPath;
    let fileId;
    let isOverwrite = false;
    
    if (targetItem.exists) {
      if (targetItem.type === 'dir') {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return res.status(405).send('Cannot overwrite directory with file');
      }
      fileId = targetItem.id;
      diskPath = targetItem.diskPath;
      isOverwrite = true;
    } else {
      fileId = crypto.randomUUID();
      diskPath = fileId + '.enc';
    }
    
    const destPath = path.join(userStorageDir, diskPath);
    
    const parentDir = path.dirname(destPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    
    // Encrypt chunked (keyHex = key.toString('hex'))
    await encryptFileChunked(tempPath, destPath, key.toString('hex'));
    fs.unlinkSync(tempPath);
    
    if (isOverwrite) {
      targetItem.size = size;
      targetItem.created = new Date().toISOString();
    } else {
      const mimeType = getMimeType(targetItem.name);
      const newFile = {
        id: fileId,
        name: targetItem.name,
        type: 'file',
        parentId: targetItem.parentId,
        size: size,
        mimeType: mimeType,
        diskPath: diskPath,
        created: new Date().toISOString()
      };
      metadata.push(newFile);
    }
    
    saveMetadata(username, metadata, config.storageDir, key);
    logActivity(username, isOverwrite ? 'WebDAV-Datei-Überschreiben' : 'WebDAV-Datei-Upload', `Datei '${targetItem.name}' ${isOverwrite ? 'überschrieben' : 'hochgeladen'} über WebDAV`);
    
    res.status(isOverwrite ? 204 : 201).end();
  } catch (err) {
    console.error("WebDAV PUT Error:", err);
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
    res.status(500).send('Internal Server Error');
  }
});

// MOVE and COPY methods
webdavRouter.all('*', async (req, res, next) => {
  if (req.method !== 'MOVE' && req.method !== 'COPY') return next();
  
  const isMove = req.method === 'MOVE';
  const prefix = req.baseUrl;
  const srcDecodedPath = decodeURIComponent(req.path);
  const destHeader = req.headers.destination;
  
  if (!destHeader) {
    return res.status(400).send('Missing Destination header');
  }
  
  const { username, key, config } = req.webdav;
  const userStorageDir = getUserStorageDir(config.storageDir, username);
  
  try {
    const destUrl = new URL(destHeader, `${req.protocol}://${req.headers.host}`);
    let destDecodedPath = destUrl.pathname.substring(prefix.length);
    if (!destDecodedPath.startsWith('/')) {
      destDecodedPath = '/' + destDecodedPath;
    }
    destDecodedPath = decodeURIComponent(destDecodedPath);
    
    const metadata = loadMetadata(config.storageDir, username, key);
    const srcItem = resolveWebdavPath(metadata, srcDecodedPath);
    const destItem = resolveWebdavPath(metadata, destDecodedPath);
    
    if (!srcItem || !srcItem.exists) {
      return res.status(404).send('Source Not Found');
    }
    
    if (!destItem) {
      return res.status(409).send('Conflict: Destination parent folder not found');
    }
    
    const overwrite = req.headers.overwrite === 'T';
    if (destItem.exists) {
      if (!overwrite) {
        return res.status(412).send('Precondition Failed: Destination already exists');
      }
      
      if (destItem.type === 'dir') {
        const childItems = getAllChildItemsRecursive(metadata, destItem.id);
        for (const item of childItems) {
          if (item.type === 'file') {
            const filePath = path.join(userStorageDir, item.diskPath);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          }
        }
        const childIds = childItems.map(c => c.id);
        childIds.push(destItem.id);
        const filteredMeta = metadata.filter(item => !childIds.includes(item.id));
        metadata.length = 0;
        metadata.push(...filteredMeta);
      } else {
        const filePath = path.join(userStorageDir, destItem.diskPath);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        const filteredMeta = metadata.filter(item => item.id !== destItem.id);
        metadata.length = 0;
        metadata.push(...filteredMeta);
      }
    }
    
    if (isMove) {
      srcItem.parentId = destItem.parentId;
      srcItem.name = destItem.name;
      
      logActivity(username, 'WebDAV-Verschieben', `'${srcItem.name}' verschoben zu '${destItem.name}' über WebDAV`);
    } else {
      // COPY Operation
      if (srcItem.type === 'dir') {
        const childItems = getAllChildItemsRecursive(metadata, srcItem.id);
        const newTopDirId = crypto.randomUUID();
        
        metadata.push({
          id: newTopDirId,
          name: destItem.name,
          type: 'dir',
          parentId: destItem.parentId,
          created: new Date().toISOString()
        });
        
        const idMap = { [srcItem.id]: newTopDirId };
        
        for (const child of childItems) {
          if (child.type === 'dir') {
            idMap[child.id] = crypto.randomUUID();
          }
        }
        
        for (const child of childItems) {
          const newParentId = idMap[child.parentId] || newTopDirId;
          
          if (child.type === 'dir') {
            metadata.push({
              id: idMap[child.id],
              name: child.name,
              type: 'dir',
              parentId: newParentId,
              created: new Date().toISOString()
            });
          } else {
            const newFileId = crypto.randomUUID();
            const newDiskPath = newFileId + '.enc';
            const oldPath = path.join(userStorageDir, child.diskPath);
            const newPath = path.join(userStorageDir, newDiskPath);
            
            if (fs.existsSync(oldPath)) {
              fs.copyFileSync(oldPath, newPath);
            }
            
            metadata.push({
              id: newFileId,
              name: child.name,
              type: 'file',
              parentId: newParentId,
              size: child.size,
              mimeType: child.mimeType,
              diskPath: newDiskPath,
              created: new Date().toISOString()
            });
          }
        }
      } else {
        const newId = crypto.randomUUID();
        const newDiskPath = newId + '.enc';
        const oldPath = path.join(userStorageDir, srcItem.diskPath);
        const newPath = path.join(userStorageDir, newDiskPath);
        
        if (fs.existsSync(oldPath)) {
          fs.copyFileSync(oldPath, newPath);
        }
        
        metadata.push({
          id: newId,
          name: destItem.name,
          type: 'file',
          parentId: destItem.parentId,
          size: srcItem.size,
          mimeType: srcItem.mimeType,
          diskPath: newDiskPath,
          created: new Date().toISOString()
        });
      }
      
      logActivity(username, 'WebDAV-Kopieren', `'${srcItem.name}' kopiert nach '${destItem.name}' über WebDAV`);
    }
    
    saveMetadata(username, metadata, config.storageDir, key);
    res.status(destItem.exists ? 204 : 201).end();
  } catch (err) {
    console.error(`WebDAV ${isMove ? 'MOVE' : 'COPY'} Error:`, err);
    res.status(500).send('Internal Server Error');
  }
});

app.use('/webdav', webdavRouter);

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

  const sendResponse = (size, used, available, percent) => {
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
      bucketId: config.bucketId,
      githubPagesUrl: config.customPagesUrl || githubPagesUrl,
      diskSpace: { size, used, available, percent }
    });
  };

  if (process.platform === 'win32' || process.env.NODE_ENV === 'development') {
    return sendResponse('120G', '45G', '75G', '38%');
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
    
    sendResponse(size, used, available, percent);
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

    logActivity(cleanUsername, 'Setup', 'System wurde eingerichtet und Admin erstellt');

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

    logActivity(cleanUsername, 'Registrierung', 'Neuer Account registriert');

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
    
    logActivity(cleanUsername, 'Login', 'Erfolgreich angemeldet');

    res.json({ success: true, message: 'Erfolgreich angemeldet' });
  } catch (e) {
    console.error("Login Fehler bei Metadaten Entschlüsselung:", e);
    res.status(401).json({ error: 'Entschlüsselung der Metadaten fehlgeschlagen' });
  }
});

// 5. Logout
app.post('/api/logout', (req, res) => {
  const username = req.session ? req.session.userId : null;
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Abmeldung fehlgeschlagen' });
    }
    if (username) {
      logActivity(username, 'Logout', 'Erfolgreich abgemeldet');
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
    logActivity(username, 'Ordner-Erstellung', `Ordner erstellt mit ID ${newDir.id}`);
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

  const { parentId, relativePath } = req.body;
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

    // Resolve directory hierarchy if relativePath is present (folder upload)
    let targetParentId = parentId || 'root';
    if (relativePath) {
      const parts = relativePath.split('/').filter(p => p.trim() !== '');
      if (parts.length > 1) {
        // Remove the filename itself
        parts.pop();
        
        // Traverse and create directories recursively
        for (const dirName of parts) {
          let dir = metadata.find(item => item.type === 'dir' && item.name === dirName && item.parentId === targetParentId);
          if (!dir) {
            dir = {
              id: crypto.randomUUID(),
              name: dirName,
              type: 'dir',
              parentId: targetParentId,
              created: new Date().toISOString()
            };
            metadata.push(dir);
            logActivity(username, 'Ordnererstellung', `Ordner '${dirName}' automatisch erstellt bei Pfad-Upload`);
          }
          targetParentId = dir.id;
        }
      }
    }

    const newFile = {
      id: fileId,
      name: req.file.originalname,
      type: 'file',
      parentId: targetParentId,
      size: req.file.size,
      mimeType: (req.file.mimetype && req.file.mimetype !== 'application/octet-stream') ? req.file.mimetype : getMimeType(req.file.originalname),
      diskPath: encryptedFileName,
      created: new Date().toISOString()
    };

    metadata.push(newFile);
    saveMetadata(username, metadata, config.storageDir, key);
    logActivity(username, 'Datei-Upload', `Datei hochgeladen mit ID ${fileId} (Größe: ${req.file.size} Bytes)`);

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

    let mimeType = fileMeta.mimeType;
    if (!mimeType || mimeType === 'application/octet-stream') {
      mimeType = getMimeType(fileMeta.name);
    }
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${startPlain}-${endPlain}/${plainFileSize}`);
      res.setHeader('Content-Length', chunkLen);
    } else {
      res.status(200);
      res.setHeader('Content-Length', plainFileSize);
      if (req.query.inline === 'true') {
        // Serve inline, e.g. for previews
      } else {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileMeta.name)}"`);
      }
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

// 9b. ZIP-Download für Ordner oder mehrere Dateien (on-the-fly Entschlüsselung)
app.post('/api/download-zip', requireAuth, (req, res) => {
  const config = getConfig();
  const username = req.session.userId;
  const key = Buffer.from(req.session.encryptionKey, 'hex');

  let ids;
  try {
    ids = JSON.parse(req.body.ids);
  } catch (e) {
    return res.status(400).send('Ungültige Parameter');
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).send('Keine Dateien ausgewählt');
  }

  try {
    const metadata = loadMetadata(config.storageDir, username, key);
    const filesToZip = compileZipFileList(metadata, ids);

    if (filesToZip.length === 0) {
      return res.status(404).send('Keine Dateien zum Herunterladen gefunden');
    }

    let zipName = 'pi-cloud-download.zip';
    if (ids.length === 1) {
      const singleItem = metadata.find(i => i.id === ids[0]);
      if (singleItem) {
        zipName = `${singleItem.name}.zip`;
      }
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => {
      console.error('ZIP archive error:', err);
    });

    archive.pipe(res);

    const userStorageDir = getUserStorageDir(config.storageDir, username);

    for (const item of filesToZip) {
      const encryptedFilePath = path.join(userStorageDir, item.metadata.diskPath);
      if (fs.existsSync(encryptedFilePath)) {
        const fileStream = createDecryptedStream(encryptedFilePath, item.metadata.size, key);
        archive.append(fileStream, { name: item.zipPath });
      }
    }

    archive.finalize();
  } catch (err) {
    console.error('Fehler beim ZIP-Download:', err);
    res.status(500).send('Fehler bei der ZIP-Erstellung: ' + err.message);
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
    logActivity(username, 'Löschvorgang', `${item.type === 'dir' ? 'Ordner' : 'Datei'} mit ID ${id} gelöscht (inkl. ${itemsToDelete.length - 1} Unterelementen)`);
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

    // Re-encrypt notes if they exist
    const notesPath = getNotesFilePath(config.storageDir, username);
    let hasNotes = false;
    let notesData = [];
    if (fs.existsSync(notesPath)) {
      try {
        const encryptedNotes = fs.readFileSync(notesPath);
        notesData = decryptMetadata(encryptedNotes, oldKey);
        hasNotes = true;
      } catch (err) {
        console.error("Fehler beim Entschlüsseln der Notizen während der Passwortänderung:", err);
      }
    }

    const processedFiles = [];
    for (const file of files) {
      const srcPath = path.join(userStorageDir, file.diskPath);
      const destPath = srcPath + '.new';

      if (fs.existsSync(srcPath)) {
        await reEncryptFile(srcPath, destPath, oldKey, newKey);
        processedFiles.push({ srcPath, destPath });
      }
    }

    let notesDestPath = null;
    if (hasNotes) {
      notesDestPath = notesPath + '.new';
      const encryptedNotesNew = encryptMetadata(notesData, newKey);
      fs.writeFileSync(notesDestPath, encryptedNotesNew);
      const fd = fs.openSync(notesDestPath, 'r+');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
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

    if (notesDestPath && fs.existsSync(notesDestPath)) {
      fs.renameSync(notesDestPath, notesPath);
    }

    req.session.encryptionKey = newKey.toString('hex');

    logActivity(username, 'Einstellungen', 'Passwort geändert und Daten neu verschlüsselt');

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

    try {
      const notesPath = getNotesFilePath(config.storageDir, username);
      const notesNewPath = notesPath + '.new';
      if (fs.existsSync(notesNewPath)) {
        fs.unlinkSync(notesNewPath);
      }
    } catch (e3) {}

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

    const notesPath = getNotesFilePath(config.storageDir, targetUser);
    if (fs.existsSync(notesPath)) {
      fs.unlinkSync(notesPath);
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

    logActivity(currentAdmin, 'Benutzerverwaltung', `Benutzer ${targetUser} gelöscht`);

    res.json({ success: true, message: `Benutzer ${targetUser} und alle seine Dateien wurden gelöscht.` });
  } catch (e) {
    console.error("Benutzer-Lösch-Fehler:", e);
    res.status(500).json({ error: 'Löschen fehlgeschlagen: ' + e.message });
  }
});

// 15a. Wartungsmodus per Web-Admin umschalten
app.post('/api/admin/maintenance', requireAuth, requireAdmin, (req, res) => {
  const { offline } = req.body;
  if (offline === undefined) {
    return res.status(400).json({ error: 'Wartungsmodus-Status erforderlich (offline: true/false)' });
  }

  const flagPath = (process.platform === 'win32' || process.env.NODE_ENV === 'development')
    ? path.join(__dirname, 'offline.flag')
    : path.join(CONFIG_DIR, 'offline.flag');

  try {
    const flagDir = path.dirname(flagPath);
    if (!fs.existsSync(flagDir)) {
      fs.mkdirSync(flagDir, { recursive: true });
    }

    if (offline) {
      fs.writeFileSync(flagPath, '');
      console.log("System per Web-Admin OFFLINE geschaltet.");
      logActivity(req.session.userId, 'Wartungsmodus', 'Wartungsmodus aktiviert');
      res.json({ success: true, offline: true, message: 'Wartungsmodus aktiviert. Die Cloud ist jetzt offline.' });
    } else {
      if (fs.existsSync(flagPath)) {
        fs.unlinkSync(flagPath);
      }
      console.log("System per Web-Admin ONLINE geschaltet.");
      logActivity(req.session.userId, 'Wartungsmodus', 'Wartungsmodus deaktiviert');
      res.json({ success: true, offline: false, message: 'Wartungsmodus deaktiviert. Die Cloud is wieder online.' });
    }
  } catch (e) {
    console.error("Fehler beim Ändern des Wartungsmodus:", e);
    res.status(500).json({ error: 'Status des Wartungsmodus konnte nicht geändert werden: ' + e.message });
  }
});

// 15b. System-Update per Web-Admin anstoßen (GitHub Pull + Restart)
app.post('/api/admin/update', requireAuth, requireAdmin, (req, res) => {
  console.log("Web-Admin hat ein System-Update gestartet.");
  
  logActivity(req.session.userId, 'System-Update', 'System-Update über Web-Panel gestartet');

  // Sofort antworten, damit die HTTP-Verbindung nicht abreißt
  res.json({ success: true, message: 'Update gestartet. Das System startet gleich neu...' });

  // Update-Skript mit kurzer Verzögerung im Hintergrund ausführen
  setTimeout(() => {
    const updateCommand = (process.platform === 'win32' || process.env.NODE_ENV === 'development')
      ? 'echo "Simuliere Update auf Windows"'
      : 'sudo /usr/local/bin/pisecurecloud-update';

    exec(updateCommand, (err, stdout, stderr) => {
      if (err) {
        console.error("Fehler beim Web-Update:", err);
        return;
      }
      console.log("Web-Update-Ergebnis:", stdout);
      if (stderr) {
        console.warn("Web-Update-Warnungen:", stderr);
      }
    });
  }, 1000);
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

    logActivity(username, 'Freigabe-Erstellung', `Freigabelink erstellt für Datei-ID ${fileId} (Share-ID: ${shareId})`);

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

    logActivity(username, 'Freigabe-Löschung', `Freigabelink für Share-ID ${id} gelöscht`);

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

    let mimeType = share.mimeType;
    if (!mimeType || mimeType === 'application/octet-stream') {
      mimeType = getMimeType(share.fileName);
    }
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${startPlain}-${endPlain}/${plainFileSize}`);
      res.setHeader('Content-Length', chunkLen);
    } else {
      res.status(200);
      res.setHeader('Content-Length', plainFileSize);
      if (req.query.inline === 'true') {
        // Serve inline, e.g. for previews
      } else {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(share.fileName)}"`);
      }
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

// 22. Verschlüsselte Notizen laden
app.get('/api/notes', requireAuth, (req, res) => {
  const config = getConfig();
  const username = req.session.userId;
  
  if (!req.session.encryptionKey) {
    return res.status(401).json({ error: 'Entschlüsselungsschlüssel nicht in Sitzung vorhanden' });
  }
  
  const key = Buffer.from(req.session.encryptionKey, 'hex');
  
  try {
    const notesPath = getNotesFilePath(config.storageDir, username);
    if (!fs.existsSync(notesPath)) {
      return res.json([]);
    }
    const encryptedData = fs.readFileSync(notesPath);
    const notes = decryptMetadata(encryptedData, key);
    res.json(notes);
  } catch (e) {
    console.error("Fehler beim Laden/Entschlüsseln der Notizen:", e);
    res.status(500).json({ error: 'Notizen konnten nicht geladen oder entschlüsselt werden' });
  }
});

// 23. Verschlüsselte Notizen speichern
app.post('/api/notes', requireAuth, (req, res) => {
  const notes = req.body;
  if (!Array.isArray(notes)) {
    return res.status(400).json({ error: 'Notizen müssen als Array übergeben werden' });
  }
  
  const config = getConfig();
  const username = req.session.userId;
  
  if (!req.session.encryptionKey) {
    return res.status(401).json({ error: 'Entschlüsselungsschlüssel nicht in Sitzung vorhanden' });
  }
  
  const key = Buffer.from(req.session.encryptionKey, 'hex');
  
  try {
    saveNotes(username, notes, config.storageDir, key);
    res.json({ success: true, message: 'Notizen erfolgreich gespeichert' });
  } catch (e) {
    console.error("Fehler beim Speichern der Notizen:", e);
    res.status(500).json({ error: 'Notizen konnten nicht gespeichert werden: ' + e.message });
  }
});

// 24. Aktivitätsprotokoll abfragen (nur für Admins)
app.get('/api/admin/activity', requireAuth, requireAdmin, (req, res) => {
  try {
    const logPath = getActivityLogPath();
    if (!fs.existsSync(logPath)) {
      return res.json([]);
    }
    const logs = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    // Die letzten 100 Einträge zurückgeben
    res.json(logs.slice(0, 100));
  } catch (e) {
    console.error("Fehler beim Abrufen des Aktivitätsprotokolls:", e);
    res.status(500).json({ error: 'Aktivitätsprotokoll konnte nicht geladen werden' });
  }
});

// 25. Desktop-Verknüpfung herunterladen
app.get('/api/download-shortcut', (req, res) => {
  const config = getConfig();
  if (!config || !config.bucketId) {
    return res.status(400).send('System nicht eingerichtet');
  }

  const htmlContent = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PiSecureCloud - Quick Login</title>
  <style>
    :root {
      --bg-primary: #0a0b10;
      --bg-secondary: #131520;
      --bg-glass: rgba(25, 28, 45, 0.45);
      --border-glass: rgba(255, 255, 255, 0.08);
      --accent-primary: #6366f1;
      --accent-secondary: #06b6d4;
      --accent-gradient: linear-gradient(135deg, #6366f1 0%, #06b6d4 100%);
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --danger: #ef4444;
      --success: #10b981;
      --radius-md: 12px;
      --radius-sm: 8px;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background-color: var(--bg-primary);
      color: var(--text-main);
      font-family: system-ui, -apple-system, sans-serif;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.15) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(6, 118, 212, 0.15) 0%, transparent 40%);
      background-attachment: fixed;
    }
    
    .glass-card {
      background: var(--bg-glass);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--border-glass);
      border-radius: var(--radius-md);
      box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
    }
    
    .login-container {
      width: 100%;
      max-width: 450px;
      padding: 40px;
      animation: floatIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    
    @keyframes floatIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    .logo-container {
      display: flex;
      justify-content: center;
      margin-bottom: 24px;
    }
    
    .form-group {
      margin-bottom: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      text-align: left;
    }
    
    .form-group label {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-muted);
    }
    
    .form-control {
      width: 100%;
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-glass);
      border-radius: var(--radius-sm);
      color: #fff;
      font-family: inherit;
      font-size: 15px;
      transition: 0.2s;
    }
    
    .form-control:focus {
      outline: none;
      border-color: var(--accent-primary);
      background: rgba(255, 255, 255, 0.05);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }
    
    .btn-primary {
      width: 100%;
      padding: 12px 24px;
      background: var(--accent-gradient);
      border: none;
      border-radius: var(--radius-sm);
      color: #fff;
      font-family: inherit;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: 0.2s;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2);
    }
    
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(99, 102, 241, 0.3);
    }
    
    .btn-secondary {
      padding: 10px 20px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-glass);
      border-radius: var(--radius-sm);
      color: var(--text-main);
      font-family: inherit;
      font-size: 14px;
      cursor: pointer;
      transition: 0.2s;
    }
    
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    
    .status-loader {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin: 20px 0;
    }
    
    .spinner {
      border: 4px solid rgba(255, 255, 255, 0.05);
      border-top: 4px solid #6366f1;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin-bottom: 20px;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    .checkbox-group {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 24px;
      cursor: pointer;
      user-select: none;
      text-align: left;
    }
    
    .checkbox-group input {
      width: 18px;
      height: 18px;
      cursor: pointer;
    }
    
    .checkbox-group label {
      font-size: 14px;
      color: var(--text-muted);
      cursor: pointer;
    }
  </style>
</head>
<body>

  <!-- SVGs for Icons -->
  <svg style="display: none;">
    <symbol id="icon-cloud-lock" viewBox="0 0 24 24">
      <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM12 17c-1.1 0-2-.9-2-2v-2c0-1.1.9-2 2-2s2 .9 2 2v2c0 1.1-.9 2-2 2zm1.2-4.2c0-.66-.54-1.2-1.2-1.2s-1.2.54-1.2 1.2v2.4c0 .66.54 1.2 1.2 1.2s1.2-.54 1.2-1.2v-2.4z"/>
    </symbol>
  </svg>

  <div class="login-container glass-card">
    
    <!-- HEADER -->
    <div class="logo-container">
      <svg style="width: 60px; height: 60px; fill: #6366f1;"><use href="#icon-cloud-lock"></use></svg>
    </div>
    <h1 style="font-size: 28px; font-weight: 700; text-align: center; margin-bottom: 8px;">PiSecureCloud</h1>
    <p style="color: var(--text-muted); text-align: center; font-size: 14px; margin-bottom: 32px;">
      Desktop-Verbindungstunnel & Login
    </p>

    <!-- LOADING / REDIRECTING STATE -->
    <div id="loader-state" class="status-loader" style="display: none;">
      <div class="spinner"></div>
      <p id="loader-msg" style="color: var(--text-main); font-size: 15px; font-weight: 500;">
        Verbinde mit Cloud...
      </p>
    </div>

    <!-- LOGIN FORM -->
    <div id="form-state">
      <form id="quick-login-form" onsubmit="handleQuickSubmit(event)">
        
        <div class="form-group">
          <label for="login-username">Benutzername</label>
          <input type="text" id="login-username" class="form-control" placeholder="Benutzername eingeben" required autocomplete="username">
        </div>
        
        <div class="form-group">
          <label for="login-password">Passwort / Entschlüsselungsschlüssel</label>
          <input type="password" id="login-password" class="form-control" placeholder="Passwort eingeben" required autocomplete="current-password">
        </div>

        <div class="checkbox-group" onclick="toggleCheckbox()">
          <input type="checkbox" id="auto-login" onclick="event.stopPropagation()">
          <label for="auto-login">Dauerhaft angemeldet bleiben (Auto-Login)</label>
        </div>

        <button type="submit" class="btn-primary" style="width: 100%;">
          Verbinden & Anmelden
        </button>
      </form>
    </div>

    <!-- ERROR VIEW -->
    <div id="error-state" style="display: none; text-align: center; margin-top: 20px;">
      <p style="color: var(--danger); font-size: 14px; margin-bottom: 16px;" id="error-msg">
        Verbindungsfehler.
      </p>
      <button class="btn-secondary" onclick="resetToForm()" style="padding: 10px 20px;">
        Zurück
      </button>
    </div>

  </div>

  <script>
    // Config from Server
    const BUCKET_ID = "${config.bucketId}";
    const STORAGE_KEY_CREDS = 'psc_autologin_creds';

    // UI elements
    const loaderState = document.getElementById('loader-state');
    const formState = document.getElementById('form-state');
    const errorState = document.getElementById('error-state');
    const loaderMsg = document.getElementById('loader-msg');
    const errorMsg = document.getElementById('error-msg');

    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const autoLoginCheckbox = document.getElementById('auto-login');

    // Init
    function init() {
      // Check for saved credentials
      const savedCreds = localStorage.getItem(STORAGE_KEY_CREDS);
      if (savedCreds) {
        try {
          const creds = JSON.parse(atob(savedCreds));
          if (creds.u && creds.p) {
            performAutoLogin(creds.u, creds.p);
            return;
          }
        } catch (e) {
          localStorage.removeItem(STORAGE_KEY_CREDS);
        }
      }
    }

    function toggleCheckbox() {
      autoLoginCheckbox.checked = !autoLoginCheckbox.checked;
    }

    function showStatus(msg) {
      formState.style.display = 'none';
      errorState.style.display = 'none';
      loaderState.style.display = 'flex';
      loaderMsg.innerText = msg;
    }

    function showError(msg) {
      formState.style.display = 'none';
      loaderState.style.display = 'none';
      errorState.style.display = 'block';
      errorMsg.innerText = msg;
    }

    function resetToForm() {
      loaderState.style.display = 'none';
      errorState.style.display = 'none';
      formState.style.display = 'block';
    }

    function decodeHex(hex) {
      let str = '';
      for (let i = 0; i < hex.length; i += 2) {
        str += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
      }
      return str;
    }

    function performAutoLogin(username, password) {
      showStatus('Rufe aktuelle Cloud-Adresse ab...');

      fetch(\`https://keyvalue.immanuel.co/api/KeyVal/GetValue/\${BUCKET_ID}/url\`)
        .then(res => {
          if (!res.ok) throw new Error("Verbindung zum URL-Server fehlgeschlagen.");
          return res.json();
        })
        .then(hexData => {
          if (!hexData) throw new Error("Cloud-Adresse konnte nicht geladen werden. Ist der Pi online?");
          const cloudUrl = decodeHex(hexData.trim());
          if (cloudUrl.startsWith('https://')) {
            showStatus('Verbinde mit Cloud...');
            
            // Build login hash payload
            const loginPayload = btoa(JSON.stringify({ u: username, p: password }));
            
            // Redirect using location.replace
            window.location.replace(\`\${cloudUrl}/#login=\${loginPayload}\`);
          } else {
            throw new Error("Ungültige Cloud-Adresse: " + cloudUrl);
          }
        })
        .catch(err => {
          showError(err.message || 'Verbindung zum Raspberry Pi fehlgeschlagen. Bitte stelle sicher, dass der Pi läuft.');
        });
    }

    function handleQuickSubmit(e) {
      e.preventDefault();
      
      const user = usernameInput.value.trim();
      const pass = passwordInput.value;

      if (autoLoginCheckbox.checked) {
        const payload = btoa(JSON.stringify({ u: user, p: pass }));
        localStorage.setItem(STORAGE_KEY_CREDS, payload);
      } else {
        localStorage.removeItem(STORAGE_KEY_CREDS);
      }

      performAutoLogin(user, pass);
    }

    window.addEventListener('DOMContentLoaded', init);
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', 'attachment; filename="MeineCloud.html"');
  res.send(htmlContent);
});

// Windows Desktop-App herunterladen
app.get('/api/download-windows-app', (req, res) => {
  const appPath = path.join(__dirname, 'PiSecureCloud.exe');
  if (fs.existsSync(appPath)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="PiSecureCloud.exe"');
    res.sendFile(appPath);
  } else {
    res.status(404).send('Windows-App wurde noch nicht auf dem Server kompiliert.');
  }
});

// Tunnel Log Monitor Function
function startTunnelMonitor() {
  const logPath = (process.platform === 'win32' || process.env.NODE_ENV === 'development')
    ? path.join(__dirname, 'cloudflared-tunnel.log')
    : '/var/log/cloudflared-tunnel.log';

  let lastUrl = '';

  setInterval(() => {
    const config = getConfig();
    if (!config || !config.bucketId) return;

    if (!fs.existsSync(logPath)) return;

    try {
      const logContent = fs.readFileSync(logPath, 'utf8');
      const matches = logContent.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g);
      if (matches && matches.length > 0) {
        const currentUrl = matches[matches.length - 1];
        if (currentUrl !== lastUrl) {
          console.log(`[MONITOR] Neue Tunnel-URL erkannt: ${currentUrl}`);
          
          const https = require('https');
          const hexUrl = Buffer.from(currentUrl).toString('hex');
          
          const req = https.request({
            hostname: 'keyvalue.immanuel.co',
            port: 443,
            path: `/api/KeyVal/UpdateValue/${config.bucketId}/url/${hexUrl}`,
            method: 'POST',
            headers: {
              'Content-Length': '0'
            }
          }, (res) => {
            res.on('data', () => {});
            console.log(`[MONITOR] URL-Tracker-Datenbank aktualisiert. Status: ${res.statusCode}`);
          });
          req.on('error', (e) => {
            console.error('[MONITOR] Fehler beim Senden der URL an KeyValue Store:', e);
          });
          req.end();

          lastUrl = currentUrl;
        }
      }
    } catch (e) {
      console.error('[MONITOR] Fehler beim Lesen der Tunnel-Logdatei:', e);
    }
  }, 10000);
}

// Function to ensure app-key from immanuel.co exists
function getOrGenerateAppKey(callback) {
  const config = getConfig();
  if (config && config.bucketId && !config.bucketId.startsWith('psc_')) {
    // We already have a valid Immanuel.co app-key (those don't start with psc_)
    return callback(config.bucketId);
  }
  
  console.log('[MONITOR] Generiere neuen KeyValue App-Key von immanuel.co...');
  const https = require('https');
  https.get('https://keyvalue.immanuel.co/api/KeyVal/GetAppKey', (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const key = JSON.parse(data).trim();
        if (key) {
          config.bucketId = key;
          saveConfig(config);
          console.log(`[MONITOR] Neuen KeyValue-Key generiert: ${key}`);
          callback(key);
        } else {
          callback(null);
        }
      } catch (e) {
        console.error('[MONITOR] Fehler beim Parsen des App-Keys:', e);
        callback(null);
      }
    });
  }).on('error', (e) => {
    console.error('[MONITOR] Fehler beim Abrufen des App-Keys:', e);
    callback(null);
  });
}

let githubPagesUrl = '';
function detectGithubPagesUrl() {
  const gitConfigPaths = [
    '/home/picloud/quick-meitner/.git/config',
    path.join(__dirname, '.git/config')
  ];

  for (const gitConfigPath of gitConfigPaths) {
    if (fs.existsSync(gitConfigPath)) {
      try {
        const configText = fs.readFileSync(gitConfigPath, 'utf8');
        const match = configText.match(/\[remote\s+"origin"\][^]*?url\s*=\s*(.*)/);
        if (match) {
          const remoteUrl = match[1].trim();
          const githubMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^.]+)/);
          if (githubMatch) {
            const username = githubMatch[1].toLowerCase();
            const repo = githubMatch[2].replace(/\.git$/, '').toLowerCase();
            githubPagesUrl = `https://${username}.github.io/${repo}`;
            console.log(`[MONITOR] GitHub Pages URL aus Git-Config erkannt: ${githubPagesUrl}`);
            return;
          }
        }
      } catch (e) {
        console.warn('[MONITOR] Fehler beim Lesen der Git-Config:', e.message);
      }
    }
  }
  console.warn('[MONITOR] GitHub Pages URL konnte nicht aus Git-Config ermittelt werden.');
}

// Start Server
app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);

  // Start automatic backup scheduler
  startBackupScheduler();

  // Auto-detect GitHub Pages URL
  detectGithubPagesUrl();

  // Ensure key value store app-key exists, then start monitor
  getOrGenerateAppKey((key) => {
    if (key) {
      startTunnelMonitor();
    } else {
      console.error('[MONITOR] Monitor konnte mangels App-Key nicht gestartet werden.');
    }
  });
});
