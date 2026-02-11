/**
 * Polpo Mobile - Main App Entry Point
 *
 * A cross-platform mobile companion app for OpenPolpo.
 * Features:
 * - React Navigation with bottom tabs
 * - TypeScript strict typing
 * - Responsive design for mobile, tablet, and web
 * - Lucide React Native icons
 */
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';

// Import the tab navigator
import TabNavigator from './src/navigation/TabNavigator';

/**
 * Main App component
 * Wraps the app with NavigationContainer and renders the tab navigator
 */
export default function App(): React.JSX.Element {
  return (
    <NavigationContainer>
      <StatusBar style="auto" />
      <TabNavigator />
    </NavigationContainer>
  );
}
