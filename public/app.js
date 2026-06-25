// Application State
let currentFolderId = 'root';
let allFiles = [];
let diskInfo = null;
let currentUsername = '';
let currentUserRole = 'user';
let currentShareFileId = ''; // For sharing dialog
let allNotes = [];
let activeNoteId = null;
let noteHasUnsavedChanges = false;
let appBucketId = '';
let githubPagesUrl = '';

// DOM Elements
const setupScreen = document.getElementById('setup-screen');
const loginScreen = document.getElementById('login-screen');
const registerScreen = document.getElementById('register-screen');
const offlineScreen = document.getElementById('offline-screen');
const dashboard = document.getElementById('dashboard');
const fileGrid = document.getElementById('file-grid');
const breadcrumbsList = document.getElementById('breadcrumbs');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const uploadPanel = document.getElementById('upload-panel');
const uploadList = document.getElementById('upload-list');
const uploadCount = document.getElementById('upload-panel-count');
const folderDialog = document.getElementById('folder-dialog');
const folderNameInput = document.getElementById('folder-name-input');
const previewModal = document.getElementById('preview-modal');
const previewFilename = document.getElementById('preview-filename');
const previewBody = document.getElementById('preview-body');
const previewDownloadBtn = document.getElementById('preview-download-btn');
const toastContainer = document.getElementById('toast-container');
const usernameDisplay = document.getElementById('username-display');

// Tab Buttons
const tabAdminBtn = document.getElementById('tab-admin-btn');
const userTableBody = document.getElementById('user-table-body');

// Backup Elements
const backupTableBody = document.getElementById('backup-table-body');
const backupEnabledCheckbox = document.getElementById('backup-enabled');
const backupDestFolderInput = document.getElementById('backup-dest-folder');
const backupRetentionInput = document.getElementById('backup-retention');
const backupHourInput = document.getElementById('backup-hour');
const backupMasterPasswordInput = document.getElementById('backup-master-password');
const btnManualBackup = document.getElementById('btn-manual-backup');

// Disk Stats Elements
const diskText = document.getElementById('disk-text');
const diskProgress = document.getElementById('disk-progress');

// Init application on load
window.addEventListener('DOMContentLoaded', () => {
  checkStatus();
});

// Toast Notifications
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = message;
  toastContainer.appendChild(toast);
  
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Format bytes to human readable
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// 1. Check server status (Setup, Offline, or Login required?)
async function checkStatus() {
  // Intercept hash-based auto-login from static helper page or desktop shortcut
  const hash = window.location.hash;
  if (hash && hash.startsWith('#login=')) {
    try {
      const loginPayload = JSON.parse(atob(decodeURIComponent(hash.substring(7))));
      if (loginPayload.u && loginPayload.p) {
        // Clear hash instantly to hide credentials
        history.replaceState("", document.title, window.location.pathname + window.location.search);
        
        const loginRes = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: loginPayload.u, password: loginPayload.p })
        });
        
        if (loginRes.ok) {
          showToast('Automatisch angemeldet');
          sessionStorage.setItem('username', loginPayload.u);
          currentUsername = loginPayload.u;
        } else {
          showToast('Automatisches Login-Verfahren fehlgeschlagen', 'error');
        }
      }
    } catch (err) {
      console.error('Auto-login hash parsing error:', err);
    }
  }

  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    // Priorität 1: Offline-Modus / Wartungsmodus
    if (data.offline) {
      showScreen('offline');
      return;
    }

    // Priorität 2: Erstmalige Einrichtung (keine Nutzer vorhanden)
    if (data.setupRequired) {
      showScreen('setup');
      return;
    }

    // Status vorhanden -> Plattenplatz und Rolle aktualisieren
    diskInfo = data.diskSpace;
    currentUserRole = data.role;
    appBucketId = data.bucketId || '';
    githubPagesUrl = data.githubPagesUrl || '';
    updateDiskUI();

    // Priorität 3: Versuche, Dateiliste zu laden (Prüft, ob Session aktiv ist)
    const filesRes = await fetch('/api/files');
    if (filesRes.status === 200) {
      allFiles = await filesRes.json();
      currentUsername = sessionStorage.getItem('username') || 'Nutzer';
      usernameDisplay.innerText = currentUsername;

      // Zeige/Verberge Admin-Tab
      if (currentUserRole === 'admin') {
        tabAdminBtn.style.display = 'flex';
      } else {
        tabAdminBtn.style.display = 'none';
      }

      showScreen('dashboard');
      switchTab('files'); // Immer mit Dateien starten
      renderExplorer();
    } else {
      showScreen('login');
    }
  } catch (e) {
    showToast('Fehler bei der Verbindung zum Server', 'error');
  }
}

function showScreen(screen) {
  setupScreen.style.display = 'none';
  loginScreen.style.display = 'none';
  registerScreen.style.display = 'none';
  offlineScreen.style.display = 'none';
  dashboard.style.display = 'none';

  if (screen === 'setup') setupScreen.style.display = 'block';
  if (screen === 'login') loginScreen.style.display = 'block';
  if (screen === 'register') registerScreen.style.display = 'block';
  if (screen === 'offline') offlineScreen.style.display = 'block';
  if (screen === 'dashboard') {
    dashboard.style.display = 'flex';
    updateDiskUI();
  }
}

function updateDiskUI() {
  if (diskInfo && diskText && diskProgress) {
    diskText.innerText = `Speicherplatz: ${diskInfo.used} von ${diskInfo.size} belegt (${diskInfo.available} frei)`;
    diskProgress.style.width = diskInfo.percent;
  }
}

// Tab Switching Logik
function switchTab(tabId) {
  if (noteHasUnsavedChanges && !confirm("Ungespeicherte Änderungen an deiner Notiz verwerfen?")) {
    return;
  }
  noteHasUnsavedChanges = false;

  // Deaktiviere alle Tabs und Sektionen
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-section').forEach(sec => sec.classList.remove('active'));
  
  // Aktiviere gewählten Tab und Sektion
  const targetBtn = document.getElementById(`tab-${tabId}-btn`);
  const targetSec = document.getElementById(`section-${tabId}`);
  
  if (targetBtn) targetBtn.classList.add('active');
  if (targetSec) targetSec.classList.add('active');
  
  // Lade spezifische Tab-Daten
  if (tabId === 'files') {
    refreshFileList();
  } else if (tabId === 'admin') {
    loadUsersList();
    loadActivityLog();
    loadBackupSettings();
    loadBackupList();
  } else if (tabId === 'shares') {
    loadSharesList();
  } else if (tabId === 'notes') {
    loadNotesList();
  } else if (tabId === 'settings') {
    updateWebdavUI();
  }
}

// Auth screen toggling
function showRegisterScreen(e) {
  if (e) e.preventDefault();
  showScreen('register');
}

function showLoginScreen(e) {
  if (e) e.preventDefault();
  showScreen('login');
}

