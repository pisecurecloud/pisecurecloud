package com.example.pisecurecloud.network

import android.util.Log
import com.example.pisecurecloud.data.CloudItem
import com.example.pisecurecloud.data.LoginResponse
import com.example.pisecurecloud.data.UploadResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.concurrent.TimeUnit

object NetworkClient {
    private const val TAG = "NetworkClient"

    private val json = Json { ignoreUnknownKeys = true }
    private val cookieJar = object : CookieJar {
        private val cookieStore = HashMap<String, List<Cookie>>()

        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            cookieStore[url.host] = cookies
            Log.d(TAG, "Saved cookies for host ${url.host}: ${cookies.map { it.name }}")
        }

        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val cookies = cookieStore[url.host] ?: ArrayList()
            return cookies
        }
    }

    private val client = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.MINUTES) // high timeout for large uploads/downloads
        .writeTimeout(10, TimeUnit.MINUTES)
        .build()

    private var lastUsername: String? = null
    private var lastPassword: String? = null
    var configuredServerUrl: String? = null
    var baseUrl: String = "http://10.0.2.2:3000" // default for Android Emulator to localhost

    fun setServerUrl(url: String, originalInput: String? = null) {
        baseUrl = if (url.endsWith("/")) url.removeSuffix("/") else url
        if (originalInput != null) {
            configuredServerUrl = originalInput
        }
    }

    private suspend fun resolveBucketUrl(bucketId: String): String? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("https://keyvalue.immanuel.co/api/KeyVal/GetValue/$bucketId/url")
                .build()
            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    val hexJson = response.body?.string() ?: return@use null
                    val hexStr = Json.parseToJsonElement(hexJson).jsonPrimitive.content
                    
                    // Decode hex to string
                    val bytes = ByteArray(hexStr.length / 2)
                    for (i in bytes.indices) {
                        val index = i * 2
                        val j = hexStr.substring(index, index + 2).toInt(16)
                        bytes[i] = j.toByte()
                    }
                    String(bytes, Charsets.UTF_8)
                } else {
                    null
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to resolve bucket URL", e)
            null
        }
    }

    private suspend fun autoHealUrlAndRetry(): Boolean {
        val bucketId = configuredServerUrl ?: return false
        if (bucketId.startsWith("http://") || bucketId.startsWith("https://")) {
            return false
        }
        Log.d(TAG, "Attempting auto-heal for Bucket ID: $bucketId")
        val newUrl = resolveBucketUrl(bucketId)
        if (newUrl != null && newUrl != baseUrl) {
            Log.d(TAG, "Auto-healed URL from $baseUrl to $newUrl")
            setServerUrl(newUrl)
            
            // Re-login to the new URL if we have saved credentials
            val user = lastUsername
            val pass = lastPassword
            if (user != null && pass != null) {
                Log.d(TAG, "Re-authenticating on the new URL...")
                val loginRes = login(user, pass)
                if (loginRes.isSuccess) {
                    Log.d(TAG, "Re-authentication successful")
                    return true
                } else {
                    Log.e(TAG, "Re-authentication failed: ${loginRes.exceptionOrNull()?.message}")
                }
            } else {
                return true
            }
        }
        return false
    }

    suspend fun login(username: String, password: String): Result<LoginResponse> = withContext(Dispatchers.IO) {
        lastUsername = username
        lastPassword = password
        try {
            val jsonMediaType = "application/json; charset=utf-8".toMediaType()
            val requestBody = "{\"username\":\"$username\",\"password\":\"$password\"}".toRequestBody(jsonMediaType)
            val request = Request.Builder()
                .url("$baseUrl/api/login")
                .post(requestBody)
                .build()

            client.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                Log.d(TAG, "Login response body: $bodyStr")
                if (response.isSuccessful) {
                    val loginRes = json.decodeFromString<LoginResponse>(bodyStr)
                    Result.success(loginRes)
                } else {
                    val errMsg = try {
                        json.decodeFromString<LoginResponse>(bodyStr).error ?: "Login failed"
                    } catch (e: Exception) {
                        "HTTP ${response.code}: $bodyStr"
                    }
                    Result.failure(Exception(errMsg))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Login error", e)
            Result.failure(e)
        }
    }

    suspend fun fetchFiles(): Result<List<CloudItem>> = withContext(Dispatchers.IO) {
        var attempt = 1
        var lastErr: Exception? = null
        while (attempt <= 2) {
            try {
                val request = Request.Builder()
                    .url("$baseUrl/api/files")
                    .get()
                    .build()

                client.newCall(request).execute().use { response ->
                    val bodyStr = response.body?.string() ?: ""
                    if (response.isSuccessful) {
                        val items = json.decodeFromString<List<CloudItem>>(bodyStr)
                        return@withContext Result.success(items)
                    } else {
                        throw Exception("HTTP ${response.code}: $bodyStr")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Fetch files error (attempt $attempt)", e)
                lastErr = e
                if (attempt == 1 && autoHealUrlAndRetry()) {
                    attempt++
                } else {
                    break
                }
            }
        }
        Result.failure(lastErr ?: Exception("Unknown error"))
    }

    suspend fun createDirectory(name: String, parentId: String): Result<Boolean> = withContext(Dispatchers.IO) {
        var attempt = 1
        var lastErr: Exception? = null
        while (attempt <= 2) {
            try {
                val jsonMediaType = "application/json; charset=utf-8".toMediaType()
                val requestBody = "{\"name\":\"$name\",\"parentId\":\"$parentId\"}".toRequestBody(jsonMediaType)
                val request = Request.Builder()
                    .url("$baseUrl/api/mkdir")
                    .post(requestBody)
                    .build()

                client.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        return@withContext Result.success(true)
                    } else {
                        val bodyStr = response.body?.string() ?: ""
                        throw Exception("HTTP ${response.code}: $bodyStr")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Create directory error (attempt $attempt)", e)
                lastErr = e
                if (attempt == 1 && autoHealUrlAndRetry()) {
                    attempt++
                } else {
                    break
                }
            }
        }
        Result.failure(lastErr ?: Exception("Unknown error"))
    }

    suspend fun uploadFile(
        file: File,
        parentId: String?,
        relativePath: String? = null,
        mimeType: String = "application/octet-stream"
    ): Result<Boolean> = withContext(Dispatchers.IO) {
        var attempt = 1
        var lastErr: Exception? = null
        while (attempt <= 2) {
            try {
                val fileBody = file.asRequestBody(mimeType.toMediaType())
                val requestBodyBuilder = MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("file", file.name, fileBody)

                if (parentId != null) {
                    requestBodyBuilder.addFormDataPart("parentId", parentId)
                }
                if (relativePath != null) {
                    requestBodyBuilder.addFormDataPart("relativePath", relativePath)
                }

                val request = Request.Builder()
                    .url("$baseUrl/api/upload")
                    .post(requestBodyBuilder.build())
                    .build()

                client.newCall(request).execute().use { response ->
                    val bodyStr = response.body?.string() ?: ""
                    Log.d(TAG, "Upload response: $bodyStr")
                    if (response.isSuccessful) {
                        return@withContext Result.success(true)
                    } else {
                        val errMsg = try {
                            json.decodeFromString<UploadResponse>(bodyStr).error ?: "Upload failed"
                        } catch (e: Exception) {
                            "HTTP ${response.code}: $bodyStr"
                        }
                        throw Exception(errMsg)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Upload error (attempt $attempt)", e)
                lastErr = e
                if (attempt == 1 && autoHealUrlAndRetry()) {
                    attempt++
                } else {
                    break
                }
            }
        }
        Result.failure(lastErr ?: Exception("Unknown error"))
    }

    suspend fun downloadFile(fileId: String, outputFile: File): Result<Boolean> = withContext(Dispatchers.IO) {
        var attempt = 1
        var lastErr: Exception? = null
        while (attempt <= 2) {
            try {
                val request = Request.Builder()
                    .url("$baseUrl/api/download/$fileId")
                    .get()
                    .build()

                client.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        response.body?.byteStream()?.use { inputStream ->
                            outputFile.outputStream().use { outputStream ->
                                inputStream.copyTo(outputStream)
                            }
                        }
                        return@withContext Result.success(true)
                    } else {
                        val bodyStr = response.body?.string() ?: ""
                        throw Exception("HTTP ${response.code}: $bodyStr")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Download file error (attempt $attempt)", e)
                lastErr = e
                if (attempt == 1 && autoHealUrlAndRetry()) {
                    attempt++
                } else {
                    break
                }
            }
        }
        Result.failure(lastErr ?: Exception("Unknown error"))
    }
}
