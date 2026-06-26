package com.example.pisecurecloud.worker

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.example.pisecurecloud.network.NetworkClient
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class BackupWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "BackupWorker"
    }

    override suspend fun doWork(): Result {
        Log.d(TAG, "Starting backup work...")
        val sharedPrefs = applicationContext.getSharedPreferences("pisecurecloud_prefs", Context.MODE_PRIVATE)

        val serverUrl = sharedPrefs.getString("server_url", null)
        val username = sharedPrefs.getString("username", null)
        val password = sharedPrefs.getString("password", null)

        if (serverUrl.isNullOrBlank() || username.isNullOrBlank() || password.isNullOrBlank()) {
            Log.e(TAG, "Missing credentials, aborting backup")
            return Result.failure()
        }

        // 1. Authenticate with server
        NetworkClient.setServerUrl(serverUrl)
        val loginResult = NetworkClient.login(username, password)
        if (loginResult.isFailure) {
            Log.e(TAG, "Auth failed: ${loginResult.exceptionOrNull()?.message}")
            return Result.failure()
        }

        val deviceName = Build.MODEL.replace("\\s+".toRegex(), "_")
        val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())

        val backupPhotos = sharedPrefs.getBoolean("backup_photos", false)
        val backupVideos = sharedPrefs.getBoolean("backup_videos", false)
        val backupContacts = sharedPrefs.getBoolean("backup_contacts", false)

        var hasError = false

        // 2. Perform Contacts Backup
        if (backupContacts) {
            try {
                Log.d(TAG, "Backing up contacts...")
                val vCardData = getContactsVCard(applicationContext)
                if (vCardData.isNotEmpty()) {
                    val tempFile = File(applicationContext.cacheDir, "contacts_$timestamp.vcf")
                    FileOutputStream(tempFile).use { fos ->
                        fos.write(vCardData.toByteArray())
                    }
                    val path = "Backups/$deviceName/Contacts/contacts_$timestamp.vcf"
                    val uploadRes = NetworkClient.uploadFile(tempFile, null, path, "text/vcard")
                    tempFile.delete()
                    if (uploadRes.isFailure) {
                        Log.e(TAG, "Failed to upload contacts")
                        hasError = true
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error backing up contacts", e)
                hasError = true
            }
        }

        // 3. Fetch current files to avoid duplicate uploads
        val filesResult = NetworkClient.fetchFiles()
        val existingFileNames = HashSet<String>()
        if (filesResult.isSuccess) {
            filesResult.getOrNull()?.filter { it.type == "file" }?.forEach {
                existingFileNames.add(it.name)
            }
        }

        // 4. Perform Media Backup (Photos & Videos)
        val mediaFilesToBackup = ArrayList<MediaFileInfo>()
        if (backupPhotos) {
            mediaFilesToBackup.addAll(getMediaFiles(applicationContext, isVideo = false))
        }
        if (backupVideos) {
            mediaFilesToBackup.addAll(getMediaFiles(applicationContext, isVideo = true))
        }

        Log.d(TAG, "Found ${mediaFilesToBackup.size} media files on device. Uploading non-duplicates...")
        for (media in mediaFilesToBackup) {
            // Check if file is already backed up based on filename
            if (existingFileNames.contains(media.name)) {
                // Skip duplicate
                continue
            }

            try {
                val path = "Backups/$deviceName/Media/${media.name}"
                val uploadRes = NetworkClient.uploadFile(media.file, null, path, media.mimeType)
                if (uploadRes.isFailure) {
                    Log.e(TAG, "Failed to upload media file ${media.name}")
                    hasError = true
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error uploading media file ${media.name}", e)
                hasError = true
            }
        }

        if (hasError) {
            return Result.failure()
        }

        // Save last backup timestamp
        val dateString = SimpleDateFormat("dd.MM.yyyy HH:mm", Locale.getDefault()).format(Date())
        sharedPrefs.edit().putString("last_backup_time", dateString).apply()

        Log.d(TAG, "Backup work completed successfully")
        return Result.success()
    }

    private fun getContactsVCard(context: Context): String {
        val builder = java.lang.StringBuilder()
        val cursor = context.contentResolver.query(
            android.provider.ContactsContract.Contacts.CONTENT_URI,
            null, null, null, null
        )
        cursor?.use {
            val idCol = it.getColumnIndex(android.provider.ContactsContract.Contacts._ID)
            val nameCol = it.getColumnIndex(android.provider.ContactsContract.Contacts.DISPLAY_NAME)
            while (it.moveToNext()) {
                val id = if (idCol >= 0) it.getString(idCol) else ""
                val name = if (nameCol >= 0) it.getString(nameCol) else ""
                
                builder.append("BEGIN:VCARD\n")
                builder.append("VERSION:3.0\n")
                builder.append("FN:$name\n")
                
                val phones = context.contentResolver.query(
                    android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    null,
                    android.provider.ContactsContract.CommonDataKinds.Phone.CONTACT_ID + " = ?",
                    arrayOf(id),
                    null
                )
                phones?.use { p ->
                    val numCol = p.getColumnIndex(android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER)
                    while (p.moveToNext()) {
                        val number = if (numCol >= 0) p.getString(numCol) else ""
                        builder.append("TEL;TYPE=CELL:$number\n")
                    }
                }
                builder.append("END:VCARD\n")
            }
        }
        return builder.toString()
    }

    private fun getMediaFiles(context: Context, isVideo: Boolean): List<MediaFileInfo> {
        val files = ArrayList<MediaFileInfo>()
        val uri = if (isVideo) {
            android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        } else {
            android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        }
        val projection = arrayOf(
            android.provider.MediaStore.MediaColumns.DATA,
            android.provider.MediaStore.MediaColumns.DISPLAY_NAME,
            android.provider.MediaStore.MediaColumns.MIME_TYPE,
            android.provider.MediaStore.MediaColumns.SIZE
        )
        
        try {
            val cursor = context.contentResolver.query(uri, projection, null, null, null)
            cursor?.use {
                val dataCol = it.getColumnIndexOrThrow(android.provider.MediaStore.MediaColumns.DATA)
                val nameCol = it.getColumnIndexOrThrow(android.provider.MediaStore.MediaColumns.DISPLAY_NAME)
                val mimeCol = it.getColumnIndexOrThrow(android.provider.MediaStore.MediaColumns.MIME_TYPE)
                val sizeCol = it.getColumnIndexOrThrow(android.provider.MediaStore.MediaColumns.SIZE)
                while (it.moveToNext()) {
                    val path = it.getString(dataCol)
                    val name = it.getString(nameCol)
                    val mime = it.getString(mimeCol)
                    val size = it.getLong(sizeCol)
                    if (path != null && name != null) {
                        val file = File(path)
                        if (file.exists()) {
                            files.add(MediaFileInfo(file, name, mime ?: "application/octet-stream", size))
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error reading MediaStore", e)
        }
        return files
    }

    private data class MediaFileInfo(val file: File, val name: String, val mimeType: String, val size: Long)
}