// 2. Handle setup form submission (Admin erstellen)
async function handleSetup(e) {
  e.preventDefault();
  const username = document.getElementById('setup-username').value;
  const password = document.getElementById('setup-password').value;
  const confirm = document.getElementById('setup-password-confirm').value;
  const storageDir = document.getElementById('setup-storage-dir').value;

  if (password !== confirm) {
    showToast('Passwörter stimmen nicht überein', 'error');
    return;
  }

  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, storageDir })
    });
    const data = await res.json();
    
    if (res.ok) {
      showToast('Admin-Konto erfolgreich eingerichtet!');
      sessionStorage.setItem('username', username);
      checkStatus();
    } else {
      showToast(data.error || 'Setup fehlgeschlagen', 'error');
    }
  } catch (err) {
    showToast('Verbindungsfehler beim Setup', 'error');
  }
}

// 3. Handle Login
async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (res.ok) {
      showToast('Erfolgreich angemeldet');
      sessionStorage.setItem('username', username);
      currentUsername = username;
      document.getElementById('login-password').value = '';
      checkStatus();
    } else {
      showToast(data.error || 'Anmeldung fehlgeschlagen', 'error');
    }
  } catch (err) {
    showToast('Verbindungsfehler bei der Anmeldung', 'error');
  }
}

// 4. Handle Registration
async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('register-username').value;
  const password = document.getElementById('register-password').value;
  const confirm = document.getElementById('register-password-confirm').value;

  if (password !== confirm) {
    showToast('Passwörter stimmen nicht überein', 'error');
    return;
  }

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (res.ok) {
      showToast('Konto erfolgreich erstellt! Logge dich jetzt ein.');
      showScreen('login');
      document.getElementById('login-username').value = username;
    } else {
      showToast(data.error || 'Registrierung fehlgeschlagen', 'error');
    }
  } catch (err) {
    showToast('Verbindungsfehler bei der Registrierung', 'error');
  }
}

// 5. Handle Logout
async function handleLogout() {
  try {
    const res = await fetch('/api/logout', { method: 'POST' });
    if (res.ok) {
      showToast('Abgemeldet');
      allFiles = [];
      currentFolderId = 'root';
      sessionStorage.removeItem('username');
      showScreen('login');
    }
  } catch (e) {
    showToast('Verbindungsfehler bei der Abmeldung', 'error');
  }
}

// 6. Handle Shutdown (Ausführen des Pi-Herunterfahrens)
async function handleShutdown(e) {
  e.preventDefault();
  const username = document.getElementById('shutdown-username').value;
  const password = document.getElementById('shutdown-password').value;

  if (!confirm('Möchtest du den Raspberry Pi wirklich jetzt ausschalten?')) {
    return;
  }

  try {
    const res = await fetch('/api/shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (res.ok) {
      showToast('Ausschaltbefehl gesendet!', 'success');
      
      offlineScreen.innerHTML = `
        <div class="logo-container" style="background: var(--danger); animation: pulse 2s infinite;">
          <svg><use href="#icon-power"></use></svg>
        </div>
        <h1>System fährt herunter</h1>
        <p class="subtitle" style="margin-top: 16px;">Der Raspberry Pi wird jetzt sicher ausgeschaltet. Das dauert ca. 15-30 Sekunden. Danach kannst du die Festplatte sicher abziehen und die Stromversorgung trennen.</p>
        <p class="subtitle" style="font-size:12px; color: var(--danger);">Du kannst dieses Browserfenster jetzt schließen.</p>
      `;
    } else {
      showToast(data.error || 'Herunterfahren fehlgeschlagen', 'error');
    }
  } catch (err) {
    showToast('Verbindungsfehler oder Server bereits offline.', 'error');
  }
}

// --- PASSWORD CHANGE LOGIC ---

async function handleChangePassword(e) {
  e.preventDefault();
  const oldPassword = document.getElementById('change-old-password').value;
  const newPassword = document.getElementById('change-new-password').value;
  const confirmPassword = document.getElementById('change-new-password-confirm').value;
  const submitBtn = document.getElementById('change-pwd-btn');

  if (newPassword !== confirmPassword) {
    showToast('Neue Passwörter stimmen nicht überein', 'error');
    return;
  }

  if (confirm('Bist du sicher? Alle deine Dateien werden jetzt umverschlüsselt. Bitte schließe den Browser währenddessen nicht!')) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Bitte warten: Dateien werden re-verschlüsselt...';

    try {
      const res = await fetch('/api/settings/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword })
      });
      const data = await res.json();

      if (res.ok) {
        showToast('Passwort erfolgreich geändert und alle Dateien neu verschlüsselt!');
        document.getElementById('change-old-password').value = '';
        document.getElementById('change-new-password').value = '';
        document.getElementById('change-new-password-confirm').value = '';
        switchTab('files');
      } else {
        showToast(data.error || 'Passwortänderung fehlgeschlagen', 'error');
      }
    } catch (err) {
      showToast('Verbindungsfehler bei der Passwortänderung', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerText = 'Passwort ändern & Dateien neu verschlüsseln';
    }
  }
}

// --- ADMIN USER MANAGEMENT LOGIC ---

async function loadUsersList() {
  userTableBody.innerHTML = '<tr><td colspan="3" style="text-align:center; color: var(--text-muted);">Lade Benutzerliste...</td></tr>';
  
  // System-Verwaltung Status laden
  loadSystemStatus();

  try {
    const res = await fetch('/api/admin/users');
    const users = await res.json();

    if (!res.ok) {
      showToast(users.error || 'Fehler beim Laden der Benutzerliste', 'error');
      return;
    }

    userTableBody.innerHTML = '';
    
    users.forEach(user => {
      const isSelf = user.username.toLowerCase() === currentUsername.toLowerCase();
      const tr = document.createElement('tr');
      
      tr.innerHTML = `
        <td style="font-weight: 500;">
          ${user.username} ${isSelf ? '<span style="color: var(--accent-secondary); font-size:11px; margin-left:6px;">(Du)</span>' : ''}
        </td>
        <td>
          <select class="select-role" ${isSelf ? 'disabled' : ''} onchange="changeUserRole('${user.username}', this.value)">
            <option value="user" ${user.role === 'user' ? 'selected' : ''}>Nutzer</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrator</option>
          </select>
        </td>
        <td>
          ${isSelf ? '<span style="color: var(--text-muted); font-size:13px;">Keine Aktionen</span>' : `
            <button class="btn-logout" style="padding: 6px 12px; font-size:12px;" onclick="deleteUserAccount('${user.username}')">
              Konto löschen
            </button>
          `}
        </td>
      `;
      userTableBody.appendChild(tr);
    });
  } catch (err) {
    userTableBody.innerHTML = '<tr><td colspan="3" style="text-align:center; color: var(--danger);">Verbindungsfehler beim Laden der Benutzer.</td></tr>';
  }
}

