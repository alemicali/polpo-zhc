import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useFoodStore } from '../src/stores/foodStore';

interface FormErrors {
  name?: string;
  calories?: string;
}

export default function AddFood() {
  const router = useRouter();
  const addCustomFood = useFoodStore((state) => state.addCustomFood);

  const [name, setName] = useState('');
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');
  const [servingSize, setServingSize] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    if (!name.trim()) {
      newErrors.name = 'Il nome è obbligatorio';
    }

    if (!calories.trim()) {
      newErrors.calories = 'Le calorie sono obbligatorie';
    } else if (isNaN(Number(calories)) || Number(calories) <= 0) {
      newErrors.calories = 'Inserisci un valore numerico valido maggiore di 0';
    }

    // Validate optional numeric fields if provided
    if (protein && (isNaN(Number(protein)) || Number(protein) < 0)) {
      newErrors.calories = 'Le proteine devono essere un numero valido';
    }
    if (carbs && (isNaN(Number(carbs)) || Number(carbs) < 0)) {
      newErrors.calories = 'I carboidrati devono essere un numero valido';
    }
    if (fat && (isNaN(Number(fat)) || Number(fat) < 0)) {
      newErrors.calories = 'I grassi devono essere un numero valido';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateForm()) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    setIsSubmitting(true);

    try {
      await addCustomFood({
        name: name.trim(),
        calories: Number(calories),
        protein: protein ? Number(protein) : 0,
        carbs: carbs ? Number(carbs) : 0,
        fat: fat ? Number(fat) : 0,
        serving_size: servingSize.trim() || '1 porzione',
        barcode: null,
        is_custom: true,
      });

      // Success feedback
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      // Navigate back immediately (success is implied by navigation)
      router.back();
    } catch (error) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      console.error('Error saving food:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={100}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.form}>
          {/* Nome alimento */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Nome alimento *</Text>
            <TextInput
              style={[styles.input, errors.name && styles.inputError]}
              value={name}
              onChangeText={(text) => {
                setName(text);
                if (errors.name) {
                  setErrors((prev) => ({ ...prev, name: undefined }));
                }
              }}
              placeholder="Es. Pizza margherita"
              placeholderTextColor="#9E9E9E"
              autoCapitalize="words"
            />
            {errors.name && <Text style={styles.errorText}>{errors.name}</Text>}
          </View>

          {/* Calorie */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Calorie per porzione *</Text>
            <TextInput
              style={[styles.input, errors.calories && styles.inputError]}
              value={calories}
              onChangeText={(text) => {
                setCalories(text);
                if (errors.calories) {
                  setErrors((prev) => ({ ...prev, calories: undefined }));
                }
              }}
              placeholder="Es. 250"
              placeholderTextColor="#9E9E9E"
              keyboardType="numeric"
            />
            {errors.calories && (
              <Text style={styles.errorText}>{errors.calories}</Text>
            )}
          </View>

          {/* Proteine */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Proteine (grammi)</Text>
            <TextInput
              style={styles.input}
              value={protein}
              onChangeText={setProtein}
              placeholder="Es. 12"
              placeholderTextColor="#9E9E9E"
              keyboardType="numeric"
            />
          </View>

          {/* Carboidrati */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Carboidrati (grammi)</Text>
            <TextInput
              style={styles.input}
              value={carbs}
              onChangeText={setCarbs}
              placeholder="Es. 35"
              placeholderTextColor="#9E9E9E"
              keyboardType="numeric"
            />
          </View>

          {/* Grassi */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Grassi (grammi)</Text>
            <TextInput
              style={styles.input}
              value={fat}
              onChangeText={setFat}
              placeholder="Es. 8"
              placeholderTextColor="#9E9E9E"
              keyboardType="numeric"
            />
          </View>

          {/* Porzione */}
          <View style={styles.inputGroup}>
            <Text style={styles.label}>Porzione</Text>
            <TextInput
              style={styles.input}
              value={servingSize}
              onChangeText={setServingSize}
              placeholder="Es. 100g, 1 fetta"
              placeholderTextColor="#9E9E9E"
            />
            <Text style={styles.helpText}>
              Lascia vuoto per usare "1 porzione"
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* Save button */}
      <View style={styles.buttonContainer}>
        <Pressable
          style={({ pressed }) => [
            styles.saveButton,
            isSubmitting && styles.saveButtonDisabled,
            pressed && !isSubmitting && styles.saveButtonPressed,
          ]}
          onPress={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.saveButtonText}>Salva</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 100, // Space for button
  },
  form: {
    padding: 16,
  },
  inputGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    backgroundColor: '#fff',
    color: '#212121',
  },
  inputError: {
    borderColor: '#ff3b30',
  },
  errorText: {
    color: '#ff3b30',
    fontSize: 14,
    marginTop: 4,
  },
  helpText: {
    color: '#666',
    fontSize: 14,
    marginTop: 4,
  },
  buttonContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  saveButton: {
    backgroundColor: '#4CAF50',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  saveButtonPressed: {
    backgroundColor: '#388E3C',
  },
  saveButtonDisabled: {
    backgroundColor: '#A5D6A7',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
});
