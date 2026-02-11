# Polpo Mobile

A cross-platform mobile companion app for OpenPolpo - the agent-agnostic framework for orchestrating teams of AI coding agents.

## Features

- **Real-time Monitoring**: Track active tasks and agent progress from anywhere
- **Connection Management**: Connect to your Polpo server instance
- **Cross-Platform**: Runs on iOS, Android, and Web
- **Responsive Design**: Optimized for mobile, tablet, and desktop displays
- **Bottom Tab Navigation**: Easy navigation between Home, Tasks, Plans, and Settings
- **Modern UI**: Built with React Native and Lucide icons

## Project Overview

Polpo Mobile provides a mobile interface to monitor and manage your Polpo server. It enables you to:

- View connection status to your Polpo instance
- Monitor active tasks in real-time
- Browse and manage plans
- Configure server connection settings
- Access task details and progress updates

## Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js**: v18.0.0 or higher
- **npm**: v8.0.0 or higher (comes with Node.js)
- **Expo CLI**: Installed globally or via npx
- **Mobile Development Setup** (optional, for native builds):
  - For iOS: macOS with Xcode 12+
  - For Android: Android Studio with SDK 31+

## Installation

1. **Navigate to the project directory:**
   ```bash
   cd orchestra-mobile
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Verify installation:**
   ```bash
   npm run verify
   ```

## Running the App

### Development Mode

Start the Expo development server:

```bash
npm start
```

This will open the Expo DevTools in your browser with options to run on:
- iOS Simulator (press `i`)
- Android Emulator (press `a`)
- Web browser (press `w`)
- Physical device via Expo Go app (scan QR code)

### Platform-Specific Commands

**iOS:**
```bash
npm run ios
```

**Android:**
```bash
npm run android
```

**Web:**
```bash
npm run web
```

**Tunnel Mode (for testing on remote devices):**
```bash
npm run dev:tunnel
```

## Connecting to Polpo Server

### Prerequisites

1. Ensure your Polpo server is running:
   ```bash
   # From the main orchestra directory
   polpo serve --port 3000
   ```

2. Note your server URL:
   - **Local development**: `http://localhost:3000`
   - **Network access**: `http://YOUR_IP:3000`
   - **Tunnel mode**: Use the ngrok URL provided by `npm run dev:tunnel`

### Configuration

1. Launch Polpo Mobile
2. Navigate to the **Settings** tab
3. Enter your Polpo server details:
   - **Server URL**: Your Polpo server address
   - **API Key**: (if authentication is enabled)
4. Tap "Connect" to establish connection

### Network Considerations

- **Same Network**: When running on a physical device, ensure both the device and server are on the same WiFi network
- **Localhost**: Won't work on physical devices - use your computer's IP address instead
- **Tunnel Mode**: Use `npm run dev:tunnel` for remote access without network configuration

## Project Structure

```
orchestra-mobile/
├── src/
│   ├── screens/          # Screen components
│   │   ├── HomeScreen.tsx       # Connection status & overview
│   │   ├── TasksScreen.tsx      # Task list & details
│   │   ├── PlansScreen.tsx      # Plan management
│   │   └── SettingsScreen.tsx   # Server configuration
│   ├── navigation/       # Navigation configuration
│   │   └── TabNavigator.tsx     # Bottom tab navigator
│   ├── api/             # HTTP & SSE clients
│   │   ├── orchestra-client.ts  # REST API client (Axios)
│   │   ├── event-source.ts      # SSE manager with auto-reconnect
│   │   └── types.ts             # API type definitions
│   ├── hooks/           # Custom React hooks
│   │   └── useOrchestra.ts      # Main state management hook
│   ├── types/           # TypeScript type definitions
│   │   └── index.ts             # Navigation & app types
│   └── utils/           # Utility functions
│       └── storage.ts           # AsyncStorage helpers
├── assets/              # Images, icons, fonts
│   ├── icon.png         # App icon (1024x1024)
│   ├── adaptive-icon.png # Android adaptive icon
│   └── splash-icon.png  # Splash screen icon
├── App.tsx              # Root component
├── index.ts             # Entry point
├── app.json             # Expo configuration
├── package.json         # Dependencies and scripts
├── tsconfig.json        # TypeScript configuration
└── README.md            # This file
```