async function changeUserRole(username, role) {
  try {
    const res = await fetch('/api/admin/users/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, role })
    });
    const data = await res.json();

    if (res.ok) {
      showToast(`Rolle von "${username}" auf "${role}" geändert`);
      loadUsersList();
    } else {
      showToast(data.error || 'Rollenänderung fehlgeschlagen', 'error');
      loadUsersList(); // Zurücksetzen
    }
  } catch (e) {
    showToast('Verbindungsfehler bei Rollenänderung', 'error');
    loadUsersList();
  }
}

async function deleteUserAccount(username) {
  if (!confirm(`WARNUNG: Möchtest du den Account "${username}" wirklich unwiderruflich löschen? Alle seine hochgeladenen Dateien auf der Festplatte werden unwiederbringlich gelöscht!`)) {
    return;
  }

  try {
    const res = await fetch(`/api/admin/users/${username}`, {
      method: 'DELETE'
    });
    const data = await res.json();

    if (res.ok) {
      showToast(`Benutzer "${username}" gelöscht`);
      loadUsersList();
    } else {
      showToast(data.error || 'Löschen fehlgeschlagen', 'error');
    }
  } catch (e) {
    showToast('Verbindungsfehler beim Löschen des Benutzers', 'error');
  }
}

// --- FILE EXPLORER RENDERING ---

// Helper: Get item path hierarchy (Breadcrumbs)
function getBreadcrumbs() {
  const path = [];
  let currentId = currentFolderId;

  while (currentId !== 'root') {
    const folder = allFiles.find(f => f.id === currentId && f.type === 'dir');
    if (folder) {
      path.unshift(folder);
      currentId = folder.parentId;
    } else {
      break;
    }
  }
  
  path.unshift({ id: 'root', name: 'Dateien' });
  return path;
}

// Render Breadcrumbs
function renderBreadcrumbs() {
  const crumbs = getBreadcrumbs();
  breadcrumbsList.innerHTML = '';

  crumbs.forEach((crumb, idx) => {
    const isLast = idx === crumbs.length - 1;
    
    // Breadcrumb Item
    const li = document.createElement('li');
    li.className = `breadcrumb-item ${isLast ? 'active' : ''}`;
    li.innerText = crumb.name;
    if (!isLast) {
      li.addEventListener('click', () => {
        currentFolderId = crumb.id;
        renderExplorer();
      });
    }
    breadcrumbsList.appendChild(li);

    // Separator
    if (!isLast) {
      const sep = document.createElement('li');
      sep.className = 'breadcrumb-separator';
      sep.innerText = '>';
      breadcrumbsList.appendChild(sep);
    }
  });
}

// Guess file type icon based on extension/mimetype
function getFileIconSymbol(file) {
  if (file.type === 'dir') return 'icon-folder';

  const ext = file.name.split('.').pop().toLowerCase();
  const mime = file.mimeType || '';

  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext) || mime.startsWith('image/')) {
    return 'icon-image';
  }
  if (['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv'].includes(ext) || mime.startsWith('video/')) {
    return 'icon-video';
  }
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext) || mime.startsWith('audio/')) {
    return 'icon-audio';
  }
  if (['txt', 'md', 'json', 'js', 'css', 'html', 'xml', 'log', 'sh', 'py'].includes(ext) || mime.startsWith('text/')) {
    return 'icon-text';
  }
  if (ext === 'pdf' || mime === 'application/pdf') {
    return 'icon-pdf';
  }
  
  return 'icon-file';
}

