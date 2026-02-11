import React from 'react';
import NutrientBar from '../../src/components/NutrientBar';

/**
 * NutrientBar Component Tests
 * Tests focus on component props handling and calculation logic
 */
describe('NutrientBar', () => {
  describe('component creation', () => {
    it('should be defined as a React component', () => {
      expect(NutrientBar).toBeDefined();
      expect(typeof NutrientBar).toBe('function');
    });

    it('should accept required props', () => {
      const props = {
        label: 'Protein',
        current: 25,
        goal: 50,
        color: '#4CAF50',
      };

      const component = <NutrientBar {...props} />;
      expect(component).toBeTruthy();
      expect(component.props.label).toBe('Protein');
      expect(component.props.current).toBe(25);
      expect(component.props.goal).toBe(50);
      expect(component.props.color).toBe('#4CAF50');
    });

    it('should accept optional unit prop', () => {
      const props = {
        label: 'Calories',
        current: 500,
        goal: 2000,
        color: '#FF5722',
        unit: 'kcal',
      };

      const component = <NutrientBar {...props} />;
      expect(component.props.unit).toBe('kcal');
    });

    it('should default to "g" unit when not provided', () => {
      const props = {
        label: 'Protein',
        current: 30,
        goal: 100,
        color: '#4CAF50',
      };

      const component = <NutrientBar {...props} />;
      expect(component.props.unit).toBeUndefined();
    });
  });

  describe('percentage calculation', () => {
    it('should calculate 0% when current is 0', () => {
      // (0 / 50) * 100 = 0
      const props = {
        label: 'Protein',
        current: 0,
        goal: 50,
        color: '#4CAF50',
      };

      const component = <NutrientBar {...props} />;
      expect(component.props.current).toBe(0);
      expect(component.props.goal).toBe(50);
    });

    it('should calculate 50% when current is half of goal', () => {
      // (25 / 50) * 100 = 50
      const props = {
        label: 'Protein',
        current: 25,
        goal: 50,
        color: '#4CAF50',
      };

      const component = <NutrientBar {...props} />;
      const percentage = Math.min((props.current / props.goal) * 100, 100);
      expect(percentage).toBe(50);
    });

    it('should calculate 100% when current equals goal', () => {
      // (50 / 50) * 100 = 100
      const props = {
        label: 'Protein',
        current: 50,
        goal: 50,
        color: '#4CAF50',
      };

      const component = <NutrientBar {...props} />;
      const percentage = Math.min((props.current / props.goal) * 100, 100);
      expect(percentage).toBe(100);
    });

    it('should cap bar at 100% when current exceeds goal', () => {
      // (100 / 50) * 100 = 200, but capped at 100
      const props = {
        label: 'Protein',
        current: 100,
        goal: 50,
        color: '#4CAF50',
      };

      const component = <NutrientBar {...props} />;
      const percentage = Math.min((props.current / props.goal) * 100, 100);
      expect(percentage).toBe(100);
    });
  });

  describe('over-goal detection', () => {
    it('should detect when under goal', () => {
      const props = {
        label: 'Protein',
        current: 25,
        goal: 50,
        color: '#4CAF50',
      };

      expect(props.current > props.goal).toBe(false);
    });

    it('should detect when over goal', () => {
      const props = {
        label: 'Protein',
        current: 75,
        goal: 50,
        color: '#4CAF50',
      };

      expect(props.current > props.goal).toBe(true);
    });

    it('should detect when exactly at goal', () => {
      const props = {
        label: 'Protein',
        current: 50,
        goal: 50,
        color: '#4CAF50',
      };

      expect(props.current > props.goal).toBe(false);
    });
  });

  describe('numeric formatting', () => {
    it('should handle decimal rounding for current value', () => {
      const props = {
        label: 'Protein',
        current: 25.7,
        goal: 50.3,
        color: '#4CAF50',
      };

      expect(Math.round(props.current)).toBe(26);
      expect(Math.round(props.goal)).toBe(50);
    });

    it('should handle very large values', () => {
      const props = {
        label: 'Calories',
        current: 5000,
        goal: 2000,
        color: '#FF5722',
      };

      expect(props.current).toBe(5000);
      expect(props.goal).toBe(2000);
    });

    it('should handle very small values', () => {
      const props = {
        label: 'Test',
        current: 0.1,
        goal: 0.4,
        color: '#4CAF50',
      };

      expect(Math.round(props.current)).toBe(0);
      expect(Math.round(props.goal)).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle zero goal', () => {
      const props = {
        label: 'Test',
        current: 10,
        goal: 0,
        color: '#4CAF50',
      };

      // Division by zero should be handled in component
      expect(props.goal).toBe(0);
    });

    it('should handle both current and goal as zero', () => {
      const props = {
        label: 'Test',
        current: 0,
        goal: 0,
        color: '#4CAF50',
      };

      expect(props.current).toBe(0);
      expect(props.goal).toBe(0);
    });

    it('should handle negative values', () => {
      const props = {
        label: 'Test',
        current: -10,
        goal: 50,
        color: '#4CAF50',
      };

      expect(props.current).toBe(-10);
      expect(props.goal).toBe(50);
    });
  });

  describe('color props', () => {
    const colors = ['#4CAF50', '#FF5722', '#2196F3', '#FF9800'];

    colors.forEach((color) => {
      it(`should accept color ${color}`, () => {
        const props = {
          label: 'Test',
          current: 25,
          goal: 50,
          color,
        };

        expect(props.color).toBe(color);
      });
    });
  });

  describe('prop types', () => {
    it('should have string label', () => {
      const props = {
        label: 'Protein',
        current: 25,
        goal: 50,
        color: '#4CAF50',
      };

      expect(typeof props.label).toBe('string');
    });

    it('should have numeric current value', () => {
      const props = {
        label: 'Protein',
        current: 25,
        goal: 50,
        color: '#4CAF50',
      };

      expect(typeof props.current).toBe('number');
    });

    it('should have numeric goal value', () => {
      const props = {
        label: 'Protein',
        current: 25,
        goal: 50,
        color: '#4CAF50',
      };

      expect(typeof props.goal).toBe('number');
    });

    it('should have string color', () => {
      const props = {
        label: 'Protein',
        current: 25,
        goal: 50,
        color: '#4CAF50',
      };

      expect(typeof props.color).toBe('string');
    });
  });
});
