package com.example.pisecurecloud.data

import kotlinx.serialization.Serializable

@Serializable
data class CloudItem(
    val id: String,
    val name: String,
    val type: String, // "file" or "dir"
    val parentId: String = "root",
    val created: String? = null,
    val size: Long = 0L,
    val mimeType: String? = null,
    val diskPath: String? = null
)

@Serializable
data class LoginResponse(
    val success: Boolean = false,
    val message: String? = null,
    val error: String? = null
)

@Serializable
data class UploadResponse(
    val success: Boolean = false,
    val error: String? = null
)