// Render Files and Folders list
function renderExplorer() {
  renderBreadcrumbs();
  fileGrid.innerHTML = '';

  // Get items in current directory
  const currentItems = allFiles.filter(item => item.parentId === currentFolderId);

  if (currentItems.length === 0) {
    // Render Empty State
    fileGrid.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
        </svg>
        <h3>Dieser Ordner ist leer</h3>
        <p>Ziehe Dateien per Drag & Drop hierher oder nutze den Button "Datei hochladen".</p>
      </div>
    `;
    return;
  }

  // Sort: folders first, then alphabetically by name
  currentItems.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'dir' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  // Render each item
  currentItems.forEach(item => {
    const itemCard = document.createElement('div');
    itemCard.className = 'grid-item';
    
    // Icon
    const iconSym = getFileIconSymbol(item);
    const iconClass = iconSym.replace('icon-', '');
    
    // Display metadata
    const infoText = item.type === 'dir' 
      ? 'Ordner'
      : formatBytes(item.size);

    itemCard.innerHTML = `
      <div class="icon-wrapper">
        <svg class="svg-icon ${iconClass}"><use href="#${iconSym}"></use></svg>
      </div>
      <div class="item-name" title="${item.name}">${item.name}</div>
      <div class="item-meta">${infoText}</div>
      
      <!-- Hover Actions -->
      <div class="item-actions">
        ${item.type === 'file' ? `
          <button class="btn-item-action share" title="Teilen" onclick="openShareDialog('${item.id}', '${item.name}', event)">
            <svg><use href="#icon-share"></use></svg>
          </button>
          <button class="btn-item-action download" title="Herunterladen" onclick="downloadFile('${item.id}', '${item.name}', event)">
            <svg><use href="#icon-download"></use></svg>
          </button>
        ` : `
          <button class="btn-item-action download" title="Als ZIP herunterladen" onclick="downloadFolderAsZip('${item.id}', '${item.name}', event)">
            <svg><use href="#icon-download"></use></svg>
          </button>
        `}
        <button class="btn-item-action delete" title="Löschen" onclick="deleteItem('${item.id}', '${item.name}', event)">
          <svg><use href="#icon-delete"></use></svg>
        </button>
      </div>
    `;

    // Click handler (Navigate folder or preview file)
    itemCard.addEventListener('click', () => {
      if (item.type === 'dir') {
        currentFolderId = item.id;
        renderExplorer();
      } else {
        openPreview(item);
      }
    });

    fileGrid.appendChild(itemCard);
  });
}

// --- FOLDER OPERATIONS ---

function openNewFolderDialog() {
  folderNameInput.value = '';
  folderDialog.classList.add('active');
  folderNameInput.focus();
}

function closeNewFolderDialog() {
  folderDialog.classList.remove('active');
}

async function createNewFolder() {
  const name = folderNameInput.value.trim();
  if (!name) return;

  try {
    const res = await fetch('/api/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, parentId: currentFolderId })
    });
    const data = await res.json();

    if (res.ok) {
      showToast(`Ordner "${name}" erstellt`);
      closeNewFolderDialog();
      refreshFileList();
    } else {
      showToast(data.error || 'Fehler beim Erstellen des Ordners', 'error');
    }
  } catch (e) {
    showToast('Verbindungsfehler beim Erstellen des Ordners', 'error');
  }
}

// Refresh Files List from server
async function refreshFileList() {
  try {
    const res = await fetch('/api/files');
    
    // Falls das System offline geschaltet wurde, abfangen
    if (res.status === 503) {
      checkStatus();
      return;
    }

    if (res.ok) {
      allFiles = await res.json();
      renderExplorer();
      
      const statusRes = await fetch('/api/status');
      if (statusRes.ok) {
        const data = await statusRes.json();
        diskInfo = data.diskSpace;
        updateDiskUI();
      }
    }
  } catch (e) {
    console.error("Dateiliste konnte nicht aktualisiert werden:", e);
  }
}

// Delete item (File or Folder)
async function deleteItem(id, name, event) {
  event.stopPropagation(); // Avoid triggering card click
  
  if (!confirm(`Möchtest du "${name}" wirklich löschen? ${allFiles.find(f => f.id === id).type === 'dir' ? 'Alle darin enthaltenen Dateien werden ebenfalls gelöscht!' : ''}`)) {
    return;
  }

  try {
    const res = await fetch(`/api/files/${id}`, {
      method: 'DELETE'
    });
    const data = await res.json();

    if (res.ok) {
      showToast(`"${name}" wurde gelöscht`);
      refreshFileList();
    } else {
      showToast(data.error || 'Löschen fehlgeschlagen', 'error');
    }
  } catch (e) {
    showToast('Verbindungsfehler beim Löschen', 'error');
  }
}

// --- FILE UPLOAD LOGIC ---

function triggerFileUpload() {
  fileInput.click();
}

function triggerFolderUpload() {
  folderInput.click();
}

function handleFileSelect(e) {
  const files = e.target.files;
  if (files.length > 0) {
    uploadFiles(Array.from(files));
    fileInput.value = '';
  }
}

function handleFolderSelect(e) {
  const files = e.target.files;
  if (files.length > 0) {
    uploadFiles(Array.from(files));
    folderInput.value = '';
  }
}

// Drag & Drop Handlers
function handleDragOver(e) {
  e.preventDefault();
  fileGrid.classList.add('dragover');
}

function handleDragLeave(e) {
  e.preventDefault();
  fileGrid.classList.remove('dragover');
}

// Helper: Rekursive Ordner-Traversierung bei Drag & Drop
async function traverseFileTree(entry, path = '') {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        // Setze relativen Pfad als Eigenschaft fest
        Object.defineProperty(file, 'webkitRelativePath', {
          value: path ? `${path}/${file.name}` : file.name,
          writable: false,
          configurable: true
        });
        resolve([file]);
      }, () => resolve([]));
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const allFiles = [];
      const readEntries = () => {
        dirReader.readEntries(async (entries) => {
          if (entries.length === 0) {
            resolve(allFiles);
          } else {
            const entryPromises = entries.map(e => 
              traverseFileTree(e, path ? `${path}/${entry.name}` : entry.name)
            );
            const results = await Promise.all(entryPromises);
            allFiles.push(...results.flat());
            readEntries(); // Lies weiter für den Fall von Paginierung
          }
        }, () => resolve(allFiles));
      };
      readEntries();
    } else {
      resolve([]);
    }
  });
}

async function handleDrop(e) {
  e.preventDefault();
  fileGrid.classList.remove('dragover');
  
  const items = e.dataTransfer.items;
  if (!items || items.length === 0) return;

  const filePromises = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        filePromises.push(traverseFileTree(entry));
      }
    }
  }

  try {
    const results = await Promise.all(filePromises);
    const flatFilesList = results.flat();
    if (flatFilesList.length > 0) {
      uploadFiles(flatFilesList);
    }
  } catch (err) {
    console.error('Fehler beim Drag & Drop Upload:', err);
    showToast('Einige Dateien konnten nicht eingelesen werden.', 'error');
  }
}

// ZIP-Download Trigger für Ordner
function downloadFolderAsZip(folderId, folderName, event) {
  if (event) event.stopPropagation();

  showToast(`ZIP-Erstellung für "${folderName}" gestartet...`);

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/api/download-zip';
  form.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'ids';
  input.value = JSON.stringify([folderId]);
  form.appendChild(input);

  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
}

// Upload file list with progressive UI panels
function uploadFiles(files) {
  uploadPanel.style.display = 'block';
  uploadCount.innerText = `${files.length} Datei(en)`;

  files.forEach(file => {
    const itemId = crypto.randomUUID();
    const uploadItem = document.createElement('div');
    uploadItem.className = 'upload-item';
    uploadItem.id = `upload-${itemId}`;
    uploadItem.innerHTML = `
      <div class="upload-item-name">${file.name}</div>
      <div class="upload-progress">
        <div class="upload-progress-fill" id="progress-fill-${itemId}"></div>
      </div>
    `;
    uploadList.appendChild(uploadItem);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('parentId', currentFolderId);
    
    // Sende relativen Pfad für automatische Ordnererstellung
    if (file.webkitRelativePath) {
      formData.append('relativePath', file.webkitRelativePath);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        const bar = document.getElementById(`progress-fill-${itemId}`);
        if (bar) bar.style.width = `${percent}%`;
      }
    };

    xhr.onload = () => {
      const itemEl = document.getElementById(`upload-${itemId}`);
      if (xhr.status === 200) {
        if (itemEl) {
          itemEl.querySelector('.upload-item-name').innerHTML = `✓ ${file.name}`;
          itemEl.querySelector('.upload-progress-fill').style.backgroundColor = 'var(--success)';
        }
        showToast(`Datei "${file.name}" verschlüsselt hochgeladen`);
        refreshFileList();
      } else {
        if (itemEl) {
          itemEl.querySelector('.upload-item-name').innerHTML = `✗ ${file.name} (Fehler)`;
          itemEl.querySelector('.upload-progress-fill').style.backgroundColor = 'var(--danger)';
        }
        let errorMsg = 'Upload fehlgeschlagen';
        try {
          const resp = JSON.parse(xhr.responseText);
          errorMsg = resp.error || errorMsg;
        } catch (e) {}
        showToast(`Upload von "${file.name}" gescheitert: ${errorMsg}`, 'error');
      }

      setTimeout(() => {
        if (itemEl) itemEl.remove();
        if (uploadList.children.length === 0) {
          uploadPanel.style.display = 'none';
        } else {
          uploadCount.innerText = `${uploadList.children.length} Datei(en)`;
        }
      }, 3000);
    };

    xhr.onerror = () => {
      const itemEl = document.getElementById(`upload-${itemId}`);
      if (itemEl) {
        itemEl.querySelector('.upload-item-name').innerHTML = `✗ ${file.name} (Netzwerkfehler)`;
        itemEl.querySelector('.upload-progress-fill').style.backgroundColor = 'var(--danger)';
      }
      showToast(`Netzwerkfehler beim Hochladen von "${file.name}"`, 'error');
      
      setTimeout(() => {
        if (itemEl) itemEl.remove();
        if (uploadList.children.length === 0) {
          uploadPanel.style.display = 'none';
        }
      }, 3000);
    };

    xhr.send(formData);
  });
}

// Download file handler
function downloadFile(id, name, event) {
  if (event) event.stopPropagation();
  
  const link = document.createElement('a');
  link.href = `/api/download/${id}`;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- FILE PREVIEW MODAL LOGIC ---

async function openPreview(file) {
  previewFilename.innerText = file.name;
  previewBody.innerHTML = '<span style="color: var(--text-muted);">Lade Vorschau...</span>';
  previewDownloadBtn.onclick = () => downloadFile(file.id, file.name);
  previewModal.classList.add('active');

  const fileUrl = `/api/download/${file.id}`;
  const ext = file.name.split('.').pop().toLowerCase();
  const mime = file.mimeType || '';

  try {
    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext) || mime.startsWith('image/')) {
      previewBody.innerHTML = `<img class="preview-media" src="${fileUrl}" alt="${file.name}">`;
    } 
    else if (['mp4', 'webm', 'mkv', 'avi', 'mov'].includes(ext) || mime.startsWith('video/')) {
      previewBody.innerHTML = `
        <video class="preview-media" controls autoplay>
          <source src="${fileUrl}" type="${mime}">
          Ihr Browser unterstützt kein Video-Streaming.
        </video>
      `;
    } 
    else if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext) || mime.startsWith('audio/')) {
      previewBody.innerHTML = `
        <audio class="preview-media" style="width: 80%; max-height: 50px;" controls autoplay>
          <source src="${fileUrl}" type="${mime}">
          Ihr Browser unterstützt keine Audio-Wiedergabe.
        </audio>
      `;
    } 
    else if (ext === 'pdf' || mime === 'application/pdf') {
      previewBody.innerHTML = `<iframe src="${fileUrl}" style="width:100%; height:100%; border:none;"></iframe>`;
    } 
    else if (['txt', 'md', 'js', 'css', 'html', 'json', 'log', 'sh', 'py'].includes(ext) || mime.startsWith('text/')) {
      const response = await fetch(fileUrl);
      if (response.ok) {
        const text = await response.text();
        const div = document.createElement('div');
        div.className = 'preview-text-container';
        div.textContent = text;
        previewBody.innerHTML = '';
        previewBody.appendChild(div);
      } else {
        previewBody.innerHTML = '<span style="color: var(--danger);">Fehler beim Laden des Texts.</span>';
      }
    } 
    else {
      previewModal.classList.remove('active');
      downloadFile(file.id, file.name);
      showToast(`Datei "${file.name}" wird heruntergeladen (Vorschau nicht möglich)`);
    }
  } catch (err) {
    previewBody.innerHTML = '<span style="color: var(--danger);">Vorschau fehlgeschlagen.</span>';
  }
}

function closePreviewModal(event) {
  const media = previewBody.querySelector('video, audio');
  if (media) {
    media.pause();
    media.src = '';
    media.load();
  }
  previewBody.innerHTML = '';
  previewModal.classList.remove('active');
}

// --- SHARING LOGIC ---

function openShareDialog(fileId, fileName, event) {
  if (event) event.stopPropagation();
  currentShareFileId = fileId;
  document.getElementById('share-dialog-filename').innerText = fileName;
  document.getElementById('share-setup-view').style.display = 'block';
  document.getElementById('share-result-view').style.display = 'none';
  document.getElementById('share-duration-input').value = '1d';
  document.getElementById('share-dialog').classList.add('active');
}

function closeShareDialog() {
  document.getElementById('share-dialog').classList.remove('active');
  currentShareFileId = '';
}

async function createFileShare() {
  const duration = document.getElementById('share-duration-input').value;
  if (!currentShareFileId) return;

  try {
    const res = await fetch('/api/shares', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: currentShareFileId, duration })
    });
    const data = await res.json();

    if (res.ok) {
      const shareUrl = `${window.location.origin}/share/${data.shareId}#${data.shareKey}`;
      document.getElementById('share-url-output').value = shareUrl;
      
      const permUrlOutput = document.getElementById('share-perm-url-output');
      const permUrlContainer = document.getElementById('share-perm-container');
      
      if (githubPagesUrl && appBucketId) {
        const permUrl = `${githubPagesUrl}/public/share-redirect.html?b=${appBucketId}&id=${data.shareId}#${data.shareKey}`;
        permUrlOutput.value = permUrl;
        permUrlContainer.style.display = 'block';
      } else {
        permUrlContainer.style.display = 'none';
      }
      
      // Store the key in sessionStorage so the user can copy it again during the session
      let sessionKeys = {};
      try {
        sessionKeys = JSON.parse(sessionStorage.getItem('shareKeys') || '{}');
      } catch (e) {}
      sessionKeys[data.shareId] = data.shareKey;
      sessionStorage.setItem('shareKeys', JSON.stringify(sessionKeys));

      document.getElementById('share-setup-view').style.display = 'none';
      document.getElementById('share-result-view').style.display = 'block';
      showToast('Freigabelink erfolgreich erstellt!');
    } else {
      showToast(data.error || 'Freigabe konnte nicht erstellt werden', 'error');
    }
  } catch (err) {
    showToast('Verbindungsfehler beim Erstellen der Freigabe', 'error');
  }
}

