package com.example.pisecurecloud.ui.main

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExitToApp
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.example.pisecurecloud.ui.files.FilesScreen
import com.example.pisecurecloud.ui.backup.BackupScreen

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(onLogout: () -> Unit) {
    var selectedTab by remember { mutableStateOf(0) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("PiSecureCloud") },
                actions = {
                    IconButton(onClick = onLogout) {
                        Icon(Icons.Filled.ExitToApp, contentDescription = "Abmelden")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer
                )
            )
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = selectedTab == 0,
                    onClick = { selectedTab = 0 },
                    icon = { Icon(Icons.Filled.Folder, contentDescription = "Dateien") },
                    label = { Text("Dateien") }
                )
                NavigationBarItem(
                    selected = selectedTab == 1,
                    onClick = { selectedTab = 1 },
                    icon = { Icon(Icons.Filled.Refresh, contentDescription = "Backup") },
                    label = { Text("Backup") }
                )
            }
        }
    ) { innerPadding ->
        Box(modifier = Modifier
            .fillMaxSize()
            .padding(innerPadding)) {
            when (selectedTab) {
                0 -> FilesScreen()
                1 -> BackupScreen()
            }
        }
    }
}
