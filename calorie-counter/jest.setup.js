// Jest setup file
try {
  require('@testing-library/jest-native/extend-expect');
} catch (e) {
  // jest-native might not be available, that's ok
  console.log('Note: @testing-library/jest-native not available');
}

// Mock React Native
jest.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  StyleSheet: {
    create: (styles) => styles,
    flatten: (styles) => {
      if (!styles) return {};
      if (Array.isArray(styles)) {
        return styles.reduce((acc, style) => Object.assign(acc, style), {});
      }
      return styles;
    },
  },
}));

// Mock expo-sqlite
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(),
}));

// Mock expo-haptics
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  ImpactFeedbackStyle: {
    Light: 'light',
    Medium: 'medium',
    Heavy: 'heavy',
  },
  NotificationFeedbackType: {
    Success: 'success',
    Warning: 'warning',
    Error: 'error',
  },
}));

// Mock expo-router
jest.mock('expo-router', () => ({
  useRouter: jest.fn(() => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  })),
  useLocalSearchParams: jest.fn(() => ({})),
}));