function copyShareUrl(type) {
  const elementId = type === 'perm' ? 'share-perm-url-output' : 'share-url-output';
  const output = document.getElementById(elementId);
  if (!output) return;
  output.select();
  output.setSelectionRange(0, 99999);
  
  navigator.clipboard.writeText(output.value)
    .then(() => {
      showToast('Link in die Zwischenablage kopiert!');
    })
    .catch(() => {
      showToast('Fehler beim Kopieren des Links', 'error');
    });
}

async function loadSharesList() {
  const tableBody = document.getElementById('shares-table-body');
  tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--text-muted);">Lade Freigaben...</td></tr>';

  try {
    const res = await fetch('/api/shares');
    const shares = await res.json();

    if (!res.ok) {
      showToast(shares.error || 'Fehler beim Laden der Freigaben', 'error');
      return;
    }

    if (shares.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--text-muted);">Keine aktiven Freigaben vorhanden.</td></tr>';
      return;
    }

    tableBody.innerHTML = '';
    
    // Retrieve cached keys from sessionStorage
    let sessionKeys = {};
    try {
      sessionKeys = JSON.parse(sessionStorage.getItem('shareKeys') || '{}');
    } catch (e) {}

    shares.forEach(share => {
      const tr = document.createElement('tr');
      const cachedKey = sessionKeys[share.id];
      const hasKey = !!cachedKey;
      
      let expiryText = 'Dauerhaft';
      if (share.expiresAt) {
        const expDate = new Date(share.expiresAt);
        expiryText = `${expDate.toLocaleDateString()} ${expDate.toLocaleTimeString()}`;
      }

      tr.innerHTML = `
        <td style="font-weight: 500; word-break: break-all;">${share.fileName}</td>
        <td>${expiryText}</td>
        <td>
          ${hasKey ? `
            <button class="btn-primary" style="padding: 6px 12px; font-size:12px; width:auto;" onclick="copySpecificShareUrl('${share.id}')">
              Link kopieren
            </button>
          ` : `
            <span style="color: var(--text-muted); font-size:11px;" title="Der Schlüssel wird aus Sicherheitsgründen nicht auf dem Server gespeichert. Erstelle den Link neu, wenn du ihn verloren hast.">
              Schlüssel nicht im Cache ⚠️
            </span>
          `}
        </td>
        <td>
          <button class="btn-logout" style="padding: 6px 12px; font-size:12px;" onclick="deleteShare('${share.id}')">
            Löschen
          </button>
        </td>
      `;
      tableBody.appendChild(tr);
    });
  } catch (err) {
    tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--danger);">Verbindungsfehler beim Laden der Freigaben.</td></tr>';
  }
}

