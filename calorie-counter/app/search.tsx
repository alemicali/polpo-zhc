import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  Modal,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useFoodStore } from '../src/stores/foodStore';
import { useDiaryStore } from '../src/stores/diaryStore';
import FoodListItem from '../src/components/FoodListItem';
import MacroPills from '../src/components/MacroPills';
import type { Food, MealType } from '../src/types';

const MEAL_TYPES: { value: MealType; label: string }[] = [
  { value: 'breakfast', label: 'Colazione' },
  { value: 'lunch', label: 'Pranzo' },
  { value: 'dinner', label: 'Cena' },
  { value: 'snack', label: 'Spuntino' },
];

export default function Search() {
  const router = useRouter();
  const params = useLocalSearchParams();

  // Stores
  const {
    searchResults,
    recentFoods,
    loading,
    search,
    loadRecent,
  } = useFoodStore();
  const { addEntry } = useDiaryStore();

  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFood, setSelectedFood] = useState<Food | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [selectedMealType, setSelectedMealType] = useState<MealType>(
    (params.mealType as MealType) || 'breakfast'
  );
  const [modalVisible, setModalVisible] = useState(false);
  const [adding, setAdding] = useState(false);

  // Debounce timer ref
  const debounceTimer = React.useRef<NodeJS.Timeout>();

  // Load recent foods on mount
  useEffect(() => {
    loadRecent();
  }, []);

  // Debounced search
  const handleSearchChange = useCallback((text: string) => {
    setSearchQuery(text);

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      search(text);
    }, 300);
  }, [search]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  const handleFoodPress = (food: Food) => {
    setSelectedFood(food);
    setQuantity('1');
    setModalVisible(true);
  };

  const handleAddToDiary = async () => {
    if (!selectedFood) return;

    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      alert('Inserisci una quantità valida');
      return;
    }

    setAdding(true);
    try {
      await addEntry(selectedFood.id, selectedMealType, qty);
      setModalVisible(false);
      setSelectedFood(null);
      // Optionally navigate back to diary
      router.back();
    } catch (error) {
      console.error('Failed to add entry:', error);
      alert('Errore durante l\'aggiunta al diario');
    } finally {
      setAdding(false);
    }
  };

  const handleAddCustomFood = () => {
    // Navigate to add custom food screen (to be implemented)
    alert('Funzionalità in arrivo: Aggiungi alimento personalizzato');
  };

  const displayedFoods = searchQuery.trim() === '' ? recentFoods : searchResults;
  const showRecentHeader = searchQuery.trim() === '' && recentFoods.length > 0;

  return (
    <View style={styles.container}>
      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#757575" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Cerca alimento..."
          placeholderTextColor="#9E9E9E"
          value={searchQuery}
          onChangeText={handleSearchChange}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <Pressable onPress={() => handleSearchChange('')} style={styles.clearButton}>
            <Ionicons name="close-circle" size={20} color="#757575" />
          </Pressable>
        )}
      </View>

      {/* Results List */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      ) : (
        <>
          {showRecentHeader && (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionHeaderText}>Recenti</Text>
            </View>
          )}
          <FlatList
            data={displayedFoods}
            keyExtractor={(item) => item.id.toString()}
            renderItem={({ item }) => (
              <FoodListItem food={item} onPress={() => handleFoodPress(item)} />
            )}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Ionicons name="restaurant-outline" size={64} color="#BDBDBD" />
                <Text style={styles.emptyText}>
                  {searchQuery.trim() === ''
                    ? 'Nessun alimento recente'
                    : 'Nessun risultato trovato'}
                </Text>
              </View>
            }
          />
        </>
      )}

      {/* Floating Add Button */}
      <Pressable
        style={({ pressed }) => [
          styles.fab,
          pressed && styles.fabPressed,
        ]}
        onPress={handleAddCustomFood}
      >
        <Ionicons name="add" size={28} color="#FFFFFF" />
      </Pressable>

      {/* Add to Diary Modal */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalOverlay}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => setModalVisible(false)}
          />
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Aggiungi al diario</Text>
              <Pressable onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={28} color="#212121" />
              </Pressable>
            </View>

            {selectedFood && (
              <>
                {/* Food Details */}
                <View style={styles.foodDetails}>
                  <Text style={styles.foodName}>{selectedFood.name}</Text>
                  <Text style={styles.servingSize}>{selectedFood.serving_size}</Text>

                  <View style={styles.nutritionRow}>
                    <View style={styles.caloriesBox}>
                      <Text style={styles.caloriesValue}>
                        {Math.round(selectedFood.calories * parseFloat(quantity || '1'))}
                      </Text>
                      <Text style={styles.caloriesLabel}>calorie</Text>
                    </View>
                    <View style={styles.macrosBox}>
                      <MacroPills
                        protein={selectedFood.protein * parseFloat(quantity || '1')}
                        carbs={selectedFood.carbs * parseFloat(quantity || '1')}
                        fat={selectedFood.fat * parseFloat(quantity || '1')}
                      />
                    </View>
                  </View>
                </View>

                {/* Quantity Input */}
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Quantità</Text>
                  <View style={styles.quantityContainer}>
                    <Pressable
                      style={styles.quantityButton}
                      onPress={() => {
                        const current = parseFloat(quantity || '1');
                        if (current > 0.25) {
                          setQuantity((current - 0.25).toFixed(2));
                        }
                      }}
                    >
                      <Ionicons name="remove" size={20} color="#007AFF" />
                    </Pressable>
                    <TextInput
                      style={styles.quantityInput}
                      value={quantity}
                      onChangeText={setQuantity}
                      keyboardType="decimal-pad"
                      selectTextOnFocus
                    />
                    <Pressable
                      style={styles.quantityButton}
                      onPress={() => {
                        const current = parseFloat(quantity || '1');
                        setQuantity((current + 0.25).toFixed(2));
                      }}
                    >
                      <Ionicons name="add" size={20} color="#007AFF" />
                    </Pressable>
                  </View>
                </View>

                {/* Meal Type Picker */}
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Pasto</Text>
                  <View style={styles.mealTypeContainer}>
                    {MEAL_TYPES.map((meal) => (
                      <Pressable
                        key={meal.value}
                        style={[
                          styles.mealTypeButton,
                          selectedMealType === meal.value && styles.mealTypeButtonActive,
                        ]}
                        onPress={() => setSelectedMealType(meal.value)}
                      >
                        <Text
                          style={[
                            styles.mealTypeText,
                            selectedMealType === meal.value && styles.mealTypeTextActive,
                          ]}
                        >
                          {meal.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                {/* Add Button */}
                <Pressable
                  style={({ pressed }) => [
                    styles.addButton,
                    pressed && styles.addButtonPressed,
                    adding && styles.addButtonDisabled,
                  ]}
                  onPress={handleAddToDiary}
                  disabled={adding}
                >
                  {adding ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.addButtonText}>Aggiungi</Text>
                  )}
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    marginHorizontal: 16,
    marginVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 16,
    color: '#212121',
  },
  clearButton: {
    padding: 4,
  },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#F5F5F5',
  },
  sectionHeaderText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#757575',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  listContent: {
    paddingBottom: 80,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    marginTop: 16,
    fontSize: 16,
    color: '#757575',
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  fabPressed: {
    backgroundColor: '#0056B3',
    transform: [{ scale: 0.95 }],
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#212121',
  },
  foodDetails: {
    marginBottom: 24,
  },
  foodName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#212121',
    marginBottom: 4,
  },
  servingSize: {
    fontSize: 14,
    color: '#757575',
    marginBottom: 16,
  },
  nutritionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  caloriesBox: {
    alignItems: 'center',
  },
  caloriesValue: {
    fontSize: 32,
    fontWeight: '700',
    color: '#4CAF50',
  },
  caloriesLabel: {
    fontSize: 12,
    color: '#757575',
  },
  macrosBox: {
    flex: 1,
    alignItems: 'flex-end',
  },
  inputGroup: {
    marginBottom: 24,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#212121',
    marginBottom: 8,
  },
  quantityContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  quantityButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#E3F2FD',
    justifyContent: 'center',
    alignItems: 'center',
  },
  quantityInput: {
    minWidth: 80,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#F5F5F5',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    color: '#212121',
  },
  mealTypeContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  mealTypeButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    backgroundColor: '#F5F5F5',
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  mealTypeButtonActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  mealTypeText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#757575',
  },
  mealTypeTextActive: {
    color: '#FFFFFF',
  },
  addButton: {
    backgroundColor: '#4CAF50',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  addButtonPressed: {
    backgroundColor: '#388E3C',
  },
  addButtonDisabled: {
    backgroundColor: '#A5D6A7',
  },
  addButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
