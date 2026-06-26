package com.example.pisecurecloud

import androidx.compose.runtime.Composable
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberNavBackStack
import androidx.navigation3.ui.NavDisplay
import com.example.pisecurecloud.ui.login.LoginScreen
import com.example.pisecurecloud.ui.main.MainScreen

@Composable
fun MainNavigation() {
  val backStack = rememberNavBackStack(Login)

  NavDisplay(
    backStack = backStack,
    onBack = { backStack.removeLastOrNull() },
    entryProvider =
      entryProvider {
        entry<Login> {
          LoginScreen(onLoginSuccess = {
            backStack.removeLastOrNull()
            backStack.add(Main)
          })
        }
        entry<Main> {
          MainScreen(onLogout = {
            backStack.removeLastOrNull()
            backStack.add(Login)
          })
        }
      },
  )
}