function copySpecificShareUrl(shareId) {
  let sessionKeys = {};
  try {
    sessionKeys = JSON.parse(sessionStorage.getItem('shareKeys') || '{}');
  } catch (e) {}
  const cachedKey = sessionKeys[shareId];
  if (cachedKey) {
    let fullUrl = '';
    if (githubPagesUrl && appBucketId) {
      fullUrl = `${githubPagesUrl}/public/share-redirect.html?b=${appBucketId}&id=${shareId}#${cachedKey}`;
    } else {
      fullUrl = `${window.location.origin}/share/${shareId}#${cachedKey}`;
    }
    navigator.clipboard.writeText(fullUrl)
      .then(() => {
        showToast('Freigabelink kopiert!');
      })
      .catch(() => {
        showToast('Fehler beim Kopieren', 'error');
      });
  }
}

async function deleteShare(shareId) {
  if (!confirm('Möchtest du diese Freigabe wirklich löschen? Der Link wird sofort ungültig und die geteilte Datei wird gelöscht.')) {
    return;
  }

  try {
    const res = await fetch(`/api/shares/${shareId}`, {
      method: 'DELETE'
    });
    const data = await res.json();

    if (res.ok) {
      showToast('Freigabe gelöscht.');
      loadSharesList();
    } else {
      showToast(data.error || 'Fehler beim Löschen der Freigabe', 'error');
    }
  } catch (err) {
    showToast('Verbindungsfehler beim Löschen der Freigabe', 'error');
  }
}

// --- SYSTEM ADMINISTRATION LOGIC ---

async function loadSystemStatus() {
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      const data = await res.json();
      updateMaintenanceUI(data.offline);
    }
  } catch (e) {
    console.error("Fehler beim Laden des Systemstatus:", e);
  }
}

function updateMaintenanceUI(offline) {
  const badge = document.getElementById('maintenance-status-badge');
  const button = document.getElementById('btn-toggle-maintenance');
  if (!badge || !button) return;

  if (offline) {
    badge.innerText = 'Aktiv (Offline)';
    badge.className = 'status-badge status-offline';
    button.innerText = 'Wartungsmodus beenden (Online schalten)';
    button.style.background = 'var(--success)';
    button.style.borderColor = 'var(--success)';
  } else {
    badge.innerText = 'Inaktiv (Online)';
    badge.className = 'status-badge status-online';
    button.innerText = 'Wartungsmodus aktivieren';
    button.style.background = '';
    button.style.borderColor = '';
  }
}

let isTogglingMaintenance = false;

async function toggleMaintenance() {
  if (isTogglingMaintenance) return;
  
  const badge = document.getElementById('maintenance-status-badge');
  const currentStatus = badge ? badge.innerText.includes('Aktiv') : false;
  const newStatus = !currentStatus;
  
  const confirmMsg = newStatus
    ? 'Möchtest du den Wartungsmodus aktivieren? Normale Benutzer können dann nicht mehr auf ihre Dateien zugreifen.'
    : 'Möchtest du den Wartungsmodus beenden und das System wieder online schalten?';
    
  if (!confirm(confirmMsg)) return;

  isTogglingMaintenance = true;
  const button = document.getElementById('btn-toggle-maintenance');
  if (button) button.innerText = 'Bitte warten...';

  try {
    const res = await fetch('/api/admin/maintenance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offline: newStatus })
    });
    const data = await res.json();

    if (res.ok) {
      showToast(data.message);
      updateMaintenanceUI(data.offline);
    } else {
      showToast(data.error || 'Fehler beim Umschalten des Wartungsmodus', 'error');
      loadSystemStatus();
    }
  } catch (e) {
    showToast('Verbindungsfehler beim Umschalten des Wartungsmodus', 'error');
    loadSystemStatus();
  } finally {
    isTogglingMaintenance = false;
  }
}

async function triggerWebUpdate() {
  if (!confirm('Möchtest du das System jetzt aktualisieren? Das System lädt die neuesten Dateien von GitHub und startet den Dienst neu. Die Verbindung wird kurz unterbrochen.')) {
    return;
  }

  const overlay = document.getElementById('update-overlay');
  if (overlay) overlay.style.display = 'flex';

  try {
    const res = await fetch('/api/admin/update', { method: 'POST' });
    const data = await res.json();

    if (res.ok) {
      showToast(data.message);
      setTimeout(() => {
        window.location.reload();
      }, 8000);
    } else {
      showToast(data.error || 'Update failed', 'error');
      if (overlay) overlay.style.display = 'none';
    }
  } catch (e) {
    // Da der Server neu startet, ist ein Verbindungsabbruch normal
    console.log("Erwarteter Netzwerkabbruch durch Update-Neustart:", e);
    setTimeout(() => {
      window.location.reload();
    }, 8000);
  }
}

