import React from 'react';
import { Pressable, Text, StyleSheet, ActivityIndicator, ViewStyle } from 'react-native';

interface CustomButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'outline' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}

const CustomButton: React.FC<CustomButtonProps> = ({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  style,
}) => {
  const isDisabled = disabled || loading;

  const getButtonStyle = (pressed: boolean) => {
    const baseStyles = [styles.button, style];

    if (variant === 'primary') {
      baseStyles.push(styles.primaryButton);
      if (pressed && !isDisabled) baseStyles.push(styles.primaryButtonPressed);
    } else if (variant === 'outline') {
      baseStyles.push(styles.outlineButton);
      if (pressed && !isDisabled) baseStyles.push(styles.outlineButtonPressed);
    } else if (variant === 'danger') {
      baseStyles.push(styles.dangerButton);
      if (pressed && !isDisabled) baseStyles.push(styles.dangerButtonPressed);
    }

    if (isDisabled) {
      baseStyles.push(styles.buttonDisabled);
    }

    return baseStyles;
  };

  const getTextStyle = () => {
    const textStyles = [styles.text];

    if (variant === 'primary') {
      textStyles.push(styles.primaryText);
    } else if (variant === 'outline') {
      textStyles.push(styles.outlineText);
    } else if (variant === 'danger') {
      textStyles.push(styles.dangerText);
    }

    if (isDisabled) {
      textStyles.push(styles.textDisabled);
    }

    return textStyles;
  };

  return (
    <Pressable
      style={({ pressed }) => getButtonStyle(pressed)}
      onPress={onPress}
      disabled={isDisabled}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === 'outline' ? '#4CAF50' : '#FFFFFF'}
          size="small"
        />
      ) : (
        <Text style={getTextStyle()}>{title}</Text>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  primaryButton: {
    backgroundColor: '#4CAF50',
  },
  primaryButtonPressed: {
    backgroundColor: '#45A049',
  },
  outlineButton: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: '#4CAF50',
  },
  outlineButtonPressed: {
    backgroundColor: '#F1F8F4',
  },
  dangerButton: {
    backgroundColor: '#F44336',
  },
  dangerButtonPressed: {
    backgroundColor: '#D32F2F',
  },
  buttonDisabled: {
    backgroundColor: '#E0E0E0',
    borderColor: '#E0E0E0',
    opacity: 0.6,
  },
  text: {
    fontSize: 16,
    fontWeight: '600',
  },
  primaryText: {
    color: '#FFFFFF',
  },
  outlineText: {
    color: '#4CAF50',
  },
  dangerText: {
    color: '#FFFFFF',
  },
  textDisabled: {
    color: '#9E9E9E',
  },
});

export default CustomButton;
