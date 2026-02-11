/**
 * Plans Screen - View and manage Polpo plans
 */
import React from 'react';
import { StyleSheet, Text, View, SafeAreaView } from 'react-native';

const COLORS = {
  background: '#f5f5f5',
  textPrimary: '#1a1a1a',
} as const;

export default function PlansScreen(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>🗂️ Plans</Text>
        <Text style={styles.subtitle}>View and manage your Polpo plans</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  },
});