// HTML Escaping Helper
function escapeHTML(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- NOTIZEN LOGIK ---

async function loadNotesList() {
  try {
    const res = await fetch('/api/notes');
    if (res.ok) {
      allNotes = await res.json();
      renderNotesList();
      
      if (activeNoteId) {
        const stillExists = allNotes.some(n => n.id === activeNoteId);
        if (stillExists) {
          selectNote(activeNoteId);
          return;
        }
      }
      activeNoteId = null;
      document.getElementById('notes-editor-empty').style.display = 'flex';
      document.getElementById('notes-editor-active').style.display = 'none';
    } else {
      showToast('Notizen konnten nicht geladen werden', 'error');
    }
  } catch (err) {
    showToast('Verbindungsfehler beim Laden der Notizen', 'error');
  }
}

function renderNotesList() {
  const notesListDiv = document.getElementById('notes-list');
  const searchInput = document.getElementById('notes-search-input');
  if (!notesListDiv) return;

  notesListDiv.innerHTML = '';
  
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

  const filtered = allNotes
    .filter(note => {
      const titleMatch = (note.title || '').toLowerCase().includes(query);
      const contentMatch = (note.content || '').toLowerCase().includes(query);
      return titleMatch || contentMatch;
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  if (filtered.length === 0) {
    notesListDiv.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:13px;">Keine Notizen gefunden</div>';
    return;
  }

  filtered.forEach(note => {
    const item = document.createElement('div');
    item.className = `note-item ${note.id === activeNoteId ? 'active' : ''}`;
    item.onclick = () => selectNote(note.id);

    const titleStr = note.title ? note.title.trim() : 'Unbenannte Notiz';
    const previewStr = note.content ? note.content.trim() : 'Kein Inhalt';
    const dateStr = new Date(note.updatedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

    item.innerHTML = `
      <div class="note-item-title">${escapeHTML(titleStr)}</div>
      <div class="note-item-preview">${escapeHTML(previewStr)}</div>
      <div class="note-item-date">${dateStr}</div>
    `;

    notesListDiv.appendChild(item);
  });
}

function selectNote(id) {
  if (noteHasUnsavedChanges && !confirm("Ungespeicherte Änderungen an dieser Notiz verwerfen?")) {
    return;
  }

  activeNoteId = id;
  noteHasUnsavedChanges = false;

  const note = allNotes.find(n => n.id === id);
  if (!note) {
    document.getElementById('notes-editor-empty').style.display = 'flex';
    document.getElementById('notes-editor-active').style.display = 'none';
    return;
  }

  document.getElementById('notes-editor-empty').style.display = 'none';
  document.getElementById('notes-editor-active').style.display = 'flex';

  document.getElementById('note-title-input').value = note.title || '';
  document.getElementById('note-content-input').value = note.content || '';

  const indicator = document.getElementById('note-save-indicator');
  if (indicator) {
    indicator.innerText = 'Gespeichert';
    indicator.classList.remove('unsaved');
  }

  document.querySelectorAll('.note-item').forEach(el => el.classList.remove('active'));
  renderNotesList();
}

function createNewNote() {
  if (noteHasUnsavedChanges && !confirm("Ungespeicherte Änderungen an deiner aktuellen Notiz verwerfen?")) {
    return;
  }

  const newNote = {
    id: 'new-' + Date.now(),
    title: 'Neue Notiz',
    content: '',
    updatedAt: new Date().toISOString()
  };

  allNotes.unshift(newNote);
  activeNoteId = newNote.id;
  noteHasUnsavedChanges = true;

  renderNotesList();
  selectNote(newNote.id);
  markNoteUnsaved();
}

async function saveActiveNote() {
  if (!activeNoteId) return;

  const titleVal = document.getElementById('note-title-input').value.trim();
  const contentVal = document.getElementById('note-content-input').value;

  const noteIndex = allNotes.findIndex(n => n.id === activeNoteId);
  if (noteIndex === -1) return;

  if (activeNoteId.startsWith('new-')) {
    const newId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'note-' + Math.random().toString(36).substring(2, 11);
    allNotes[noteIndex].id = newId;
    activeNoteId = newId;
  }

  allNotes[noteIndex].title = titleVal || 'Unbenannte Notiz';
  allNotes[noteIndex].content = contentVal;
  allNotes[noteIndex].updatedAt = new Date().toISOString();

  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(allNotes)
    });

    if (res.ok) {
      noteHasUnsavedChanges = false;
      const indicator = document.getElementById('note-save-indicator');
      if (indicator) {
        indicator.innerText = 'Gespeichert';
        indicator.classList.remove('unsaved');
      }
      showToast('Notiz erfolgreich gespeichert');
      loadNotesList();
    } else {
      showToast('Speichern der Notiz fehlgeschlagen', 'error');
    }
  } catch (err) {
    showToast('Netzwerkfehler beim Speichern', 'error');
  }
}

async function deleteActiveNote() {
  if (!activeNoteId) return;
  if (!confirm("Möchtest du diese Notiz wirklich endgültig löschen?")) return;

  allNotes = allNotes.filter(n => n.id !== activeNoteId);
  activeNoteId = null;
  noteHasUnsavedChanges = false;

  try {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(allNotes)
    });

    if (res.ok) {
      showToast('Notiz gelöscht');
      loadNotesList();
    } else {
      showToast('Löschen der Notiz fehlgeschlagen', 'error');
    }
  } catch (err) {
    showToast('Netzwerkfehler beim Löschen', 'error');
  }
}

function filterNotes() {
  renderNotesList();
}

function markNoteUnsaved() {
  noteHasUnsavedChanges = true;
  const indicator = document.getElementById('note-save-indicator');
  if (indicator) {
    indicator.innerText = 'Ungespeichert';
    indicator.classList.add('unsaved');
  }
}

// --- AKTIVITÄTSPROTOKOLL LOGIK ---

