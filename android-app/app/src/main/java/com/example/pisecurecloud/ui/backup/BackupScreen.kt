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
import android.content.Intent
import androidx.core.content.FileProvider
import com.example.pisecurecloud.network.NetworkClient
import com.example.pisecurecloud.data.CloudItem
import java.io.File
import java.io.FileOutputStream
import android.os.Environment
import android.provider.MediaStore
import android.content.ContentValues
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll

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

    val scrollState = rememberScrollState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scrollState)
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

        var restoreStatusText by remember { mutableStateOf("") }
        val scope = rememberCoroutineScope()

        Spacer(modifier = Modifier.height(24.dp))
        
        Text("Wiederherstellung", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
        Spacer(modifier = Modifier.height(8.dp))
        
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Sicherungen wiederherstellen", style = MaterialTheme.typography.bodyLarge)
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    "Lade deine gesicherten Kontakte oder Medien zurück auf dieses Gerät.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(16.dp))
                
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Button(
                        onClick = {
                            restoreContacts(context, scope) { text -> restoreStatusText = text }
                        },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary)
                    ) {
                        Text("Kontakte", style = MaterialTheme.typography.bodyMedium)
                    }
                    
                    Button(
                        onClick = {
                            restoreMedia(context, scope) { text -> restoreStatusText = text }
                        },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary)
                    ) {
                        Text("Medien", style = MaterialTheme.typography.bodyMedium)
                    }
                }
                
                if (restoreStatusText.isNotEmpty()) {
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(restoreStatusText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                }
            }
        }
    }
}

private fun getFileFullPath(itemId: String, items: List<CloudItem>): String {
    val item = items.find { it.id == itemId } ?: return ""
    if (item.parentId == "root" || item.parentId.isNullOrBlank()) {
        return item.name
    }
    val parentPath = getFileFullPath(item.parentId, items)
    return if (parentPath.isEmpty()) item.name else "$parentPath/${item.name}"
}

private fun saveFileToDownloads(context: Context, tempFile: File, fileName: String, mimeType: String): Uri? {
    val resolver = context.contentResolver
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val contentValues = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, contentValues)
        if (uri != null) {
            resolver.openOutputStream(uri)?.use { outputStream ->
                tempFile.inputStream().use { inputStream ->
                    inputStream.copyTo(outputStream)
                }
            }
        }
        return uri
    } else {
        try {
            val downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
            val destFile = File(downloadsDir, fileName)
            tempFile.inputStream().use { inputStream ->
                destFile.outputStream().use { outputStream ->
                    inputStream.copyTo(outputStream)
                }
            }
            return Uri.fromFile(destFile)
        } catch (e: Exception) {
            return null
        }
    }
}

private fun restoreContacts(context: Context, scope: CoroutineScope, onStatusChange: (String) -> Unit) {
    onStatusChange("Lese Dateiliste vom Server...")
    scope.launch {
        val result = NetworkClient.fetchFiles()
        if (result.isSuccess) {
            val items = result.getOrNull() ?: emptyList()
            val deviceName = Build.MODEL.replace("\\s+".toRegex(), "_")
            
            // Find contact files
            val contactFiles = items.filter { item ->
                if (item.type != "file" || !item.name.endsWith(".vcf")) false
                else {
                    val fullPath = getFileFullPath(item.id, items)
                    fullPath.startsWith("Backups/$deviceName/Contacts/")
                }
            }.sortedByDescending { it.created ?: "" }
            
            if (contactFiles.isEmpty()) {
                onStatusChange("Keine Kontakt-Sicherungen für dieses Gerät gefunden.")
                Toast.makeText(context, "Kein Backup gefunden", Toast.LENGTH_SHORT).show()
                return@launch
            }
            
            val latestVcf = contactFiles.first()
            onStatusChange("Lade Kontakte herunter (${latestVcf.name})...")
            
            val tempFile = File(context.cacheDir, latestVcf.name)
            val downloadRes = NetworkClient.downloadFile(latestVcf.id, tempFile)
            if (downloadRes.isSuccess) {
                onStatusChange("Starte Import...")
                try {
                    val uri = FileProvider.getUriForFile(
                        context,
                        "com.example.pisecurecloud.fileprovider",
                        tempFile
                    )
                    val intent = Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, "text/vcard")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    context.startActivity(intent)
                    onStatusChange("Sicherung geladen. Import über System-App ausführen.")
                } catch (e: Exception) {
                    onStatusChange("Fehler beim Öffnen des Imports: ${e.message}")
                }
            } else {
                onStatusChange("Fehler beim Herunterladen: ${downloadRes.exceptionOrNull()?.message}")
            }
        } else {
            onStatusChange("Fehler beim Abrufen der Dateiliste.")
        }
    }
}

private fun restoreMedia(context: Context, scope: CoroutineScope, onStatusChange: (String) -> Unit) {
    onStatusChange("Lese Dateiliste vom Server...")
    scope.launch {
        val result = NetworkClient.fetchFiles()
        if (result.isSuccess) {
            val items = result.getOrNull() ?: emptyList()
            val deviceName = Build.MODEL.replace("\\s+".toRegex(), "_")
            
            // Find media files
            val mediaFiles = items.filter { item ->
                if (item.type != "file") false
                else {
                    val fullPath = getFileFullPath(item.id, items)
                    fullPath.startsWith("Backups/$deviceName/Media/")
                }
            }
            
            if (mediaFiles.isEmpty()) {
                onStatusChange("Keine Medien-Sicherungen für dieses Gerät gefunden.")
                Toast.makeText(context, "Kein Backup gefunden", Toast.LENGTH_SHORT).show()
                return@launch
            }
            
            onStatusChange("Lade ${mediaFiles.size} Medien-Dateien in den Downloads-Ordner herunter...")
            var successCount = 0
            var failCount = 0
            
            for ((index, media) in mediaFiles.withIndex()) {
                onStatusChange("Lade herunter (${index + 1}/${mediaFiles.size}): ${media.name}")
                val tempFile = File(context.cacheDir, media.name)
                val downloadRes = NetworkClient.downloadFile(media.id, tempFile)
                if (downloadRes.isSuccess) {
                    val savedUri = saveFileToDownloads(context, tempFile, media.name, media.mimeType ?: "application/octet-stream")
                    tempFile.delete()
                    if (savedUri != null) {
                        successCount++
                    } else {
                        failCount++
                    }
                } else {
                    tempFile.delete()
                    failCount++
                }
            }
            
            onStatusChange("Fertig! $successCount Medien in den Downloads-Ordner geladen." + 
                if (failCount > 0) " ($failCount fehlgeschlagen)" else "")
            Toast.makeText(context, "Medien-Wiederherstellung abgeschlossen", Toast.LENGTH_LONG).show()
        } else {
            onStatusChange("Fehler beim Abrufen der Dateiliste.")
        }
    }
}
