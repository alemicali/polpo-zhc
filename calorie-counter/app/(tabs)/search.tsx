import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  Modal,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Animated,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Search as SearchIcon, XCircle, Clock, PlusCircle, CheckCircle, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useFoodStore } from '../../src/stores/foodStore';
import { useDiaryStore } from '../../src/stores/diaryStore';
import FoodListItem from '../../src/components/FoodListItem';
import type { Food, MealType } from '../../src/types';

type MealTypeLabel = {
  value: MealType;
  label: string;
};

const MEAL_TYPES: MealTypeLabel[] = [
  { value: 'breakfast', label: 'Colazione' },
  { value: 'lunch', label: 'Pranzo' },
  { value: 'dinner', label: 'Cena' },
  { value: 'snack', label: 'Spuntino' },
];

export default function Search() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mealType?: string }>();

  const { searchResults, recentFoods, searchQuery, loading, search, loadRecent } = useFoodStore();
  const addEntry = useDiaryStore((state) => state.addEntry);

  const [searchText, setSearchText] = useState('');
  const [selectedFood, setSelectedFood] = useState<Food | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [selectedMealType, setSelectedMealType] = useState<MealType>(
    (params.mealType as MealType) || 'breakfast'
  );
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [showSuccessMessage, setShowSuccessMessage] = useState(false);
  const successOpacity = useState(new Animated.Value(0))[0];

  // Load recent foods on mount
  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  // Debounced search
  useEffect(() => {
    const timeout = setTimeout(() => {
      search(searchText);
    }, 300);

    return () => clearTimeout(timeout);
  }, [searchText, search]);

  const handleFoodPress = useCallback((food: Food) => {
    setSelectedFood(food);
    setQuantity('1');
    setSelectedMealType((params.mealType as MealType) || 'breakfast');
    setIsModalVisible(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [params.mealType]);

  const showSuccessFeedback = () => {
    setShowSuccessMessage(true);
    Animated.sequence([
      Animated.timing(successOpacity, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
      Animated.delay(1500),
      Animated.timing(successOpacity, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setShowSuccessMessage(false);
    });
  };

  const handleAddToMeal = async () => {
    if (!selectedFood) return;

    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    setIsAdding(true);
    try {
      await addEntry(selectedFood.id, selectedMealType, qty);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setIsModalVisible(false);
      setSelectedFood(null);
      showSuccessFeedback();
    } catch (error) {
      console.error('Failed to add food to diary:', error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsAdding(false);
    }
  };

  const handleCloseModal = () => {
    setIsModalVisible(false);
    setSelectedFood(null);
  };

  const renderFoodItem = ({ item }: { item: Food }) => (
    <FoodListItem food={item} onPress={() => handleFoodPress(item)} />
  );

  const displayList = searchText.trim() === '' ? recentFoods : searchResults;

  return (
    <View style={styles.container}>
      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <SearchIcon size={20} color="#999" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Cerca alimento..."
          placeholderTextColor="#999"
          value={searchText}
          onChangeText={setSearchText}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searchText.length > 0 && (
          <Pressable onPress={() => setSearchText('')} style={styles.clearButton}>
            <XCircle size={20} color="#999" />
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
          {searchText.trim() === '' && (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Alimenti Recenti</Text>
            </View>
          )}
          <FlatList
            data={displayList}
            renderItem={renderFoodItem}
            keyExtractor={(item) => item.id.toString()}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                {searchText.trim() === '' ? (
                  <Clock size={64} color="#DDD" />
                ) : (
                  <SearchIcon size={64} color="#DDD" />
                )}
                <Text style={styles.emptyText}>
                  {searchText.trim() === ''
                    ? 'Nessun alimento recente'
                    : 'Nessun risultato'}
                </Text>
                <Text style={styles.emptySubtext}>
                  {searchText.trim() === ''
                    ? 'Cerca un alimento o aggiungine uno personalizzato'
                    : 'Prova con un\'altra ricerca'}
                </Text>
              </View>
            }
          />
        </>
      )}

      {/* Add Custom Food Button */}
      <View style={styles.bottomButtonContainer}>
        <Pressable
          style={({ pressed }) => [
            styles.addCustomButton,
            pressed && styles.addCustomButtonPressed,
          ]}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            router.push('/add-food');
          }}
        >
          <PlusCircle size={24} color="#007AFF" />
          <Text style={styles.addCustomButtonText}>Aggiungi Alimento Personalizzato</Text>
        </Pressable>
      </View>

      {/* Success Message */}
      {showSuccessMessage && (
        <Animated.View
          style={[
            styles.successToast,
            { opacity: successOpacity },
          ]}
        >
          <CheckCircle size={24} color="#FFF" />
          <Text style={styles.successText}>Alimento aggiunto al diario</Text>
        </Animated.View>
      )}

      {/* Add to Diary Modal */}
      <Modal
        visible={isModalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={handleCloseModal}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable style={styles.modalBackdrop} onPress={handleCloseModal} />
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Aggiungi al diario</Text>
              <Pressable onPress={handleCloseModal} style={styles.closeButton}>
                <X size={28} color="#333" />
              </Pressable>
            </View>

            {selectedFood && (
              <>
                {/* Food Details */}
                <View style={styles.foodDetails}>
                  <Text style={styles.foodName}>{selectedFood.name}</Text>
                  <Text style={styles.servingInfo}>{selectedFood.serving_size}</Text>

                  <View style={styles.nutritionGrid}>
                    <View style={styles.nutritionItem}>
                      <Text style={styles.nutritionValue}>
                        {Math.round(selectedFood.calories * parseFloat(quantity || '1'))}
                      </Text>
                      <Text style={styles.nutritionLabel}>Calorie</Text>
                    </View>
                    <View style={styles.nutritionItem}>
                      <Text style={styles.nutritionValue}>
                        {Math.round(selectedFood.protein * parseFloat(quantity || '1'))}g
                      </Text>
                      <Text style={styles.nutritionLabel}>Proteine</Text>
                    </View>
                    <View style={styles.nutritionItem}>
                      <Text style={styles.nutritionValue}>
                        {Math.round(selectedFood.carbs * parseFloat(quantity || '1'))}g
                      </Text>
                      <Text style={styles.nutritionLabel}>Carboidrati</Text>
                    </View>
                    <View style={styles.nutritionItem}>
                      <Text style={styles.nutritionValue}>
                        {Math.round(selectedFood.fat * parseFloat(quantity || '1'))}g
                      </Text>
                      <Text style={styles.nutritionLabel}>Grassi</Text>
                    </View>
                  </View>
                </View>

                {/* Quantity Input */}
                <View style={styles.inputSection}>
                  <Text style={styles.inputLabel}>Quantità</Text>
                  <TextInput
                    style={styles.quantityInput}
                    value={quantity}
                    onChangeText={setQuantity}
                    keyboardType="decimal-pad"
                    selectTextOnFocus
                  />
                </View>

                {/* Meal Type Picker */}
                <View style={styles.inputSection}>
                  <Text style={styles.inputLabel}>Pasto</Text>
                  <View style={styles.mealTypeGrid}>
                    {MEAL_TYPES.map((meal) => (
                      <Pressable
                        key={meal.value}
                        style={({ pressed }) => [
                          styles.mealTypeButton,
                          selectedMealType === meal.value && styles.mealTypeButtonSelected,
                          pressed && styles.mealTypeButtonPressed,
                        ]}
                        onPress={() => {
                          setSelectedMealType(meal.value);
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        }}
                      >
                        <Text
                          style={[
                            styles.mealTypeText,
                            selectedMealType === meal.value && styles.mealTypeTextSelected,
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
                    isAdding && styles.addButtonDisabled,
                    pressed && !isAdding && styles.addButtonPressed,
                  ]}
                  onPress={handleAddToMeal}
                  disabled={isAdding}
                >
                  <Text style={styles.addButtonText}>
                    {isAdding ? 'Aggiunta in corso...' : 'Aggiungi'}
                  </Text>
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
    backgroundColor: '#FFF',
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  searchIcon: {
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 16,
    color: '#333',
  },
  clearButton: {
    padding: 4,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sectionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
  },
  listContent: {
    paddingBottom: 80,
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 80,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#999',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#BBB',
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  bottomButtonContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#FFF',
    paddingHorizontal: 16,
    paddingVertical: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
    borderTopColor: '#EEE',
  },
  addCustomButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0F8FF',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#007AFF',
    gap: 8,
  },
  addCustomButtonPressed: {
    backgroundColor: '#E0F0FF',
    opacity: 0.8,
  },
  addCustomButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#007AFF',
  },
  successToast: {
    position: 'absolute',
    top: 60,
    left: 20,
    right: 20,
    backgroundColor: '#34C759',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  successText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFF',
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
    backgroundColor: '#FFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 34,
    maxHeight: '85%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#EEE',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
  },
  closeButton: {
    padding: 4,
  },
  foodDetails: {
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#EEE',
  },
  foodName: {
    fontSize: 22,
    fontWeight: '700',
    color: '#212121',
    marginBottom: 4,
  },
  servingInfo: {
    fontSize: 14,
    color: '#757575',
    marginBottom: 16,
  },
  nutritionGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 8,
  },
  nutritionItem: {
    alignItems: 'center',
  },
  nutritionValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#4CAF50',
    marginBottom: 4,
  },
  nutritionLabel: {
    fontSize: 12,
    color: '#757575',
  },
  inputSection: {
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  inputLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  quantityInput: {
    borderWidth: 1,
    borderColor: '#DDD',
    borderRadius: 8,
    padding: 12,
    fontSize: 18,
    textAlign: 'center',
    backgroundColor: '#F9F9F9',
  },
  mealTypeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  mealTypeButton: {
    flex: 1,
    minWidth: '45%',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#DDD',
    backgroundColor: '#FFF',
    alignItems: 'center',
  },
  mealTypeButtonSelected: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  mealTypeButtonPressed: {
    opacity: 0.7,
  },
  mealTypeText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  mealTypeTextSelected: {
    color: '#FFF',
  },
  addButton: {
    marginHorizontal: 20,
    marginTop: 24,
    backgroundColor: '#34C759',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  addButtonPressed: {
    backgroundColor: '#2da84a',
  },
  addButtonDisabled: {
    backgroundColor: '#a8e6b8',
  },
  addButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFF',
  },
});
