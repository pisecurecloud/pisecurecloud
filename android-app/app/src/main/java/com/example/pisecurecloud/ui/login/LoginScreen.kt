package com.example.pisecurecloud.ui.login

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.example.pisecurecloud.network.NetworkClient
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(onLoginSuccess: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    
    val sharedPrefs = remember {
        context.getSharedPreferences("pisecurecloud_prefs", Context.MODE_PRIVATE)
    }

    var serverUrl by remember { mutableStateOf(sharedPrefs.getString("server_url", "http://10.0.2.2:3000") ?: "") }
    var username by remember { mutableStateOf(sharedPrefs.getString("username", "") ?: "") }
    var password by remember { mutableStateOf(sharedPrefs.getString("password", "") ?: "") }
    
    var isLoading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("PiSecureCloud", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.primary)
        Spacer(modifier = Modifier.height(8.dp))
        Text("Mit deiner Cloud verbinden", style = MaterialTheme.typography.bodyMedium)
        
        Spacer(modifier = Modifier.height(32.dp))

        OutlinedTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = { Text("Server-URL") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("Benutzername") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Passwort") },
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth()
        )

        if (errorMessage.isNotEmpty()) {
            Spacer(modifier = Modifier.height(16.dp))
            Text(errorMessage, color = MaterialTheme.colorScheme.error)
        }

        Spacer(modifier = Modifier.height(32.dp))

        if (isLoading) {
            CircularProgressIndicator()
        } else {
            Button(
                onClick = {
                    if (serverUrl.isBlank() || username.isBlank() || password.isBlank()) {
                        errorMessage = "Bitte alle Felder ausfüllen."
                        return@Button
                    }
                    isLoading = true
                    errorMessage = ""
                    
                    scope.launch {
                        NetworkClient.setServerUrl(serverUrl)
                        val result = NetworkClient.login(username, password)
                        isLoading = false
                        if (result.isSuccess) {
                            sharedPrefs.edit()
                                .putString("server_url", serverUrl)
                                .putString("username", username)
                                .putString("password", password)
                                .apply()
                            
                            Toast.makeText(context, "Erfolgreich angemeldet", Toast.LENGTH_SHORT).show()
                            onLoginSuccess()
                        } else {
                            errorMessage = result.exceptionOrNull()?.message ?: "Anmeldefehler"
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Anmelden")
            }
        }
    }
}
