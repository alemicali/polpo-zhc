# Polpo Mobile - Setup & Troubleshooting Guide

This guide provides detailed setup instructions and solutions to common issues when developing and running Polpo Mobile.

## 📦 Initial Setup

### 1. Environment Setup

**Verify Node.js version:**
```bash
node --version  # Should be v18.0.0 or higher
npm --version   # Should be v8.0.0 or higher
```

**If you need to update Node.js:**
- Use [nvm](https://github.com/nvm-sh/nvm) (recommended):
  ```bash
  nvm install 18
  nvm use 18
  ```
- Or download from [nodejs.org](https://nodejs.org/)

### 2. Install Dependencies

From the `orchestra-mobile` directory:

```bash
# Clean install (recommended for first setup)
rm -rf node_modules package-lock.json
npm install

# Verify installation
npm run verify
```

### 3. Platform-Specific Setup

#### iOS (macOS only)

1. **Install Xcode** from the Mac App Store
2. **Install Command Line Tools:**
   ```bash
   xcode-select --install
   ```
3. **Install iOS Simulator:**
   - Open Xcode
   - Go to Preferences → Components
   - Download desired iOS simulator versions

4. **Install CocoaPods:**
   ```bash
   sudo gem install cocoapods
   ```

#### Android

1. **Install Android Studio** from [developer.android.com](https://developer.android.com/studio)

2. **Configure Android SDK:**
   - Open Android Studio
   - Go to Preferences → Appearance & Behavior → System Settings → Android SDK
   - Install SDK Platform 31 (Android 12) or higher
   - Install Android SDK Build-Tools

3. **Set up environment variables** (add to `~/.bashrc` or `~/.zshrc`):
   ```bash
   export ANDROID_HOME=$HOME/Library/Android/sdk  # macOS
   # export ANDROID_HOME=$HOME/Android/Sdk  # Linux
   export PATH=$PATH:$ANDROID_HOME/emulator
   export PATH=$PATH:$ANDROID_HOME/platform-tools
   ```

4. **Create an Android Virtual Device (AVD):**
   - Open Android Studio
   - Go to Tools → Device Manager
   - Create a new virtual device (e.g., Pixel 5, API 31)

## 🐛 Common Issues & Solutions

### Issue: "Cannot find module" errors

**Symptoms:**
```
Error: Cannot find module '@react-navigation/native'
```

**Solution:**
```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm cache clean --force
npm install
```

### Issue: Metro bundler cache issues

**Symptoms:**
- Stale code showing after changes
- Unexpected build errors
- "Unable to resolve module" errors

**Solution:**
```bash
# Clear Expo and Metro cache
npx expo start --clear

# Or manually clear cache
rm -rf .expo node_modules/.cache
```

### Issue: TypeScript errors in IDE but code runs

**Symptoms:**
- Red squiggly lines in VSCode
- Type errors that don't affect runtime

**Solution:**
```bash
# Restart TypeScript server in VSCode
# CMD/CTRL + Shift + P → "TypeScript: Restart TS Server"

# Or verify types manually
npx tsc --noEmit
```

### Issue: iOS simulator won't launch

**Symptoms:**
```
Error: Could not start iOS simulator
```

**Solution:**
```bash
# Open simulator manually first
open -a Simulator

# Then run the app
npm run ios
```

### Issue: Android emulator not found

**Symptoms:**
```
Error: No Android emulator found
```

**Solution:**
```bash
# List available emulators
emulator -list-avds

# Start emulator manually
emulator -avd Pixel_5_API_31

# Then run the app
npm run android
```

### Issue: Port 8081 (Metro) already in use

**Symptoms:**
```
Error: listen EADDRINUSE: address already in use :::8081
```

**Solution:**
```bash
# Find and kill process on port 8081
lsof -ti:8081 | xargs kill -9

# Or use a different port
npx expo start --port 8082
```

### Issue: Expo Go app not connecting

**Symptoms:**
- QR code scans but app won't load
- "Something went wrong" in Expo Go

**Solution:**
1. **Ensure same network:** Phone and computer must be on the same WiFi
2. **Try tunnel mode:**
   ```bash
   npm run dev:tunnel
   ```
3. **Check firewall:** Ensure port 8081 is not blocked
4. **Restart Expo Go app** and scan QR code again

### Issue: Lucide icons not rendering

**Symptoms:**
- Missing icons or blank spaces where icons should be
- Warning: "Unrecognized font family"

**Solution:**
```bash
# Reinstall dependencies
npm install lucide-react-native react-native-svg

# Clear cache and restart
npx expo start --clear
```

### Issue: Navigation not working

**Symptoms:**
- Tapping tabs does nothing
- "undefined is not an object (evaluating 'navigator.navigate')"

**Solution:**
```bash
# Ensure navigation packages are installed
npm install @react-navigation/native @react-navigation/bottom-tabs
npx expo install react-native-screens react-native-safe-area-context

# Restart the app
npm start
```

### Issue: Web version doesn't work

**Symptoms:**
- Build errors when running `npm run web`
- White screen on web

**Solution:**
```bash
# Install web dependencies
npx expo install react-dom react-native-web

# Clear web build cache
rm -rf .expo/web

# Rebuild
npm run web
```

## 🔧 Advanced Troubleshooting

### Complete Clean Reset

If you're experiencing persistent issues:

```bash
# 1. Stop all running processes
# Press CTRL+C in all terminals

# 2. Clear all caches
rm -rf node_modules
rm -rf .expo
rm -rf $TMPDIR/react-*
rm -rf $TMPDIR/metro-*
rm package-lock.json

# 3. Clear npm cache
npm cache clean --force

# 4. Reinstall
npm install

# 5. Start fresh
npx expo start --clear
```

### Debugging Native Modules

Enable debug logging:

```bash
# iOS - view logs
npx react-native log-ios

# Android - view logs
npx react-native log-android

# Or use adb directly
adb logcat | grep -i "polpo"
```

### Network Debugging

Test server connectivity:

```bash
# Check if Polpo server is reachable
curl http://localhost:3000/api/v1/health

# On mobile, use your computer's IP
curl http://192.168.1.X:3000/api/v1/health

# Test with tunnel mode for remote access
npm run dev:tunnel
```

## 🔍 Development Tips

### Hot Reloading Issues

If changes aren't reflecting:
1. Shake device (physical) or press `Cmd+D` (iOS) / `Cmd+M` (Android)
2. Select "Reload"
3. Or press `r` in the terminal running Metro

### Performance Profiling

Enable performance monitor:
1. Shake device or `Cmd+D` / `Cmd+M`
2. Select "Show Perf Monitor"

### Debugging

Enable Chrome DevTools:
1. Shake device or `Cmd+D` / `Cmd+M`
2. Select "Debug Remote JS"
3. Open `http://localhost:8081/debugger-ui` in Chrome

## 📱 Device-Specific Issues

### iOS

**Issue: App crashes on launch**
```bash
# Reset iOS simulator
xcrun simctl erase all

# Clean build folder
rm -rf ios/build
```

**Issue: Code signing errors**
- Open `ios/openpolpomobile.xcworkspace` in Xcode
- Update signing team in project settings

### Android

**Issue: App crashes on launch**
```bash
# Clear Android build cache
cd android
./gradlew clean
cd ..

# Rebuild
npm run android
```

**Issue: "SDK location not found"**
Create `android/local.properties`:
```
sdk.dir=/Users/YOUR_USERNAME/Library/Android/sdk  # macOS
# sdk.dir=/home/YOUR_USERNAME/Android/Sdk  # Linux
```

## 🌐 Connecting to Polpo Server

### Local Development

1. **Start Polpo server:**
   ```bash
   # From main orchestra directory
   polpo serve --port 3000 --host 0.0.0.0
   ```

2. **Find your local IP:**
   ```bash
   # macOS/Linux
   ifconfig | grep "inet " | grep -v 127.0.0.1

   # Windows
   ipconfig
   ```

3. **Configure in Settings screen:**
   - Server URL: `http://YOUR_IP:3000`
   - API Key: (if enabled)

### Tunnel Mode (Remote Access)

For accessing from anywhere:

```bash
# Start with tunnel
npm run dev:tunnel

# Polpo server will be accessible via ngrok URL
# Note the URL and use it in Settings
```

### CORS Issues

If you encounter CORS errors, ensure Polpo server allows your origin:

```bash
# Start Polpo with CORS enabled
polpo serve --host 0.0.0.0 --port 3000
```

## 📚 Additional Resources

- [Expo Documentation](https://docs.expo.dev/)
- [React Navigation Docs](https://reactnavigation.org/)
- [React Native Docs](https://reactnative.dev/)
- [TypeScript React Guide](https://react-typescript-cheatsheet.netlify.app/)

## 🆘 Getting Help

If you're still experiencing issues:

1. **Check logs:** Look for error messages in terminal
2. **Search issues:** Check GitHub issues for similar problems
3. **Create an issue:** Provide:
   - OS and version
   - Node.js version
   - Complete error message
   - Steps to reproduce
   - Output of `npm list`

## 📋 Checklist for New Setup

- [ ] Node.js 18+ installed
- [ ] npm 8+ installed
- [ ] Dependencies installed (`npm install`)
- [ ] Verification passed (`npm run verify`)
- [ ] iOS Simulator / Android Emulator running (for native testing)
- [ ] Polpo server running (`polpo serve --port 3000 --host 0.0.0.0`)
- [ ] Network connectivity confirmed
- [ ] Settings configured with correct server URL

## 🏗️ Implementation Details

### Architecture Overview

Polpo Mobile uses a layered architecture:

1. **API Layer** (`src/api/`)
   - `orchestra-client.ts`: REST API client using Axios
   - `event-source.ts`: Custom SSE implementation using XMLHttpRequest (React Native doesn't support native EventSource)
   - `types.ts`: Full TypeScript definitions for Polpo API

2. **State Management** (`src/hooks/`)
   - `useOrchestra.ts`: Main hook that orchestrates everything
   - AsyncStorage for persisting connection settings
   - Local React state synchronized with SSE events
   - Automatic reconnection with exponential backoff

3. **UI Layer** (`src/screens/`)
   - Bottom tab navigation with 4 screens
   - Real-time updates via SSE event subscriptions
   - Responsive design for mobile, tablet, and web

### SSE Connection Flow

1. User enters server URL and API key in Settings
2. Settings saved to AsyncStorage
3. `connect()` called -- creates `OrchestraClient` and `EventSourceManager`
4. Initial REST API fetch loads current state (tasks, plans, agents, processes)
5. SSE connection established for real-time updates
6. Events automatically update local state
7. On disconnect: exponential backoff reconnection (1s → 2s → 4s → ... → 30s)
8. Last-Event-ID sent on reconnect to resume from last event

### Event Handling

The app subscribes to all 35+ Polpo events and updates state accordingly:
- **Task events**: Upsert or remove tasks
- **Plan events**: Upsert or remove plans
- **Agent events**: Refresh process list
- **Assessment events**: (future: show progress)

### Data Persistence

- **Connection settings**: Stored in AsyncStorage (survives app restarts)
- **Runtime state**: In-memory React state (cleared on app restart)
- **Future**: Local caching for offline support

---

Still stuck? Open an issue in the main OpenPolpo repository with detailed information about your problem.
