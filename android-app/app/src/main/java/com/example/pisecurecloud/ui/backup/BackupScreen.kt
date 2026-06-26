package com.example.pisecurecloud.ui.backup

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.example.pisecurecloud.worker.BackupWorker

@Composable
fun BackupScreen() {
    val context = LocalContext.current
    val sharedPrefs = remember {
        context.getSharedPreferences("pisecurecloud_prefs", Context.MODE_PRIVATE)
    }

    var backupPhotos by remember { mutableStateOf(sharedPrefs.getBoolean("backup_photos", false)) }
    var backupVideos by remember { mutableStateOf(sharedPrefs.getBoolean("backup_videos", false)) }
    var backupContacts by remember { mutableStateOf(sharedPrefs.getBoolean("backup_contacts", false)) }
    var lastBackupTime by remember { mutableStateOf(sharedPrefs.getString("last_backup_time", "Noch nie") ?: "Noch nie") }
    var backupStatusText by remember { mutableStateOf("") }
    var isBackingUp by remember { mutableStateOf(false) }

    val workManager = remember { WorkManager.getInstance(context) }

    // Launcher for requesting permissions
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val photosGranted = permissions[Manifest.permission.READ_MEDIA_IMAGES] ?: false ||
                permissions[Manifest.permission.READ_EXTERNAL_STORAGE] ?: false
        val videosGranted = permissions[Manifest.permission.READ_MEDIA_VIDEO] ?: false
        val contactsGranted = permissions[Manifest.permission.READ_CONTACTS] ?: false

        if (photosGranted) {
            backupPhotos = true
            sharedPrefs.edit().putBoolean("backup_photos", true).apply()
        }
        if (videosGranted) {
            backupVideos = true
            sharedPrefs.edit().putBoolean("backup_videos", true).apply()
        }
        if (contactsGranted) {
            backupContacts = true
            sharedPrefs.edit().putBoolean("backup_contacts", true).apply()
        }
    }

    fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Top,
        horizontalAlignment = Alignment.Start
    ) {
        Text("Handy-Backup", style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.primary)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "Sichere deine Fotos, Videos und Kontakte automatisch in deiner verschlüsselten PiSecureCloud.",
            style = MaterialTheme.typography.bodyMedium
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Photos Switch
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Bilder sichern", style = MaterialTheme.typography.bodyLarge)
                Text("Sichert alle lokalen Fotos", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(
                checked = backupPhotos,
                onCheckedChange = { checked ->
                    if (checked) {
                        val required = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            arrayOf(Manifest.permission.READ_MEDIA_IMAGES)
                        } else {
                            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
                        }
                        if (required.all { hasPermission(it) }) {
                            backupPhotos = true
                            sharedPrefs.edit().putBoolean("backup_photos", true).apply()
                        } else {
                            permissionLauncher.launch(required)
                        }
                    } else {
                        backupPhotos = false
                        sharedPrefs.edit().putBoolean("backup_photos", false).apply()
                    }
                }
            )
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        // Videos Switch
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Videos sichern", style = MaterialTheme.typography.bodyLarge)
                Text("Sichert alle lokalen Videos", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(
                checked = backupVideos,
                onCheckedChange = { checked ->
                    if (checked) {
                        val required = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            arrayOf(Manifest.permission.READ_MEDIA_VIDEO)
                        } else {
                            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
                        }
                        if (required.all { hasPermission(it) }) {
                            backupVideos = true
                            sharedPrefs.edit().putBoolean("backup_videos", true).apply()
                        } else {
                            permissionLauncher.launch(required)
                        }
                    } else {
                        backupVideos = false
                        sharedPrefs.edit().putBoolean("backup_videos", false).apply()
                    }
                }
            )
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        // Contacts Switch
        Row(
            modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Kontakte sichern", style = MaterialTheme.typography.bodyLarge)
                Text("Exportiert und sichert Telefonkontakte als vCard", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(
                checked = backupContacts,
                onCheckedChange = { checked ->
                    if (checked) {
                        if (hasPermission(Manifest.permission.READ_CONTACTS)) {
                            backupContacts = true
                            sharedPrefs.edit().putBoolean("backup_contacts", true).apply()
                        } else {
                            permissionLauncher.launch(arrayOf(Manifest.permission.READ_CONTACTS))
                        }
                    } else {
                        backupContacts = false
                        sharedPrefs.edit().putBoolean("backup_contacts", false).apply()
                    }
                }
            )
        }

        Spacer(modifier = Modifier.height(40.dp))

        // Last Backup Info Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Backup-Status", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                Spacer(modifier = Modifier.height(8.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text("Letzte Sicherung:", style = MaterialTheme.typography.bodyMedium)
                    Text(lastBackupTime, style = MaterialTheme.typography.bodyMedium)
                }
                if (backupStatusText.isNotEmpty()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(backupStatusText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                }
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        if (isBackingUp) {
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    CircularProgressIndicator()
                    Spacer(modifier = Modifier.height(8.dp))
                    Text("Sicherung wird ausgeführt...", style = MaterialTheme.typography.bodySmall)
                }
            }
        } else {
            Button(
                onClick = {
                    if (!backupPhotos && !backupVideos && !backupContacts) {
                        Toast.makeText(context, "Bitte aktiviere mindestens eine Option zum Sichern.", Toast.LENGTH_SHORT).show()
                        return@Button
                    }
                    
                    isBackingUp = true
                    backupStatusText = "Initialisiere..."
                    
                    val workRequest = OneTimeWorkRequestBuilder<BackupWorker>().build()
                    workManager.enqueue(workRequest)

                    // Observe progress
                    workManager.getWorkInfoByIdLiveData(workRequest.id).observeForever { workInfo ->
                        if (workInfo != null) {
                            when (workInfo.state) {
                                WorkInfo.State.SUCCEEDED -> {
                                    isBackingUp = false
                                    lastBackupTime = sharedPrefs.getString("last_backup_time", "Jetzt gerade") ?: "Jetzt gerade"
                                    backupStatusText = "Sicherung erfolgreich abgeschlossen!"
                                }
                                WorkInfo.State.FAILED -> {
                                    isBackingUp = false
                                    backupStatusText = "Fehler bei der Sicherung."
                                }
                                WorkInfo.State.RUNNING -> {
                                    backupStatusText = "Sicherungsdaten werden hochgeladen..."
                                }
                                else -> {}
                            }
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Backup jetzt starten")
            }
        }
    }
}
