using System;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;
using System.Diagnostics;
using System.Linq;
using System.Collections.Generic;
using Microsoft.Win32;

namespace PiSecureCloudClient
{
    public class MainForm : Form
    {
        private Label lblTitle;
        private Label lblSubtitle;
        
        private Panel pnlRegistryWarning;
        private Label lblWarningText;
        private Button btnEnableWarning;

        private Panel pnlGlobalForm;
        private Label lblBucketId;
        private TextBox txtBucketId;
        private Label lblUsername;
        private TextBox txtUsername;
        private Label lblPassword;
        private TextBox txtPassword;

        private TabControl tabControl;
        private TabPage tabDrive;
        private TabPage tabSync;

        // Drive Tab Controls
        private Label lblDriveLetter;
        private ComboBox cmbDriveLetter;
        private Button btnConnect;
        private Button btnDisconnect;

        // Sync Tab Controls
        private Label lblSyncFolders;
        private ListBox lstSyncFolders;
        private Button btnAddSyncFolder;
        private Button btnRemoveSyncFolder;
        private CheckBox chkDeleteRemote;
        private Label lblSyncStatus;

        private Label lblStatus;
        private NotifyIcon trayIcon;
        private ContextMenu trayMenu;

        private string configPath;
        private HttpListener listener;
        private Thread listenerThread;
        private bool isProxyRunning = false;
        private string cachedUrl = null;
        private string activeDrive = null;
        private string activeBucketId = null;

        private FolderSyncManager syncManager = null;

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }

        public MainForm()
        {
            configPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PiSecureCloud",
                "config.txt"
            );