### Key Directories

- **`src/screens/`**: Individual screen components for each tab
- **`src/navigation/`**: React Navigation configuration with bottom tabs
- **`src/api/`**: HTTP client (REST API) and SSE event manager with auto-reconnect
- **`src/hooks/`**: Custom hooks for state management (useOrchestra provides complete Polpo integration)
- **`src/types/`**: TypeScript interfaces and type definitions
- **`src/utils/`**: Helper functions and utilities

### Architecture

The app uses a centralized state management pattern via the `useOrchestra` hook:
- **REST API** via `OrchestraClient` (Axios-based) for read/write operations
- **Server-Sent Events** via `EventSourceManager` for real-time updates
- **AsyncStorage** for persisting connection settings
- **React state** synchronized with SSE events (tasks, plans, agents, processes)

## Development

### Type Checking

Run TypeScript type checking:
```bash
npx tsc --noEmit
```

### Code Style

This project uses:
- **TypeScript** for type safety
- **React Hooks** for state management
- **Functional Components** throughout
- **StyleSheet.create** for optimized styling

### Adding New Screens

1. Create screen component in `src/screens/`
2. Add route to `src/navigation/TabNavigator.tsx`
3. Update `src/types/index.ts` with new route types

### Adding Dependencies

```bash
# For React Native packages
npm install package-name

# For Expo-managed packages
npx expo install package-name
```

## Testing

Test the build process:
```bash
npm run verify
```

This command exports the web version to verify proper integration of all dependencies.

## Building for Production

### Web

```bash
npx expo export --platform web
```

### iOS (requires Apple Developer account)

```bash
npx expo build:ios
```

### Android

```bash
npx expo build:android
```

For detailed build instructions, see [Expo Build Documentation](https://docs.expo.dev/build/introduction/).

## Contributing

Contributions are welcome! Please follow these guidelines:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/my-feature`
3. **Make your changes**
4. **Test thoroughly**: Ensure the app works on iOS, Android, and Web
5. **Type check**: Run `npx tsc --noEmit` to verify no TypeScript errors
6. **Commit your changes**: `git commit -m "Add my feature"`
7. **Push to your fork**: `git push origin feature/my-feature`
8. **Open a Pull Request**

### Code Standards

- Use TypeScript strict mode
- Follow existing code style and patterns
- Add inline comments for complex logic
- Use functional components and hooks
- Ensure responsive design for all screen sizes

## License

This project is part of OpenPolpo and follows the same license.

## Related Projects

- **OpenPolpo Core**: [Main OpenPolpo repository](../README.md)
- **Polpo Web**: [Web UI for OpenPolpo](../packages/web/README.md)
- **React SDK**: [React SDK for OpenPolpo](../packages/react-sdk/README.md)

## Support

For issues, questions, or contributions:
- Open an issue in the main OpenPolpo repository
- Check the [SETUP.md](./SETUP.md) for troubleshooting tips
- Review the [OpenPolpo documentation](../README.md)

## Implemented Features

Current capabilities:
- Real-time SSE connection to Polpo server with auto-reconnect
- Connection status monitoring with visual indicators
- Task list with real-time updates
- Plan browsing and monitoring
- Agent configuration viewing
- Process monitoring
- Persistent server settings (AsyncStorage)
- Cross-platform support (iOS, Android, Web)
- TypeScript strict mode throughout
- Responsive design for all screen sizes

## Roadmap

Upcoming features:
- [ ] Task detail views with full agent logs
- [ ] Plan creation and editing UI
- [ ] Push notifications for task completion
- [ ] Dark mode support
- [ ] Offline support with local caching
- [ ] Agent performance metrics and charts
- [ ] Task filtering and advanced search
- [ ] Chat interface for creating tasks
- [ ] File browsing for task artifacts

---

Built for the OpenPolpo community
