package com.example.pisecurecloud.ui.files

import android.content.Context
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Create
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.example.pisecurecloud.data.CloudItem
import com.example.pisecurecloud.network.NetworkClient
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileOutputStream

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var allItems by remember { mutableStateOf<List<CloudItem>>(emptyList()) }
    var currentFolderId by remember { mutableStateOf("root") }
    var currentFolderName by remember { mutableStateOf("Hauptverzeichnis") }
    var folderStack by remember { mutableStateOf(listOf(Pair("root", "Hauptverzeichnis"))) }

    var isLoading by remember { mutableStateOf(false) }
    var showCreateDirDialog by remember { mutableStateOf(false) }
    var newDirName by remember { mutableStateOf("") }

    suspend fun loadFiles() {
        isLoading = true
        val result = NetworkClient.fetchFiles()
        isLoading = false
        if (result.isSuccess) {
            allItems = result.getOrNull() ?: emptyList()
        } else {
            Toast.makeText(context, "Fehler beim Laden der Dateien", Toast.LENGTH_SHORT).show()
        }
    }

    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        if (uri != null) {
            scope.launch {
                isLoading = true
                val result = uploadUriFile(context, uri, currentFolderId)
                isLoading = false
                if (result.isSuccess) {
                    Toast.makeText(context, "Datei erfolgreich hochgeladen", Toast.LENGTH_SHORT).show()
                    loadFiles()
                } else {
                    Toast.makeText(context, "Fehler beim Upload: ${result.exceptionOrNull()?.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    LaunchedEffect(Unit) {
        loadFiles()
    }

    val currentItems = allItems.filter { it.parentId == currentFolderId }

    Scaffold(
        floatingActionButton = {
            Column(horizontalAlignment = Alignment.End) {
                FloatingActionButton(
                    onClick = { showCreateDirDialog = true },
                    containerColor = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.padding(bottom = 8.dp)
                ) {
                    Icon(Icons.Filled.Create, contentDescription = "Ordner erstellen")
                }
                FloatingActionButton(
                    onClick = { filePickerLauncher.launch("*/*") }
                ) {
                    Icon(Icons.Filled.Add, contentDescription = "Datei hochladen")
                }
            }
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)
            ) {
                if (currentFolderId != "root") {
                    IconButton(onClick = {
                        val newStack = folderStack.toMutableList()
                        if (newStack.size > 1) {
                            newStack.removeAt(newStack.size - 1)
                            val parent = newStack.last()
                            currentFolderId = parent.first
                            currentFolderName = parent.second
                            folderStack = newStack
                        }
                    }) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Zurück")
                    }
                }
                Text(
                    text = currentFolderName,
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.padding(start = 8.dp)
                )
            }

            if (isLoading) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else if (currentItems.isEmpty()) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("Dieser Ordner ist leer.", style = MaterialTheme.typography.bodyMedium)
                }
            } else {
                LazyColumn {
                    items(currentItems) { item ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    if (item.type == "dir") {
                                        currentFolderId = item.id
                                        currentFolderName = item.name
                                        folderStack = folderStack + Pair(item.id, item.name)
                                    } else {
                                        Toast.makeText(context, "Vorschau für '${item.name}' wird auf Android bald unterstützt.", Toast.LENGTH_SHORT).show()
                                    }
                                }
                                .padding(vertical = 12.dp, horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            val icon = if (item.type == "dir") "📁" else "📄"
                            Text(
                                text = icon,
                                style = MaterialTheme.typography.titleLarge,
                                modifier = Modifier.padding(end = 16.dp)
                            )
                            Column {
                                Text(item.name, style = MaterialTheme.typography.bodyLarge)
                                if (item.type == "file") {
                                    Text(
                                        text = "${formatFileSize(item.size)} | ${item.created?.take(10) ?: ""}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        }
    }

    if (showCreateDirDialog) {
        AlertDialog(
            onDismissRequest = { showCreateDirDialog = false },
            title = { Text("Neuer Ordner") },
            text = {
                OutlinedTextField(
                    value = newDirName,
                    onValueChange = { newDirName = it },
                    label = { Text("Ordnername") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (newDirName.isNotBlank()) {
                            scope.launch {
                                isLoading = true
                                val result = NetworkClient.createDirectory(newDirName, currentFolderId)
                                isLoading = false
                                showCreateDirDialog = false
                                newDirName = ""
                                if (result.isSuccess) {
                                    Toast.makeText(context, "Ordner erstellt", Toast.LENGTH_SHORT).show()
                                    loadFiles()
                                } else {
                                    Toast.makeText(context, "Fehler: ${result.exceptionOrNull()?.message}", Toast.LENGTH_SHORT).show()
                                }
                            }
                        }
                    }
                ) {
                    Text("Erstellen")
                }
            },
            dismissButton = {
                TextButton(onClick = { showCreateDirDialog = false }) {
                    Text("Abbrechen")
                }
            }
        )
    }
}

private suspend fun uploadUriFile(context: Context, uri: Uri, parentId: String): Result<Boolean> {
    return runCatching {
        val contentResolver = context.contentResolver
        val fileName = getUriFileName(contentResolver, uri) ?: "upload_file"
        val tempFile = File(context.cacheDir, fileName)
        
        contentResolver.openInputStream(uri)?.use { inputStream ->
            FileOutputStream(tempFile).use { outputStream ->
                inputStream.copyTo(outputStream)
            }
        }
        
        val mimeType = contentResolver.getType(uri) ?: "application/octet-stream"
        val result = NetworkClient.uploadFile(tempFile, parentId, null, mimeType)
        tempFile.delete()
        result.getOrThrow()
    }
}

private fun getUriFileName(contentResolver: android.content.ContentResolver, uri: Uri): String? {
    var name: String? = null
    val cursor = contentResolver.query(uri, null, null, null, null)
    cursor?.use {
        if (it.moveToFirst()) {
            val nameIndex = it.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (nameIndex >= 0) {
                name = it.getString(nameIndex)
            }
        }
    }
    return name
}

private fun formatFileSize(size: Long): String {
    if (size <= 0) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    val digitGroups = (Math.log10(size.toDouble()) / Math.log10(1024.0)).toInt()
    return String.format("%.1f %s", size / Math.pow(1024.0, digitGroups.toDouble()), units[digitGroups])
}
