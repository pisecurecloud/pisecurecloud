using System;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;
using System.Diagnostics;
using System.Linq;
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

        private Panel pnlForm;
        private Label lblBucketId;
        private TextBox txtBucketId;
        private Label lblUsername;
        private TextBox txtUsername;
        private Label lblPassword;
        private TextBox txtPassword;
        private Label lblDriveLetter;
        private ComboBox cmbDriveLetter;
        private Button btnConnect;
        private Button btnDisconnect;

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
            this.Size = new Size(400, 520);
            this.FormBorderStyle = FormBorderStyle.FixedSingle;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Icon = SystemIcons.Application;

            // Title
            lblTitle = new Label();
            lblTitle.Text = "PiSecureCloud";
            lblTitle.Location = new Point(20, 20);
            lblTitle.Size = new Size(340, 30);
            lblTitle.Font = new Font("Segoe UI", 16f, FontStyle.Bold);
            this.Controls.Add(lblTitle);

            // Subtitle
            lblSubtitle = new Label();
            lblSubtitle.Text = "Windows Laufwerk-Integration";
            lblSubtitle.Location = new Point(20, 50);
            lblSubtitle.Size = new Size(340, 20);
            lblSubtitle.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            this.Controls.Add(lblSubtitle);

            // Registry Warning Panel
            pnlRegistryWarning = new Panel();
            pnlRegistryWarning.Location = new Point(20, 75);
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

            // Form Panel
            pnlForm = new Panel();
            pnlForm.Size = new Size(345, 290);
            this.Controls.Add(pnlForm);

            // Bucket ID
            lblBucketId = new Label();
            lblBucketId.Text = "Verbindungs-ID (Bucket-ID)";
            lblBucketId.Location = new Point(0, 0);
            lblBucketId.Size = new Size(345, 18);
            pnlForm.Controls.Add(lblBucketId);

            txtBucketId = new TextBox();
            txtBucketId.Location = new Point(0, 18);
            txtBucketId.Size = new Size(345, 25);
            pnlForm.Controls.Add(txtBucketId);

            // Username
            lblUsername = new Label();
            lblUsername.Text = "Benutzername";
            lblUsername.Location = new Point(0, 55);
            lblUsername.Size = new Size(345, 18);
            pnlForm.Controls.Add(lblUsername);

            txtUsername = new TextBox();
            txtUsername.Location = new Point(0, 73);
            txtUsername.Size = new Size(345, 25);
            pnlForm.Controls.Add(txtUsername);

            // Password
            lblPassword = new Label();
            lblPassword.Text = "Passwort";
            lblPassword.Location = new Point(0, 110);
            lblPassword.Size = new Size(345, 18);
            pnlForm.Controls.Add(lblPassword);

            txtPassword = new TextBox();
            txtPassword.Location = new Point(0, 128);
            txtPassword.Size = new Size(345, 25);
            txtPassword.UseSystemPasswordChar = true;
            pnlForm.Controls.Add(txtPassword);

            // Drive Letter
            lblDriveLetter = new Label();
            lblDriveLetter.Text = "Laufwerksbuchstabe";
            lblDriveLetter.Location = new Point(0, 165);
            lblDriveLetter.Size = new Size(345, 18);
            pnlForm.Controls.Add(lblDriveLetter);

            cmbDriveLetter = new ComboBox();
            cmbDriveLetter.Location = new Point(0, 183);
            cmbDriveLetter.Size = new Size(345, 25);
            cmbDriveLetter.DropDownStyle = ComboBoxStyle.DropDownList;
            PopulateDriveLetters();
            pnlForm.Controls.Add(cmbDriveLetter);

            // Connect Button
            btnConnect = new Button();
            btnConnect.Text = "Verbinden";
            btnConnect.Location = new Point(0, 235);
            btnConnect.Size = new Size(160, 42);
            btnConnect.Click += new EventHandler(this.BtnConnect_Click);
            pnlForm.Controls.Add(btnConnect);

            // Disconnect Button
            btnDisconnect = new Button();
            btnDisconnect.Text = "Trennen";
            btnDisconnect.Location = new Point(185, 235);
            btnDisconnect.Size = new Size(160, 42);
            btnDisconnect.Enabled = false;
            btnDisconnect.Click += new EventHandler(this.BtnDisconnect_Click);
            pnlForm.Controls.Add(btnDisconnect);

            // Status Label
            lblStatus = new Label();
            lblStatus.Text = "Status: Nicht verbunden";
            lblStatus.Location = new Point(20, 430);
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
            lblStatus.ForeColor = Color.FromArgb(239, 68, 68); // Red 500 (Disconnected)

            pnlForm.BackColor = Color.Transparent;

            foreach (Control c in pnlForm.Controls)
            {
                if (c is Label)
                {
                    c.ForeColor = Color.FromArgb(209, 213, 219); // Gray 300
                    c.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
                }
                else if (c is TextBox || c is ComboBox)
                {
                    c.BackColor = Color.FromArgb(31, 41, 55); // Gray 800
                    c.ForeColor = Color.White;
                    c.Font = new Font("Segoe UI", 10f, FontStyle.Regular);
                    if (c is TextBox)
                    {
                        ((TextBox)c).BorderStyle = BorderStyle.FixedSingle;
                    }
                }
            }

            pnlRegistryWarning.BackColor = Color.FromArgb(55, 48, 163); // Indigo 900
            lblWarningText.ForeColor = Color.FromArgb(224, 231, 255); // Indigo 100
            btnEnableWarning.BackColor = Color.FromArgb(99, 102, 241); // Indigo 500
            btnEnableWarning.ForeColor = Color.White;
            btnEnableWarning.FlatStyle = FlatStyle.Flat;
            btnEnableWarning.FlatAppearance.BorderSize = 0;
            btnEnableWarning.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);

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
        }

        private void UpdateLayout()
        {
            if (pnlRegistryWarning.Visible)
            {
                pnlForm.Location = new Point(20, 150);
                lblStatus.Location = new Point(20, 465);
                this.ClientSize = new Size(385, 500);
            }
            else
            {
                pnlForm.Location = new Point(20, 80);
                lblStatus.Location = new Point(20, 395);
                this.ClientSize = new Size(385, 430);
            }
        }

        private void PopulateDriveLetters()
        {
            cmbDriveLetter.Items.Clear();
            var activeDrives = DriveInfo.GetDrives().Select(d => d.Name.Substring(0, 2)).ToList();
            
            // Standard WebDAV drive letters to suggest
            char[] suggestions = { 'P', 'S', 'Z', 'Y', 'X', 'W', 'V', 'T', 'O', 'N', 'M', 'L', 'K' };
            foreach (char c in suggestions)
            {
                string d = c + ":";
                if (!activeDrives.Contains(d))
                {
                    cmbDriveLetter.Items.Add(d);
                }
            }
            
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
            lblStatus.ForeColor = Color.FromArgb(245, 158, 11); // Amber (Connecting)

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

            // Mount network drive
            ThreadPool.QueueUserWorkItem((state) =>
            {
                bool success = MountDrive(driveLetter, username, password);
                
                this.Invoke((MethodInvoker)delegate
                {
                    if (success)
                    {
                        activeDrive = driveLetter;
                        lblStatus.Text = "Status: Verbunden auf Laufwerk " + driveLetter;
                        lblStatus.ForeColor = Color.FromArgb(16, 185, 129); // Emerald (Connected)
                        btnDisconnect.Enabled = true;
                        
                        // Open Explorer
                        try
                        {
                            Process.Start("explorer.exe", driveLetter);
                        }
                        catch {}
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
            try
            {
                using (var client = new WebClient())
                {
                    // Fetch url hex representation
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
                psi.Arguments = string.Format("/c net use {0} http://127.0.0.1:18080/ \"{1}\" /user:\"{2}\" /persistent:no", driveLetter, password, username);
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.RedirectStandardError = true;
                psi.RedirectStandardOutput = true;

                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit();
                    string err = p.StandardError.ReadToEnd();
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
                trayIcon.ShowBalloonTip(3000, "PiSecureCloud aktiv", "Das Laufwerk bleibt verbunden. Doppel-Klick auf das Tray-Icon zum Wiederherstellen.", ToolTipIcon.Info);
            }
            else
            {
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
}