async function loadActivityLog() {
  const tbody = document.getElementById('activity-table-body');
  if (!tbody) return;

  try {
    const res = await fetch('/api/admin/activity');
    if (res.ok) {
      const logs = await res.json();
      tbody.innerHTML = '';

      if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding: 20px 0;">Keine Aktivitäten protokolliert</td></tr>';
        return;
      }

      logs.forEach(log => {
        const tr = document.createElement('tr');
        const timeStr = new Date(log.timestamp).toLocaleString('de-DE');
        
        tr.innerHTML = `
          <td style="color: var(--text-muted); font-family: monospace;">${escapeHTML(timeStr)}</td>
          <td style="font-weight: 600; color: var(--accent-secondary);">${escapeHTML(log.username)}</td>
          <td><span class="status-badge" style="background: rgba(255,255,255,0.03); color: var(--text-main); border: 1px solid var(--border-glass); text-transform:none;">${escapeHTML(log.action)}</span></td>
          <td style="color: var(--text-muted);">${escapeHTML(log.details)}</td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--danger); padding: 20px 0;">Aktivitäten konnten nicht geladen werden</td></tr>';
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--danger); padding: 20px 0;">Verbindungsfehler beim Laden des Protokolls</td></tr>';
  }
}

// --- SYSTEM BACKUPS LOGIC ---

async function loadBackupSettings() {
  try {
    const res = await fetch('/api/admin/backup/settings');
    if (!res.ok) {
      showToast('Backup-Einstellungen konnten nicht geladen werden', 'error');
      return;
    }
    const settings = await res.json();
    
    if (backupEnabledCheckbox) backupEnabledCheckbox.checked = settings.enabled;
    if (backupDestFolderInput) backupDestFolderInput.value = settings.destFolder || '/var/lib/pisecurecloud/backups';
    if (backupRetentionInput) backupRetentionInput.value = settings.retentionDays || 7;
    if (backupHourInput) backupHourInput.value = settings.executionHour !== undefined ? settings.executionHour : 2;
    if (backupMasterPasswordInput) {
      backupMasterPasswordInput.value = '';
      backupMasterPasswordInput.placeholder = settings.hasPassword ? '•••••••• (gespeichert)' : 'Backup-Passwort eingeben';
    }
  } catch (err) {
    console.error('Fehler beim Laden der Backup-Einstellungen:', err);
    showToast('Verbindungsfehler beim Laden der Backup-Einstellungen', 'error');
  }
}

async function saveBackupSettings() {
  if (!backupEnabledCheckbox || !backupDestFolderInput || !backupRetentionInput || !backupHourInput || !backupMasterPasswordInput) return;
  
  const enabled = backupEnabledCheckbox.checked;
  const destFolder = backupDestFolderInput.value.trim();
  const retentionDays = parseInt(backupRetentionInput.value) || 7;
  const executionHour = parseInt(backupHourInput.value) !== undefined ? parseInt(backupHourInput.value) : 2;
  const masterPassword = backupMasterPasswordInput.value;

  if (enabled && !destFolder) {
    showToast('Zielordner ist erforderlich, wenn Backups aktiviert sind', 'error');
    return;
  }

  const hasExistingPassword = backupMasterPasswordInput.placeholder.includes('gespeichert');
  if (enabled && !hasExistingPassword && !masterPassword) {
    showToast('Ein Master-Backup-Passwort ist erforderlich, um Backups zu aktivieren.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/admin/backup/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled,
        destFolder,
        retentionDays,
        executionHour,
        masterPassword: masterPassword || undefined
      })
    });
    
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Backup-Einstellungen erfolgreich gespeichert', 'success');
      loadBackupSettings();
    } else {
      showToast(data.error || 'Fehler beim Speichern der Einstellungen', 'error');
    }
  } catch (err) {
    console.error('Fehler beim Speichern der Backup-Einstellungen:', err);
    showToast('Verbindungsfehler beim Speichern der Backup-Einstellungen', 'error');
  }
}

async function runManualBackup() {
  if (!btnManualBackup) return;
  const originalText = btnManualBackup.innerText;
  btnManualBackup.disabled = true;
  btnManualBackup.innerText = 'Sichert...';
  
  try {
    const res = await fetch('/api/admin/backup/run', { method: 'POST' });
    const data = await res.json();
    
    if (res.ok) {
      showToast(data.message || 'Backup erfolgreich erstellt', 'success');
      loadBackupList();
    } else {
      showToast(data.error || 'Fehler beim Erstellen des Backups', 'error');
    }
  } catch (err) {
    console.error('Fehler beim manuellen Backup:', err);
    showToast('Verbindungsfehler beim Erstellen des Backups', 'error');
  } finally {
    btnManualBackup.disabled = false;
    btnManualBackup.innerText = originalText;
  }
}

async function loadBackupList() {
  if (!backupTableBody) return;
  backupTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Lade Backups...</td></tr>';
  
  try {
    const res = await fetch('/api/admin/backup/list');
    if (!res.ok) {
      backupTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--danger);">Fehler beim Laden der Backups.</td></tr>';
      return;
    }
    
    const backups = await res.json();
    backupTableBody.innerHTML = '';
    
    if (backups.length === 0) {
      backupTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px 0;">Keine Backups vorhanden.</td></tr>';
      return;
    }
    
    backups.forEach(backup => {
      const tr = document.createElement('tr');
      const timeStr = new Date(backup.createdAt).toLocaleString('de-DE');
      
      tr.innerHTML = `
        <td style="font-family: monospace; font-size: 12px; color: var(--text-main); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHTML(backup.filename)}">
          ${escapeHTML(backup.filename)}
        </td>
        <td style="color: var(--text-muted);">${escapeHTML(formatBytes(backup.size))}</td>
        <td style="color: var(--text-muted); font-size: 12px;">${escapeHTML(timeStr)}</td>
        <td>
          <div style="display: flex; gap: 8px;">
            <button class="btn-primary" style="padding: 6px 10px; font-size: 11px; width: auto;" onclick="restoreBackupFile('${escapeJS(backup.filename)}')">Restore</button>
            <button class="btn-logout" style="padding: 6px 10px; font-size: 11px; width: auto; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.2); color: var(--danger);" onclick="deleteBackupFile('${escapeJS(backup.filename)}')">Löschen</button>
          </div>
        </td>
      `;
      backupTableBody.appendChild(tr);
    });
  } catch (err) {
    console.error('Fehler beim Laden der Backups:', err);
    backupTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--danger);">Verbindungsfehler beim Laden der Backups.</td></tr>';
  }
}

async function deleteBackupFile(filename) {
  if (!confirm(`Möchtest du die Backup-Datei "${filename}" wirklich unwiderruflich löschen?`)) {
    return;
  }
  
  try {
    const res = await fetch('/api/admin/backup/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || 'Backup-Datei erfolgreich gelöscht', 'success');
      loadBackupList();
    } else {
      showToast(data.error || 'Fehler beim Löschen der Backup-Datei', 'error');
    }
  } catch (err) {
    console.error('Fehler beim Löschen des Backups:', err);
    showToast('Verbindungsfehler beim Löschen des Backups', 'error');
  }
}

async function restoreBackupFile(filename) {
  const password = prompt(`Gib das Master-Backup-Passwort ein, um das Backup "${filename}" wiederherzustellen:`);
  if (password === null) return; // User cancelled
  if (!password.trim()) {
    showToast('Passwort darf nicht leer sein.', 'error');
    return;
  }
  
  if (!confirm("WARNUNG: Alle aktuellen Konfigurationen und Benutzerdaten werden überschrieben und das System wird neu gestartet. Möchtest du wirklich fortfahren?")) {
    return;
  }
  
  const overlay = document.getElementById('restore-overlay');
  if (overlay) overlay.style.display = 'flex';
  
  try {
    const res = await fetch('/api/admin/backup/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, password })
    });
    
    const data = await res.json();
    if (res.ok) {
      showToast('Wiederherstellung erfolgreich! Das System startet neu...', 'success');
      
      // Wait for service to restart and reload the page
      let countdown = 8;
      const interval = setInterval(() => {
        countdown--;
        if (countdown <= 0) {
          clearInterval(interval);
          window.location.reload();
        }
      }, 1000);
    } else {
      if (overlay) overlay.style.display = 'none';
      showToast(data.error || 'Fehler bei der Wiederherstellung', 'error');
    }
  } catch (err) {
    console.error('Fehler bei der Wiederherstellung:', err);
    if (overlay) overlay.style.display = 'none';
    showToast('Verbindungsfehler während der Wiederherstellung', 'error');
  }
}

function escapeJS(str) {
  return str.replace(/'/g, "\\'");
}

// --- WEBDAV HELPERS ---
function updateWebdavUI() {
  const display = document.getElementById('webdav-url-display');
  if (display) {
    display.innerText = window.location.origin + '/webdav';
  }
}

function copyWebdavUrl() {
  const url = window.location.origin + '/webdav';
  navigator.clipboard.writeText(url).then(() => {
    showToast('WebDAV-URL in die Zwischenablage kopiert!', 'success');
  }).catch(err => {
    console.error('Kopieren fehlgeschlagen:', err);
    showToast('Kopieren fehlgeschlagen', 'error');
  });
}


