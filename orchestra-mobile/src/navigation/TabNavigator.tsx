/**
 * Tab Navigator - Bottom tab navigation for Polpo Mobile
 * Provides navigation between Home, Tasks, Plans, and Settings screens
 */
import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Home, BarChart3, FolderOpen, Settings } from 'lucide-react-native';

// Import screens
import HomeScreen from '../screens/HomeScreen';
import TasksScreen from '../screens/TasksScreen';
import PlansScreen from '../screens/PlansScreen';
import SettingsScreen from '../screens/SettingsScreen';

// Import types
import type { RootTabParamList } from '../types';

const Tab = createBottomTabNavigator<RootTabParamList>();

const COLORS = {
  primary: '#2196f3',
  inactive: '#666',
  background: '#ffffff',
} as const;

export default function TabNavigator(): React.JSX.Element {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.inactive,
        tabBarStyle: {
          backgroundColor: COLORS.background,
          borderTopWidth: 1,
          borderTopColor: '#e0e0e0',
          paddingBottom: 8,
          paddingTop: 8,
          height: 60,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '500',
        },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Home size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Tasks"
        component={TasksScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <BarChart3 size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Plans"
        component={PlansScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <FolderOpen size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{
          tabBarIcon: ({ color, size }) => (
            <Settings size={size} color={color} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
