package com.example.pisecurecloud.network

import android.util.Log
import com.example.pisecurecloud.data.CloudItem
import com.example.pisecurecloud.data.LoginResponse
import com.example.pisecurecloud.data.UploadResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
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

    var baseUrl: String = "http://10.0.2.2:3000" // default for Android Emulator to localhost

    fun setServerUrl(url: String) {
        baseUrl = if (url.endsWith("/")) url.removeSuffix("/") else url
    }

    suspend fun login(username: String, password: String): Result<LoginResponse> = withContext(Dispatchers.IO) {
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
        try {
            val request = Request.Builder()
                .url("$baseUrl/api/files")
                .get()
                .build()

            client.newCall(request).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (response.isSuccessful) {
                    val items = json.decodeFromString<List<CloudItem>>(bodyStr)
                    Result.success(items)
                } else {
                    Result.failure(Exception("Failed to fetch files: HTTP ${response.code}"))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Fetch files error", e)
            Result.failure(e)
        }
    }

    suspend fun createDirectory(name: String, parentId: String): Result<Boolean> = withContext(Dispatchers.IO) {
        try {
            val jsonMediaType = "application/json; charset=utf-8".toMediaType()
            val requestBody = "{\"name\":\"$name\",\"parentId\":\"$parentId\"}".toRequestBody(jsonMediaType)
            val request = Request.Builder()
                .url("$baseUrl/api/mkdir")
                .post(requestBody)
                .build()

            client.newCall(request).execute().use { response ->
                if (response.isSuccessful) {
                    Result.success(true)
                } else {
                    val bodyStr = response.body?.string() ?: ""
                    Result.failure(Exception("Failed to create directory: $bodyStr"))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Create directory error", e)
            Result.failure(e)
        }
    }

    suspend fun uploadFile(
        file: File,
        parentId: String?,
        relativePath: String? = null,
        mimeType: String = "application/octet-stream"
    ): Result<Boolean> = withContext(Dispatchers.IO) {
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
                    Result.success(true)
                } else {
                    val errMsg = try {
                        json.decodeFromString<UploadResponse>(bodyStr).error ?: "Upload failed"
                    } catch (e: Exception) {
                        "HTTP ${response.code}: $bodyStr"
                    }
                    Result.failure(Exception(errMsg))
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Upload error", e)
            Result.failure(e)
        }
    }
}