            InitializeComponent();
            LoadConfig();
            CheckRegistryStatus();
            ApplyStyles();
            UpdateLayout();
        }

        private void InitializeComponent()
        {
            this.Text = "PiSecureCloud Desktop Client";
            this.Size = new Size(400, 600);
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Icon = SystemIcons.Application;

            // Title
            lblTitle = new Label();
            lblTitle.Text = "PiSecureCloud";
            lblTitle.Location = new Point(20, 15);
            lblTitle.Size = new Size(340, 30);
            lblTitle.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
            this.Controls.Add(lblTitle);

            // Subtitle
            lblSubtitle = new Label();
            lblSubtitle.Text = "Windows Laufwerk- & Ordnerintegration";
            lblSubtitle.Location = new Point(20, 42);
            lblSubtitle.Size = new Size(340, 20);
            lblSubtitle.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            this.Controls.Add(lblSubtitle);

            // Registry Warning Panel
            pnlRegistryWarning = new Panel();
            pnlRegistryWarning.Location = new Point(20, 65);
            pnlRegistryWarning.Size = new Size(345, 65);
            pnlRegistryWarning.Visible = false;
            this.Controls.Add(pnlRegistryWarning);

            lblWarningText = new Label();
            lblWarningText.Text = "WebDAV erfordert Registry-Aktivierung.";
            lblWarningText.Location = new Point(10, 10);
            lblWarningText.Size = new Size(200, 45);
            lblWarningText.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            pnlRegistryWarning.Controls.Add(lblWarningText);

            btnEnableWarning = new Button();
            btnEnableWarning.Text = "Aktivieren (Admin)";
            btnEnableWarning.Location = new Point(220, 15);
            btnEnableWarning.Size = new Size(115, 32);
            btnEnableWarning.Click += new EventHandler(this.BtnEnableWarning_Click);
            pnlRegistryWarning.Controls.Add(btnEnableWarning);

            // Global Form Panel (Credentials)
            pnlGlobalForm = new Panel();
            pnlGlobalForm.Size = new Size(345, 170);
            this.Controls.Add(pnlGlobalForm);

            // Bucket ID
            lblBucketId = new Label();
            lblBucketId.Text = "Verbindungs-ID (Bucket-ID)";
            lblBucketId.Location = new Point(0, 0);
            lblBucketId.Size = new Size(345, 18);
            pnlGlobalForm.Controls.Add(lblBucketId);

            txtBucketId = new TextBox();
            txtBucketId.Location = new Point(0, 18);
            txtBucketId.Size = new Size(345, 25);
            pnlGlobalForm.Controls.Add(txtBucketId);

            // Username
            lblUsername = new Label();
            lblUsername.Text = "Benutzername";
            lblUsername.Location = new Point(0, 55);
            lblUsername.Size = new Size(345, 18);
            pnlGlobalForm.Controls.Add(lblUsername);

            txtUsername = new TextBox();
            txtUsername.Location = new Point(0, 73);
            txtUsername.Size = new Size(345, 25);
            pnlGlobalForm.Controls.Add(txtUsername);

            // Password
            lblPassword = new Label();
            lblPassword.Text = "Passwort";
            lblPassword.Location = new Point(0, 110);
            lblPassword.Size = new Size(345, 18);
            pnlGlobalForm.Controls.Add(lblPassword);

            txtPassword = new TextBox();
            txtPassword.Location = new Point(0, 128);
            txtPassword.Size = new Size(345, 25);
            txtPassword.UseSystemPasswordChar = true;
            pnlGlobalForm.Controls.Add(txtPassword);

            // Tab Control
            tabControl = new TabControl();
            tabControl.Size = new Size(345, 215);
            this.Controls.Add(tabControl);

            // Tab 1: Drive mount
            tabDrive = new TabPage("Netzlaufwerk");
            tabControl.TabPages.Add(tabDrive);

            lblDriveLetter = new Label();
            lblDriveLetter.Text = "Laufwerksbuchstabe";
            lblDriveLetter.Location = new Point(10, 10);
            lblDriveLetter.Size = new Size(320, 18);
            tabDrive.Controls.Add(lblDriveLetter);

            cmbDriveLetter = new ComboBox();
            cmbDriveLetter.Location = new Point(10, 28);
            cmbDriveLetter.Size = new Size(310, 25);
            cmbDriveLetter.DropDownStyle = ComboBoxStyle.DropDownList;
            PopulateDriveLetters();
            tabDrive.Controls.Add(cmbDriveLetter);

            btnConnect = new Button();
            btnConnect.Text = "Verbinden";
            btnConnect.Location = new Point(10, 95);
            btnConnect.Size = new Size(145, 42);
            btnConnect.Click += new EventHandler(this.BtnConnect_Click);
            tabDrive.Controls.Add(btnConnect);

            btnDisconnect = new Button();
            btnDisconnect.Text = "Trennen";
            btnDisconnect.Location = new Point(175, 95);
            btnDisconnect.Size = new Size(145, 42);
            btnDisconnect.Enabled = false;
            btnDisconnect.Click += new EventHandler(this.BtnDisconnect_Click);
            tabDrive.Controls.Add(btnDisconnect);

            // Tab 2: Folder sync
            tabSync = new TabPage("Ordner-Sync");
            tabControl.TabPages.Add(tabSync);

            lblSyncFolders = new Label();
            lblSyncFolders.Text = "Lokale Ordner synchronisieren";
            lblSyncFolders.Location = new Point(10, 8);
            lblSyncFolders.Size = new Size(200, 18);
            tabSync.Controls.Add(lblSyncFolders);

            lstSyncFolders = new ListBox();
            lstSyncFolders.Location = new Point(10, 25);
            lstSyncFolders.Size = new Size(210, 80);
            tabSync.Controls.Add(lstSyncFolders);

            btnAddSyncFolder = new Button();
            btnAddSyncFolder.Text = "Hinzufügen";
            btnAddSyncFolder.Location = new Point(230, 24);
            btnAddSyncFolder.Size = new Size(95, 30);
            btnAddSyncFolder.Click += new EventHandler(this.BtnAddSyncFolder_Click);
            tabSync.Controls.Add(btnAddSyncFolder);

            btnRemoveSyncFolder = new Button();
            btnRemoveSyncFolder.Text = "Entfernen";
            btnRemoveSyncFolder.Location = new Point(230, 58);
            btnRemoveSyncFolder.Size = new Size(95, 30);
            btnRemoveSyncFolder.Click += new EventHandler(this.BtnRemoveSyncFolder_Click);
            tabSync.Controls.Add(btnRemoveSyncFolder);

            chkDeleteRemote = new CheckBox();
            chkDeleteRemote.Text = "Löschungen synchronisieren";
            chkDeleteRemote.Location = new Point(10, 115);
            chkDeleteRemote.Size = new Size(310, 20);
            chkDeleteRemote.Checked = true;
            tabSync.Controls.Add(chkDeleteRemote);

            lblSyncStatus = new Label();
            lblSyncStatus.Text = "Sync: Inaktiv";
            lblSyncStatus.Location = new Point(10, 142);
            lblSyncStatus.Size = new Size(310, 35);
            lblSyncStatus.Font = new Font("Segoe UI", 9f, FontStyle.Italic);
            tabSync.Controls.Add(lblSyncStatus);

            // Status Label
            lblStatus = new Label();
            lblStatus.Text = "Status: Nicht verbunden";
            lblStatus.Location = new Point(20, 520);
            lblStatus.Size = new Size(340, 25);
            lblStatus.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            this.Controls.Add(lblStatus);

            // System Tray Icon
            trayIcon = new NotifyIcon();
            trayIcon.Text = "PiSecureCloud Netzlaufwerk";
            trayIcon.Icon = SystemIcons.Application;
            trayIcon.Visible = false;
            trayIcon.DoubleClick += new EventHandler(this.TrayIcon_DoubleClick);

            trayMenu = new ContextMenu();
            trayMenu.MenuItems.Add("Öffnen", (s, ev) => this.RestoreWindow());
            trayMenu.MenuItems.Add("-");
            trayMenu.MenuItems.Add("Trennen", (s, ev) => btnDisconnect.PerformClick());
            trayMenu.MenuItems.Add("Beenden", (s, ev) => this.ExitApplication());
            trayIcon.ContextMenu = trayMenu;
        }

        private void ApplyStyles()
        {
            this.BackColor = Color.FromArgb(17, 24, 39); // Gray 900

            lblTitle.ForeColor = Color.FromArgb(99, 102, 241); // Indigo 500
            lblSubtitle.ForeColor = Color.FromArgb(156, 163, 175); // Gray 400
            lblStatus.ForeColor = Color.FromArgb(239, 68, 68); // Red 500

            pnlGlobalForm.BackColor = Color.Transparent;

            // Global credentials styles
            foreach (Control c in pnlGlobalForm.Controls)
            {
                if (c is Label)
                {
                    c.ForeColor = Color.FromArgb(209, 213, 219); // Gray 300
                    c.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
                }
                else if (c is TextBox)
                {
                    c.BackColor = Color.FromArgb(31, 41, 55); // Gray 800
                    c.ForeColor = Color.White;
                    c.Font = new Font("Segoe UI", 10f, FontStyle.Regular);
                    ((TextBox)c).BorderStyle = BorderStyle.FixedSingle;
                }
            }

            // Tab Styling
            tabControl.BackColor = Color.FromArgb(31, 41, 55);
            tabDrive.BackColor = Color.FromArgb(24, 32, 47); // Darker inside
            tabSync.BackColor = Color.FromArgb(24, 32, 47);

            // Tab 1 Styles
            lblDriveLetter.ForeColor = Color.FromArgb(209, 213, 219);
            cmbDriveLetter.BackColor = Color.FromArgb(31, 41, 55);
            cmbDriveLetter.ForeColor = Color.White;
            cmbDriveLetter.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            btnConnect.BackColor = Color.FromArgb(16, 185, 129); // Emerald 500
            btnConnect.ForeColor = Color.White;
            btnConnect.FlatStyle = FlatStyle.Flat;
            btnConnect.FlatAppearance.BorderSize = 0;
            btnConnect.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);

            btnDisconnect.BackColor = Color.FromArgb(239, 68, 68); // Red 500
            btnDisconnect.ForeColor = Color.White;
            btnDisconnect.FlatStyle = FlatStyle.Flat;
            btnDisconnect.FlatAppearance.BorderSize = 0;
            btnDisconnect.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);

            // Tab 2 Styles
            lblSyncFolders.ForeColor = Color.FromArgb(209, 213, 219);
            lstSyncFolders.BackColor = Color.FromArgb(31, 41, 55);
            lstSyncFolders.ForeColor = Color.White;
            lstSyncFolders.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            lstSyncFolders.BorderStyle = BorderStyle.FixedSingle;

            btnAddSyncFolder.BackColor = Color.FromArgb(99, 102, 241);
            btnAddSyncFolder.ForeColor = Color.White;
            btnAddSyncFolder.FlatStyle = FlatStyle.Flat;
            btnAddSyncFolder.FlatAppearance.BorderSize = 0;
            btnAddSyncFolder.Font = new Font("Segoe UI", 9f, FontStyle.Bold);

            btnRemoveSyncFolder.BackColor = Color.FromArgb(107, 114, 128); // Gray 500
            btnRemoveSyncFolder.ForeColor = Color.White;
            btnRemoveSyncFolder.FlatStyle = FlatStyle.Flat;
            btnRemoveSyncFolder.FlatAppearance.BorderSize = 0;
            btnRemoveSyncFolder.Font = new Font("Segoe UI", 9f, FontStyle.Bold);

            chkDeleteRemote.ForeColor = Color.FromArgb(209, 213, 219);
            chkDeleteRemote.Font = new Font("Segoe UI", 9f, FontStyle.Regular);

            lblSyncStatus.ForeColor = Color.FromArgb(156, 163, 175);

            // Warning panel styles
            pnlRegistryWarning.BackColor = Color.FromArgb(55, 48, 163); // Indigo 900
            lblWarningText.ForeColor = Color.FromArgb(224, 231, 255); // Indigo 100
            btnEnableWarning.BackColor = Color.FromArgb(99, 102, 241); // Indigo 500
            btnEnableWarning.ForeColor = Color.White;
            btnEnableWarning.FlatStyle = FlatStyle.Flat;
            btnEnableWarning.FlatAppearance.BorderSize = 0;
            btnEnableWarning.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
        }

        private void UpdateLayout()
        {
            if (pnlRegistryWarning.Visible)
            {
                pnlGlobalForm.Location = new Point(20, 140);
                tabControl.Location = new Point(20, 315);
                lblStatus.Location = new Point(20, 540);
                this.ClientSize = new Size(385, 575);
            }
            else
            {
                pnlGlobalForm.Location = new Point(20, 75);
                tabControl.Location = new Point(20, 250);
                lblStatus.Location = new Point(20, 475);
                this.ClientSize = new Size(385, 510);
            }
        }

        private void PopulateDriveLetters()
        {
            cmbDriveLetter.Items.Clear();
            var activeDrives = DriveInfo.GetDrives().Select(d => d.Name.Substring(0, 2)).ToList();
            
            char[] suggestions = { 'P', 'S', 'Z', 'Y', 'X', 'W', 'V', 'T', 'O', 'N', 'M', 'L', 'K' };
            foreach (char c in suggestions)
            {
                string d = c + ":";
                if (!activeDrives.Contains(d))
                {
                    cmbDriveLetter.Items.Add(d);
                }
            }
            
            // Option for syncing folders only
            cmbDriveLetter.Items.Add("[Nur Ordner-Sync]");
            
            if (cmbDriveLetter.Items.Count > 0)
            {
                cmbDriveLetter.SelectedIndex = 0;
            }
        }

        private void CheckRegistryStatus()
        {
            pnlRegistryWarning.Visible = !IsBasicAuthEnabled();
        }

        private bool IsBasicAuthEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\WebClient\Parameters"))
                {
                    if (key != null)
                    {
                        object val = key.GetValue("BasicAuthLevel");
                        if (val != null && Convert.ToInt32(val) == 2)
                        {
                            return true;
                        }
                    }
                }
            }
            catch {}
            return false;
        }

        private void BtnEnableWarning_Click(object sender, EventArgs e)
        {
            btnEnableWarning.Enabled = false;
            btnEnableWarning.Text = "Wird aktiviert...";
            
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "powershell.exe";
                psi.Arguments = "-Command \"Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters' -Name 'BasicAuthLevel' -Value 2; Restart-Service WebClient\"";
                psi.Verb = "runas"; // Requests admin UAC prompt
                psi.UseShellExecute = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                
                Process p = Process.Start(psi);
                p.WaitForExit();
                
                if (IsBasicAuthEnabled())
                {
                    pnlRegistryWarning.Visible = false;
                    UpdateLayout();
                    MessageBox.Show("WebDAV-Unterstützung wurde erfolgreich aktiviert!", "Erfolg", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    MessageBox.Show("Aktivierung fehlgeschlagen. Bitte stelle sicher, dass du Admin-Rechte gewährt hast.", "Fehler", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Fehler beim Starten der PowerShell: " + ex.Message, "Fehler", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                btnEnableWarning.Enabled = true;
                btnEnableWarning.Text = "Aktivieren (Admin)";
            }
        }

        private void BtnAddSyncFolder_Click(object sender, EventArgs e)
        {
            using (var fbd = new FolderBrowserDialog())
            {
                fbd.Description = "Wähle einen lokalen Ordner zur Synchronisation mit der Cloud aus";
                if (fbd.ShowDialog() == DialogResult.OK)
                {
                    string path = fbd.SelectedPath;
                    if (!lstSyncFolders.Items.Contains(path))
                    {
                        lstSyncFolders.Items.Add(path);
                        SaveConfig();
                    }
                }
            }
        }

        private void BtnRemoveSyncFolder_Click(object sender, EventArgs e)
        {
            if (lstSyncFolders.SelectedIndex >= 0)
            {
                lstSyncFolders.Items.RemoveAt(lstSyncFolders.SelectedIndex);
                SaveConfig();
            }
        }

        private void BtnConnect_Click(object sender, EventArgs e)
        {
            string bucketId = txtBucketId.Text.Trim();
            string username = txtUsername.Text.Trim();
            string password = txtPassword.Text;
            string driveLetter = cmbDriveLetter.SelectedItem != null ? cmbDriveLetter.SelectedItem.ToString() : null;

            if (string.IsNullOrEmpty(bucketId) || string.IsNullOrEmpty(username) || string.IsNullOrEmpty(password) || string.IsNullOrEmpty(driveLetter))
            {
                MessageBox.Show("Bitte fülle alle Felder aus.", "Eingabe erforderlich", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            btnConnect.Enabled = false;
            lblStatus.Text = "Status: Verbinde...";
            lblStatus.ForeColor = Color.FromArgb(245, 158, 11); // Amber

            SaveConfig();

            activeBucketId = bucketId;
            cachedUrl = null;

            // Start Proxy
            try
            {
                StartProxy();
            }
            catch (Exception ex)
            {
                lblStatus.Text = "Status: Proxy-Fehler";
                lblStatus.ForeColor = Color.FromArgb(239, 68, 68);
                btnConnect.Enabled = true;
                MessageBox.Show("Der lokale Proxy-Server konnte nicht gestartet werden:\n" + ex.Message, "Verbindungsfehler", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            bool mountDriveEnabled = (driveLetter != "[Nur Ordner-Sync]");

            // Mount network drive and/or start folder synchronization
            ThreadPool.QueueUserWorkItem((state) =>
            {
                bool success = true;
                if (mountDriveEnabled)
                {
                    success = MountDrive(driveLetter, username, password);
                }
                
                this.Invoke((MethodInvoker)delegate
                {
                    if (success)
                    {
                        if (mountDriveEnabled)
                        {
                            activeDrive = driveLetter;
                            lblStatus.Text = "Status: Verbunden auf Laufwerk " + driveLetter;
                            lblStatus.ForeColor = Color.FromArgb(16, 185, 129); // Emerald
                            
                            // Open Explorer
                            try
                            {
                                Process.Start("explorer.exe", driveLetter);
                            }
                            catch {}
                        }
                        else
                        {
                            lblStatus.Text = "Status: Verbunden (Nur Ordner-Sync)";
                            lblStatus.ForeColor = Color.FromArgb(16, 185, 129);
                        }

                        btnDisconnect.Enabled = true;

                        // Start Folder Sync Manager
                        List<string> folders = lstSyncFolders.Items.Cast<string>().ToList();
                        if (folders.Count > 0)
                        {
                            syncManager = new FolderSyncManager(
                                bucketId,
                                username,
                                password,
                                folders,
                                chkDeleteRemote.Checked,
                                (statusMsg) =>
                                {
                                    this.Invoke((MethodInvoker)delegate
                                    {
                                        lblSyncStatus.Text = statusMsg;
                                    });
                                }
                            );
                            syncManager.Start();
                        }
                        else
                        {
                            lblSyncStatus.Text = "Sync: Keine Ordner eingerichtet.";
                        }
                    }
                    else
                    {
                        StopProxy();
                        lblStatus.Text = "Status: Verbindungsfehler";
                        lblStatus.ForeColor = Color.FromArgb(239, 68, 68);
                        btnConnect.Enabled = true;
                        MessageBox.Show("Laufwerk konnte nicht eingebunden werden. Bitte prüfe deine Bucket-ID, Username und Passwort.\nTipp: Stelle sicher, dass der WebClient-Dienst läuft.", "Fehler beim Einbinden", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                });
            });
        }

        private void BtnDisconnect_Click(object sender, EventArgs e)
        {
            btnDisconnect.Enabled = false;
            lblStatus.Text = "Status: Trenne...";
            lblStatus.ForeColor = Color.FromArgb(245, 158, 11);

            ThreadPool.QueueUserWorkItem((state) =>
            {
                // Stop Sync
                if (syncManager != null)
                {
                    syncManager.Stop();
                    syncManager = null;
                }

                // Unmount Drive
                if (!string.IsNullOrEmpty(activeDrive))
                {
                    UnmountDrive(activeDrive);
                    activeDrive = null;
                }
                
                StopProxy();

                this.Invoke((MethodInvoker)delegate
                {
                    lblStatus.Text = "Status: Nicht verbunden";
                    lblStatus.ForeColor = Color.FromArgb(239, 68, 68);
                    lblSyncStatus.Text = "Sync: Inaktiv";
                    btnConnect.Enabled = true;
                    PopulateDriveLetters(); // Refresh free letters
                });
            });
        }

        private void StartProxy()
        {
            listener = new HttpListener();
            listener.Prefixes.Add("http://127.0.0.1:18080/");
            listener.Start();
            isProxyRunning = true;

            listenerThread = new Thread(() =>
            {
                while (isProxyRunning)
                {
                    try
                    {
                        HttpListenerContext context = listener.GetContext();
                        ThreadPool.QueueUserWorkItem((state) =>
                        {
                            try
                            {
                                HandleRequest(context);
                            }
                            catch (Exception ex)
                            {
                                Console.WriteLine("Proxy handle exception: " + ex.Message);
                            }
                        });
                    }
                    catch (HttpListenerException)
                    {
                        // Exits when stopped
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("Proxy thread exception: " + ex.Message);
                    }
                }
            });
            listenerThread.IsBackground = true;
            listenerThread.Start();
        }

        private void StopProxy()
        {
            isProxyRunning = false;
            if (listener != null)
            {
                try
                {
                    listener.Stop();
                    listener.Close();
                }
                catch {}
            }
        }

        private static string ResolveBucketUrl(string bucketId)
        {
            if (string.IsNullOrEmpty(bucketId)) return null;

            // Falls der Benutzer direkt eine IP-Adresse oder URL eingibt (z. B. http://localhost:3000 oder http://192.168.1.100:3000)
            if (bucketId.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || 
                bucketId.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                return bucketId.TrimEnd('/');
            }

            try
            {
                using (var client = new WebClient())
                {
                    string json = client.DownloadString("https://keyvalue.immanuel.co/api/KeyVal/GetValue/" + bucketId + "/url");
                    string hex = json.Trim('\"', ' ', '\r', '\n');
                    
                    byte[] bytes = new byte[hex.Length / 2];
                    for (int i = 0; i < bytes.Length; i++)
                    {
                        bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
                    }
                    return System.Text.Encoding.UTF8.GetString(bytes);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Error resolving bucket: " + ex.Message);
                return null;
            }
        }

        private void HandleRequest(HttpListenerContext context)
        {
            HttpListenerRequest req = context.Request;
            HttpListenerResponse resp = context.Response;

            if (string.IsNullOrEmpty(activeBucketId))
            {
                resp.StatusCode = 400;
                resp.Close();
                return;
            }

            if (cachedUrl == null)
            {
                cachedUrl = ResolveBucketUrl(activeBucketId);
            }

            int retryCount = 0;
            while (retryCount < 2)
            {
                try
                {
                    if (string.IsNullOrEmpty(cachedUrl))
                    {
                        throw new Exception("Bucket URL unresolved");
                    }
                    ForwardRequest(context, cachedUrl);
                    return; // Success
                }
                catch (Exception ex)
                {
                    Console.WriteLine("Forward error, retrying: " + ex.Message);
                    retryCount++;
                    
                    // Re-resolve
                    string freshUrl = ResolveBucketUrl(activeBucketId);
                    if (!string.IsNullOrEmpty(freshUrl))
                    {
                        cachedUrl = freshUrl;
                    }
                }
            }

            try
            {
                resp.StatusCode = 502;
                using (var writer = new StreamWriter(resp.OutputStream))
                {
                    writer.Write("502 Bad Gateway - Proxy konnte Cloud nicht erreichen.");
                }
                resp.Close();
            }
            catch {}
        }

        private void ForwardRequest(HttpListenerContext context, string targetUrl)
        {
            HttpListenerRequest req = context.Request;
            HttpListenerResponse resp = context.Response;

            string remoteUrl = targetUrl + req.RawUrl;
            HttpWebRequest remoteReq = (HttpWebRequest)WebRequest.Create(remoteUrl);
            remoteReq.Method = req.HttpMethod;
            remoteReq.KeepAlive = false;
            remoteReq.Timeout = 20000; // 20s timeout

            // Copy headers
            foreach (string headerName in req.Headers)
            {
                try
                {
                    string headerValue = req.Headers[headerName];
                    if (headerName.Equals("Host", StringComparison.OrdinalIgnoreCase)) continue;
                    if (headerName.Equals("Connection", StringComparison.OrdinalIgnoreCase)) continue;
                    if (headerName.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
                    if (headerName.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)) continue;
                    if (headerName.Equals("Expect", StringComparison.OrdinalIgnoreCase)) continue;

                    if (headerName.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))
                    {
                        remoteReq.ContentType = headerValue;
                        continue;
                    }
                    if (headerName.Equals("Accept", StringComparison.OrdinalIgnoreCase))
                    {
                        remoteReq.Accept = headerValue;
                        continue;
                    }
                    if (headerName.Equals("User-Agent", StringComparison.OrdinalIgnoreCase))
                    {
                        remoteReq.UserAgent = headerValue;
                        continue;
                    }
                    if (headerName.Equals("Referer", StringComparison.OrdinalIgnoreCase))
                    {
                        remoteReq.Referer = headerValue;
                        continue;
                    }
                    if (headerName.Equals("If-Modified-Since", StringComparison.OrdinalIgnoreCase))
                    {
                        DateTime dt;
                        if (DateTime.TryParse(headerValue, out dt))
                        {
                            remoteReq.IfModifiedSince = dt;
                            continue;
                        }
                    }

                    remoteReq.Headers.Add(headerName, headerValue);
                }
                catch {}
            }

            // Copy request body
            if (req.HasEntityBody)
            {
                if (req.ContentLength64 > 0)
                {
                    remoteReq.ContentLength = req.ContentLength64;
                }
                else if ("chunked".Equals(req.Headers["Transfer-Encoding"], StringComparison.OrdinalIgnoreCase))
                {
                    remoteReq.SendChunked = true;
                }

                using (var reqStream = req.InputStream)
                using (var remoteStream = remoteReq.GetRequestStream())
                {
                    byte[] buffer = new byte[65536];
                    int read;
                    while ((read = reqStream.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        remoteStream.Write(buffer, 0, read);
                    }
                }
            }

            // Execute & Stream response
            using (HttpWebResponse remoteResp = (HttpWebResponse)remoteReq.GetResponse())
            {
                resp.StatusCode = (int)remoteResp.StatusCode;
                resp.StatusDescription = remoteResp.StatusDescription;

                foreach (string headerName in remoteResp.Headers)
                {
                    try
                    {
                        string headerValue = remoteResp.Headers[headerName];
                        if (headerName.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase)) continue;
                        if (headerName.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
                        resp.Headers.Add(headerName, headerValue);
                    }
                    catch {}
                }

                if (remoteResp.ContentLength >= 0)
                {
                    resp.ContentLength64 = remoteResp.ContentLength;
                }

                using (var remoteRespStream = remoteResp.GetResponseStream())
                {
                    if (remoteRespStream != null)
                    {
                        byte[] buffer = new byte[65536];
                        int read;
                        while ((read = remoteRespStream.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            resp.OutputStream.Write(buffer, 0, read);
                        }
                    }
                }
            }
        }

        private bool MountDrive(string driveLetter, string username, string password)
        {
            try
            {
                UnmountDrive(driveLetter);

                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
                // Mount /webdav subpath directly for maximum compatibility
                psi.Arguments = string.Format("/c net use {0} http://127.0.0.1:18080/webdav \"{1}\" /user:\"{2}\" /persistent:no", driveLetter, password, username);
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardError = true;
                psi.RedirectStandardOutput = true;

                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit();
                    return p.ExitCode == 0;
                }
            }
            catch
            {
                return false;
            }
        }

        private void UnmountDrive(string driveLetter)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe");
                psi.Arguments = string.Format("/c net use {0} /delete /y", driveLetter);
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit();
                }
            }
            catch {}
        }

        private void LoadConfig()
        {
            try
            {
                if (File.Exists(configPath))
                {
                    lstSyncFolders.Items.Clear();
                    foreach (var line in File.ReadAllLines(configPath))
                    {
                        var parts = line.Split(new char[] { '=' }, 2);
                        if (parts.Length == 2)
                        {
                            if (parts[0] == "bucketId") txtBucketId.Text = parts[1];
                            if (parts[0] == "username") txtUsername.Text = parts[1];
                            if (parts[0] == "driveLetter")
                            {
                                int idx = cmbDriveLetter.Items.IndexOf(parts[1]);
                                if (idx >= 0) cmbDriveLetter.SelectedIndex = idx;
                            }
                            if (parts[0] == "deleteRemoteOnDelete")
                            {
                                chkDeleteRemote.Checked = bool.Parse(parts[1]);
                            }
                            if (parts[0] == "syncFolders")
                            {
                                foreach (var folder in parts[1].Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
                                {
                                    if (Directory.Exists(folder))
                                    {
                                        lstSyncFolders.Items.Add(folder);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            catch {}
        }

        private void SaveConfig()
        {
            try
            {
                string dir = Path.GetDirectoryName(configPath);
                if (!Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                using (var writer = new StreamWriter(configPath))
                {
                    writer.WriteLine("bucketId=" + txtBucketId.Text.Trim());
                    writer.WriteLine("username=" + txtUsername.Text.Trim());
                    if (cmbDriveLetter.SelectedItem != null)
                    {
                        writer.WriteLine("driveLetter=" + cmbDriveLetter.SelectedItem.ToString());
                    }
                    writer.WriteLine("deleteRemoteOnDelete=" + chkDeleteRemote.Checked.ToString());
                    
                    var folders = lstSyncFolders.Items.Cast<string>().ToList();
                    writer.WriteLine("syncFolders=" + string.Join(";", folders.ToArray()));
                }
            }
            catch {}
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (this.WindowState == FormWindowState.Minimized)
            {
                this.Hide();
                trayIcon.Visible = true;
            }
        }

        private void TrayIcon_DoubleClick(object sender, EventArgs e)
        {
            RestoreWindow();
        }

        private void RestoreWindow()
        {
            this.Show();
            this.WindowState = FormWindowState.Normal;
            trayIcon.Visible = false;
        }

        private void ExitApplication()
        {
            trayIcon.Visible = false;
            this.Close();
            Application.Exit();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing && isProxyRunning)
            {
                e.Cancel = true;
                this.Hide();
                trayIcon.Visible = true;
                trayIcon.ShowBalloonTip(3000, "PiSecureCloud aktiv", "Das Netzlaufwerk und die Ordner-Synchronisation bleiben aktiv. Tray-Icon fuer Optionen.", ToolTipIcon.Info);
            }
            else
            {
                if (syncManager != null)
                {
                    syncManager.Stop();
                    syncManager = null;
                }

                StopProxy();
                if (!string.IsNullOrEmpty(activeDrive))
                {
                    UnmountDrive(activeDrive);
                }
                trayIcon.Visible = false;
            }
            base.OnFormClosing(e);
        }
    }

    public class FolderSyncManager
    {
        private string bucketId;
        private string username;
        private string password;
        private List<string> localFolders;
        private bool deleteRemoteOnDelete;
        private string indexFilePath;

        private Dictionary<string, SyncState> syncIndex = new Dictionary<string, SyncState>();
        private List<FileSystemWatcher> watchers = new List<FileSystemWatcher>();
        private bool isRunning = false;
        private Thread syncThread;
        private Action<string> onStatusUpdate;

        private class SyncState
        {
            public string LocalPath { get; set; }
            public string RelativePath { get; set; }
            public long LastWriteTicks { get; set; }
            public long FileSize { get; set; }
        }

        public FolderSyncManager(string bucketId, string username, string password, List<string> folders, bool deleteRemote, Action<string> statusCallback)
        {
            this.bucketId = bucketId;
            this.username = username;
            this.password = password;
            this.localFolders = folders;
            this.deleteRemoteOnDelete = deleteRemote;
            this.onStatusUpdate = statusCallback;

            string appData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PiSecureCloud");
            this.indexFilePath = Path.Combine(appData, "sync_index.txt");
        }

        public void Start()
        {
            isRunning = true;
            LoadIndex();
            onStatusUpdate("Sync: Starte Hintergrundscan...");

            syncThread = new Thread(new ThreadStart(PerformInitialSync));
            syncThread.IsBackground = true;
            syncThread.Start();

            // Register watcher for each local folder
            foreach (string folder in localFolders)
            {
                try
                {
                    if (Directory.Exists(folder))
                    {
                        var watcher = new FileSystemWatcher();
                        watcher.Path = folder;
                        watcher.IncludeSubdirectories = true;
                        watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size;
                        
                        watcher.Created += (s, e) => ThreadPool.QueueUserWorkItem((state) => HandleCreatedChanged(folder, e.FullPath));
                        watcher.Changed += (s, e) => ThreadPool.QueueUserWorkItem((state) => HandleCreatedChanged(folder, e.FullPath));
                        watcher.Deleted += (s, e) => ThreadPool.QueueUserWorkItem((state) => HandleDeleted(folder, e.FullPath));
                        watcher.Renamed += (s, e) => ThreadPool.QueueUserWorkItem((state) => HandleRenamed(folder, e.OldFullPath, e.FullPath));

                        watcher.EnableRaisingEvents = true;
                        watchers.Add(watcher);
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine("Error starting watcher for " + folder + ": " + ex.Message);
                }
            }
        }

        public void Stop()
        {
            isRunning = false;
            foreach (var w in watchers)
            {
                try { w.EnableRaisingEvents = false; w.Dispose(); } catch {}
            }
            watchers.Clear();

            if (syncThread != null && syncThread.IsAlive)
            {
                syncThread.Join(2000);
            }

            SaveIndex();
        }

        private void PerformInitialSync()
        {
            try
            {
                int uploadedCount = 0;
                int deletedCount = 0;
                HashSet<string> filesOnDiskKeys = new HashSet<string>();

                foreach (string rootFolder in localFolders)
                {
                    if (!isRunning) return;
                    if (!Directory.Exists(rootFolder)) continue;

                    string rootName = Path.GetFileName(rootFolder);
                    
                    // Recursive directory scan
                    string[] files = Directory.GetFiles(rootFolder, "*", SearchOption.AllDirectories);
                    foreach (string localFilePath in files)
                    {
                        if (!isRunning) return;

                        string relative = localFilePath.Substring(rootFolder.Length).Replace('\\', '/').TrimStart('/');
                        string remotePath = "Sync/" + rootName + "/" + relative;
                        string key = rootFolder + "|" + remotePath;
                        filesOnDiskKeys.Add(key);

                        var fileInfo = new FileInfo(localFilePath);
                        long writeTicks = fileInfo.LastWriteTimeUtc.Ticks;
                        long size = fileInfo.Length;

                        bool needsUpload = false;
                        if (!syncIndex.ContainsKey(key))
                        {
                            needsUpload = true;
                        }
                        else
                        {
                            var state = syncIndex[key];
                            if (state.LastWriteTicks != writeTicks || state.FileSize != size)
                            {
                                needsUpload = true;
                            }
                        }

                        if (needsUpload)
                        {
                            onStatusUpdate("Sync: Synchronisiere " + fileInfo.Name + "...");
                            EnsureRemoteDirectoryExists(remotePath);
                            
                            if (SyncPutFile(remotePath, localFilePath))
                            {
                                syncIndex[key] = new SyncState
                                {
                                    LocalPath = rootFolder,
                                    RelativePath = remotePath,
                                    LastWriteTicks = writeTicks,
                                    FileSize = size
                                };
                                SaveIndex();
                                uploadedCount++;
                            }
                        }
                    }
                }

                // Delete missing files from remote
                if (deleteRemoteOnDelete && isRunning)
                {
                    List<string> keysToRemove = new List<string>();
                    foreach (var key in syncIndex.Keys)
                    {
                        if (!filesOnDiskKeys.Contains(key))
                        {
                            var state = syncIndex[key];
                            // Check if this belongs to our active folder list
                            if (localFolders.Contains(state.LocalPath))
                            {
                                onStatusUpdate("Sync: Entferne " + Path.GetFileName(state.RelativePath) + " aus Cloud...");
                                if (SyncDelete(state.RelativePath))
                                {
                                    keysToRemove.Add(key);
                                    deletedCount++;
                                }
                            }
                        }
                    }

                    foreach (var key in keysToRemove)
                    {
                        syncIndex.Remove(key);
                    }
                    
                    if (keysToRemove.Count > 0)
                    {
                        SaveIndex();
                    }
                }

                onStatusUpdate(string.Format("Sync: Aktiv ({0} hochgeladen, {1} geloescht)", uploadedCount, deletedCount));
            }
            catch (Exception ex)
            {
                onStatusUpdate("Sync: Fehler bei Initialisierung - " + ex.Message);
            }
        }

        private void HandleCreatedChanged(string rootFolder, string fullPath)
        {
            if (!isRunning) return;
            if (!File.Exists(fullPath)) return; // Directories handled by file parent creation

            try
            {
                string rootName = Path.GetFileName(rootFolder);
                string relative = fullPath.Substring(rootFolder.Length).Replace('\\', '/').TrimStart('/');
                string remotePath = "Sync/" + rootName + "/" + relative;
                string key = rootFolder + "|" + remotePath;

                var fileInfo = new FileInfo(fullPath);
                WaitForFileUnlock(fullPath);
                if (!File.Exists(fullPath)) return; // Re-check after waiting

                long writeTicks = fileInfo.LastWriteTimeUtc.Ticks;
                long size = fileInfo.Length;

                onStatusUpdate("Sync: Sende " + fileInfo.Name + "...");
                EnsureRemoteDirectoryExists(remotePath);
                
                if (SyncPutFile(remotePath, fullPath))
                {
                    syncIndex[key] = new SyncState
                    {
                        LocalPath = rootFolder,
                        RelativePath = remotePath,
                        LastWriteTicks = writeTicks,
                        FileSize = size
                    };
                    SaveIndex();
                    onStatusUpdate("Sync: Aktiv (Aenderung synchronisiert)");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Sync change handler error: " + ex.Message);
            }
        }

        private void HandleDeleted(string rootFolder, string fullPath)
        {
            if (!isRunning || !deleteRemoteOnDelete) return;

            try
            {
                string rootName = Path.GetFileName(rootFolder);
                string relative = fullPath.Substring(rootFolder.Length).Replace('\\', '/').TrimStart('/');
                string remotePath = "Sync/" + rootName + "/" + relative;
                string key = rootFolder + "|" + remotePath;

                if (syncIndex.ContainsKey(key))
                {
                    onStatusUpdate("Sync: Loesche " + Path.GetFileName(remotePath) + "...");
                    if (SyncDelete(remotePath))
                    {
                        syncIndex.Remove(key);
                        SaveIndex();
                        onStatusUpdate("Sync: Aktiv (Loeschung synchronisiert)");
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Sync delete handler error: " + ex.Message);
            }
        }

        private void HandleRenamed(string rootFolder, string oldFullPath, string newFullPath)
        {
            if (!isRunning) return;

            try
            {
                string rootName = Path.GetFileName(rootFolder);
                string oldRelative = oldFullPath.Substring(rootFolder.Length).Replace('\\', '/').TrimStart('/');
                string oldRemotePath = "Sync/" + rootName + "/" + oldRelative;
                
                string newRelative = newFullPath.Substring(rootFolder.Length).Replace('\\', '/').TrimStart('/');
                string newRemotePath = "Sync/" + rootName + "/" + newRelative;

                onStatusUpdate("Sync: Verschiebe " + Path.GetFileName(oldRemotePath) + "...");
                EnsureRemoteDirectoryExists(newRemotePath);

                if (SyncMove(oldRemotePath, newRemotePath))
                {
                    // Update index
                    string oldKey = rootFolder + "|" + oldRemotePath;
                    if (syncIndex.ContainsKey(oldKey))
                    {
                        var state = syncIndex[oldKey];
                        syncIndex.Remove(oldKey);
                        
                        state.RelativePath = newRemotePath;
                        if (File.Exists(newFullPath))
                        {
                            var fileInfo = new FileInfo(newFullPath);
                            state.LastWriteTicks = fileInfo.LastWriteTimeUtc.Ticks;
                            state.FileSize = fileInfo.Length;
                        }
                        
                        string newKey = rootFolder + "|" + newRemotePath;
                        syncIndex[newKey] = state;
                    }
                    else
                    {
                        // Directory rename or untracked file, re-scan this subtree
                        if (Directory.Exists(newFullPath))
                        {
                            // Remove old keys matching old directory subtree
                            List<string> oldKeys = syncIndex.Keys.Where(k => k.StartsWith(rootFolder + "|" + oldRemotePath + "/")).ToList();
                            foreach (var ok in oldKeys)
                            {
                                var state = syncIndex[ok];
                                syncIndex.Remove(ok);
                                
                                string subRelative = state.RelativePath.Substring(oldRemotePath.Length);
                                string newSubRemotePath = newRemotePath + subRelative;
                                state.RelativePath = newSubRemotePath;
                                
                                string newSubKey = rootFolder + "|" + newSubRemotePath;
                                syncIndex[newSubKey] = state;
                            }
                        }
                    }

                    SaveIndex();
                    onStatusUpdate("Sync: Aktiv (Verschiebung synchronisiert)");
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Sync rename handler error: " + ex.Message);
            }
        }

        private void EnsureRemoteDirectoryExists(string remotePath)
        {
            string[] parts = remotePath.Split('/');
            string currentPath = "";
            for (int i = 0; i < parts.Length - 1; i++)
            {
                if (string.IsNullOrEmpty(parts[i])) continue;
                currentPath = string.IsNullOrEmpty(currentPath) ? parts[i] : currentPath + "/" + parts[i];
                SyncMkcol(currentPath);
            }
        }

        private bool SyncMkcol(string remotePath)
        {
            try
            {
                string url = "http://127.0.0.1:18080/webdav/" + Uri.EscapeDataString(remotePath).Replace("%2F", "/");
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "MKCOL";
                
                string auth = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes(username + ":" + password));
                request.Headers.Add("Authorization", "Basic " + auth);
                
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.Created || 
                           response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch (WebException ex)
            {
                var resp = ex.Response as HttpWebResponse;
                if (resp != null && (resp.StatusCode == HttpStatusCode.MethodNotAllowed || resp.StatusCode == HttpStatusCode.Conflict))
                {
                    return true;
                }
                return false;
            }
            catch
            {
                return false;
            }
        }

        private bool SyncPutFile(string remotePath, string localFilePath)
        {
            try
            {
                string url = "http://127.0.0.1:18080/webdav/" + Uri.EscapeDataString(remotePath).Replace("%2F", "/");
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "PUT";
                
                string auth = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes(username + ":" + password));
                request.Headers.Add("Authorization", "Basic " + auth);
                
                request.ContentLength = new FileInfo(localFilePath).Length;
                using (var fileStream = File.OpenRead(localFilePath))
                using (var reqStream = request.GetRequestStream())
                {
                    fileStream.CopyTo(reqStream);
                }
                
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.Created || 
                           response.StatusCode == HttpStatusCode.OK || 
                           response.StatusCode == HttpStatusCode.NoContent;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Sync PUT error: " + ex.Message);
                return false;
            }
        }

        private bool SyncDelete(string remotePath)
        {
            try
            {
                string url = "http://127.0.0.1:18080/webdav/" + Uri.EscapeDataString(remotePath).Replace("%2F", "/");
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "DELETE";
                
                string auth = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes(username + ":" + password));
                request.Headers.Add("Authorization", "Basic " + auth);
                
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.OK || 
                           response.StatusCode == HttpStatusCode.NoContent;
                }
            }
            catch
            {
                return false;
            }
        }

        private bool SyncMove(string oldRemotePath, string newRemotePath)
        {
            try
            {
                string url = "http://127.0.0.1:18080/webdav/" + Uri.EscapeDataString(oldRemotePath).Replace("%2F", "/");
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Method = "MOVE";
                
                string auth = Convert.ToBase64String(System.Text.Encoding.ASCII.GetBytes(username + ":" + password));
                request.Headers.Add("Authorization", "Basic " + auth);
                
                string destUrl = "http://127.0.0.1:18080/webdav/" + Uri.EscapeDataString(newRemotePath).Replace("%2F", "/");
                request.Headers.Add("Destination", destUrl);
                request.Headers.Add("Overwrite", "T");
                
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    return response.StatusCode == HttpStatusCode.Created || 
                           response.StatusCode == HttpStatusCode.NoContent ||
                           response.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private void LoadIndex()
        {
            syncIndex.Clear();
            try
            {
                if (File.Exists(indexFilePath))
                {
                    foreach (var line in File.ReadAllLines(indexFilePath))
                    {
                        var parts = line.Split('|');
                        if (parts.Length == 4)
                        {
                            var state = new SyncState
                            {
                                LocalPath = parts[0],
                                RelativePath = parts[1],
                                LastWriteTicks = long.Parse(parts[2]),
                                FileSize = long.Parse(parts[3])
                            };
                            string key = state.LocalPath + "|" + state.RelativePath;
                            syncIndex[key] = state;
                        }
                    }
                }
            }
            catch {}
        }

        private void SaveIndex()
        {
            try
            {
                string dir = Path.GetDirectoryName(indexFilePath);
                if (!Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                using (var writer = new StreamWriter(indexFilePath))
                {
                    foreach (var state in syncIndex.Values)
                    {
                        writer.WriteLine(string.Format("{0}|{1}|{2}|{3}", 
                            state.LocalPath, state.RelativePath, state.LastWriteTicks, state.FileSize));
                    }
                }
            }
            catch {}
        }

        private void WaitForFileUnlock(string filePath)
        {
            int attempts = 0;
            while (attempts < 20 && isRunning)
            {
                try
                {
                    using (var stream = File.Open(filePath, FileMode.Open, FileAccess.Read, FileShare.None))
                    {
                        return; // File is unlocked
                    }
                }
                catch (IOException)
                {
                    Thread.Sleep(500);
                    attempts++;
                }
            }
        }
    }
}
